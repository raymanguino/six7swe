import { describe, expect, it, vi } from 'vitest';
import { isUniqueViolation, toConflictError } from '../db/api/drizzleRepository.js';
import { ConflictError } from '../db/api/repository.js';
import { cleanFilename, deleteDocument, sha256Hex, uploadDocument } from '../services/documents.js';
import { EmbeddingError } from '../services/embedding/errors.js';
import { createHashingEmbedder } from '../services/embedding/hashing.js';
import type { Embedder } from '../services/embedding/index.js';
import {
  createIngestionQueue,
  ingestDocument,
  publicIngestionError,
} from '../services/ingestion/pipeline.js';
import { SerialQueue } from '../services/ingestion/queue.js';
import { retrieve } from '../services/retrieval.js';
import { createMemoryRepository } from './support/memoryRepository.js';
import {
  createMemoryFileStore,
  makePdf,
  PROJECT_NOTES_TXT,
  RESUME_MD,
  silentLogger,
  utf8,
} from './support/fixtures.js';

const OWNER = 'owner-1';

function setup(embedder: Embedder = createHashingEmbedder(256)) {
  const repo = createMemoryRepository();
  const files = createMemoryFileStore();
  const queue = createIngestionQueue({ repo, files, embedder }, silentLogger);
  const deps = { repo, files, queue, log: silentLogger };
  const upload = (
    filename: string,
    bytes: Uint8Array,
    kind: 'resume' | 'supporting' = 'supporting',
  ) => uploadDocument(deps, { ownerId: OWNER, filename, bytes, kind });
  return { repo, files, queue, deps, embedder, upload };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('SerialQueue', () => {
  it('runs items one at a time, skips duplicates, and survives a failing item', async () => {
    const order: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const errors: string[] = [];
    const queue = new SerialQueue<{ id: string }>(
      async ({ id }) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        try {
          await new Promise((r) => setTimeout(r, 1));
          order.push(id);
          if (id === 'b') throw new Error('boom');
        } finally {
          running--;
        }
      },
      (item) => errors.push(item.id),
    );
    queue.enqueue({ id: 'a' });
    queue.enqueue({ id: 'b' });
    queue.enqueue({ id: 'b' });
    queue.enqueue({ id: 'c' });
    await queue.idle();
    expect(maxRunning).toBe(1);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(errors).toEqual(['b']);
  });

  it('cancel() removes a waiting item but not the running one', async () => {
    const seen: string[] = [];
    const queue = new SerialQueue<{ id: string }>(async ({ id }) => {
      seen.push(id);
      await new Promise((r) => setTimeout(r, 1));
    });
    queue.enqueue({ id: 'a' });
    queue.enqueue({ id: 'b' });
    queue.enqueue({ id: 'c' });
    await tick();
    expect(queue.cancel('a')).toBe(false); // running
    expect(queue.cancel('b')).toBe(true);
    expect(queue.cancel('b')).toBe(false);
    expect(queue.has('b')).toBe(false);
    await queue.idle();
    expect(seen).toEqual(['a', 'c']);
  });

  it('runs an item enqueued from onError', async () => {
    const seen: string[] = [];
    const queue: SerialQueue<{ id: string }> = new SerialQueue<{ id: string }>(
      async ({ id }) => {
        seen.push(id);
        if (id === 'a') throw new Error('retry me');
      },
      () => queue.enqueue({ id: 'retry' }),
    );
    queue.enqueue({ id: 'a' });
    await queue.idle();
    expect(seen).toEqual(['a', 'retry']);
  });

  it('runs an item enqueued right after a drain finishes', async () => {
    const seen: string[] = [];
    const queue = new SerialQueue<{ id: string }>(async ({ id }) => {
      seen.push(id);
    });
    queue.enqueue({ id: 'a' });
    // Enqueue in the microtask right after the first drain resolves.
    const first = queue.idle().then(() => queue.enqueue({ id: 'b' }));
    await first;
    await queue.idle();
    expect(seen).toEqual(['a', 'b']);
  });

  it('keeps running after a worker that throws synchronously', async () => {
    const seen: string[] = [];
    const queue = new SerialQueue<{ id: string }>((item) => {
      seen.push(item.id);
      if (item.id === 'sync') throw new Error('thrown before returning a promise');
      return Promise.resolve();
    });
    queue.enqueue({ id: 'sync' });
    await queue.idle();
    queue.enqueue({ id: 'later' });
    await queue.idle();
    expect(seen).toEqual(['sync', 'later']);
  });

  it('reports waiting and running items with has()', async () => {
    let release: () => void = () => {};
    const queue = new SerialQueue<{ id: string }>(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    queue.enqueue({ id: 'a' });
    queue.enqueue({ id: 'b' });
    await tick();
    expect(queue.has('a')).toBe(true); // running
    expect(queue.has('b')).toBe(true); // waiting
    expect(queue.has('c')).toBe(false);
    release();
    await tick();
    expect(queue.has('a')).toBe(false);
    release();
    await queue.idle();
  });

  it('stop() drops waiting items, waits for the running one, and refuses new work', async () => {
    const seen: string[] = [];
    let release: () => void = () => {};
    const queue = new SerialQueue<{ id: string }>(
      ({ id }) =>
        new Promise<void>((resolve) => {
          seen.push(id);
          release = resolve;
        }),
    );
    queue.enqueue({ id: 'a' });
    queue.enqueue({ id: 'b' });
    await tick();

    let stopped = false;
    const stopping = queue.stop().then((dropped) => {
      stopped = true;
      return dropped;
    });
    await tick();
    expect(stopped).toBe(false); // still waiting for 'a'
    release();
    expect(await stopping).toBe(1);
    expect(seen).toEqual(['a']);
    expect(queue.enqueue({ id: 'c' })).toBe(false);
  });
});

describe('upload → ingest → retrieve', () => {
  it('ingests md, txt and pdf to ready and bumps the version once per document', async () => {
    const { repo, queue, upload, embedder } = setup();

    await upload('resume.md', utf8(RESUME_MD), 'resume');
    await upload('project.txt', utf8(PROJECT_NOTES_TXT));
    await upload('extra.pdf', makePdf(['Certified Kubernetes Administrator, 2023']));
    await queue.idle();

    const docs = await repo.listDocuments(OWNER);
    expect(docs.map((d) => d.status)).toEqual(['ready', 'ready', 'ready']);
    expect(docs.every((d) => d.chunkCount > 0)).toBe(true);
    expect(await repo.getVersion(OWNER)).toBe(3);

    const result = await retrieve({ repo, embedder }, OWNER, 'Kubernetes certification', 1);
    expect(result.version).toBe(3);
    expect(result.chunks[0]?.filename).toBe('extra.pdf');
    expect(result.chunks[0]?.content).toContain('Kubernetes');
  });

  it('makes a resume primary once it is ingested, demoting the previous one', async () => {
    const { repo, queue, upload } = setup();
    const first = await upload('old.md', utf8('# Old resume'), 'resume');
    const second = await upload('new.md', utf8('# New resume'), 'resume');
    expect(second.document.isPrimaryResume).toBe(false); // not yet ingested
    await queue.idle();
    expect((await repo.getDocument(OWNER, first.document.id))?.isPrimaryResume).toBe(false);
    expect((await repo.getDocument(OWNER, second.document.id))?.isPrimaryResume).toBe(true);
  });

  it('never lets a resume whose ingest fails displace the primary', async () => {
    const { repo, queue, upload } = setup();
    const good = await upload('good.md', utf8('# Good resume'), 'resume');
    await queue.idle();
    const broken = await upload('scan.pdf', makePdf([]), 'resume');
    await queue.idle();
    expect((await repo.getDocument(OWNER, broken.document.id))?.status).toBe('failed');
    expect((await repo.getDocument(OWNER, good.document.id))?.isPrimaryResume).toBe(true);
  });

  it('does not demote the primary resume when an older resume is uploaded again', async () => {
    const { repo, queue, upload } = setup();
    const old = await upload('old.md', utf8('# Old resume'), 'resume');
    const current = await upload('new.md', utf8('# New resume'), 'resume');
    await queue.idle();
    const again = await upload('old.md', utf8('# Old resume'), 'resume');
    expect(again.deduplicated).toBe(true);
    expect(again.document.id).toBe(old.document.id);
    expect((await repo.getDocument(OWNER, current.document.id))?.isPrimaryResume).toBe(true);
  });

  it('treats identical bytes of a ready document as a no-op', async () => {
    const { repo, files, queue, upload } = setup();
    const first = await upload('a.md', utf8(RESUME_MD));
    await queue.idle();
    const again = await upload('renamed.md', utf8(RESUME_MD));
    await queue.idle();

    expect(again.deduplicated).toBe(true);
    expect(again.document.id).toBe(first.document.id);
    expect(await repo.listDocuments(OWNER)).toHaveLength(1);
    expect(files.files.size).toBe(1);
    expect(await repo.getVersion(OWNER)).toBe(1);
  });

  it('marks a PDF with no text as failed, and retries it when uploaded again', async () => {
    const { repo, queue, upload, files } = setup();
    const { document } = await upload('scan.pdf', makePdf([]));
    await queue.idle();

    const failed = await repo.getDocument(OWNER, document.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toMatch(/No extractable text/);
    expect(await repo.getVersion(OWNER)).toBe(0);

    // Same bytes again: queued for another attempt rather than ignored.
    const retried = await upload('scan.pdf', makePdf([]));
    expect(retried.deduplicated).toBe(true);
    expect(retried.document.status).toBe('pending');
    await queue.idle();
    expect((await repo.getDocument(OWNER, document.id))?.status).toBe('failed');
    expect(files.files.size).toBe(1);
  });

  it('stores the bytes again when retrying, so a lost file is recovered', async () => {
    const { repo, queue, upload, files } = setup();
    const { document } = await upload('a.md', utf8(RESUME_MD));
    files.files.clear(); // the stored copy is lost before ingestion runs
    await queue.idle();
    const failed = await repo.getDocument(OWNER, document.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toMatch(/Could not load the stored file/);

    await upload('a.md', utf8(RESUME_MD));
    await queue.idle();
    expect((await repo.getDocument(OWNER, document.id))?.status).toBe('ready');
  });

  it('retries a document stranded in pending or processing that nothing is working on', async () => {
    const { repo, queue, upload } = setup();
    // Simulate a crash: the row exists and is `processing`, but the queue is empty.
    const { document } = await repo.createDocument({
      ownerId: OWNER,
      filename: 'a.md',
      mimeType: 'text/markdown',
      sizeBytes: utf8(RESUME_MD).byteLength,
      sha256: sha256Hex(utf8(RESUME_MD)),
      storagePath: `${OWNER}/stranded.md`,
      kind: 'supporting',
    });
    await repo.markProcessing(document.id);
    const reset = vi.spyOn(repo, 'resetToPending');

    const again = await upload('a.md', utf8(RESUME_MD));
    expect(again.deduplicated).toBe(true);
    // Enqueued as is; the worker's markProcessing moves it on, no reset needed.
    expect(again.document.status).toBe('processing');
    expect(reset).not.toHaveBeenCalled();
    await queue.idle();
    expect((await repo.getDocument(OWNER, document.id))?.status).toBe('ready');
  });

  it('does not re-enqueue a document the queue is already working on', async () => {
    const { queue, upload } = setup();
    const first = await upload('a.md', utf8(RESUME_MD));
    expect(queue.has(first.document.id)).toBe(true);
    const enqueue = vi.spyOn(queue, 'enqueue');
    const again = await upload('a.md', utf8(RESUME_MD));
    expect(again.deduplicated).toBe(true);
    expect(again.document.status).not.toBe('failed');
    expect(enqueue).not.toHaveBeenCalled();
    await queue.idle();
  });

  it('does not reset or re-enqueue a retry that another upload queued during the store', async () => {
    const { repo, files, queue, upload } = setup();
    const { document } = await upload('scan.pdf', makePdf([]));
    await queue.idle();
    expect((await repo.getDocument(OWNER, document.id))?.status).toBe('failed');

    // While this retry stores the bytes, a concurrent retry queues the document.
    const put = files.put.bind(files);
    vi.spyOn(files, 'put').mockImplementationOnce(async (key, bytes, type) => {
      queue.enqueue({ ...document, status: 'pending' });
      await put(key, bytes, type);
    });
    const reset = vi.spyOn(repo, 'resetToPending');
    const enqueue = vi.spyOn(queue, 'enqueue');

    const retried = await upload('scan.pdf', makePdf([]));
    expect(retried.deduplicated).toBe(true);
    expect(reset).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1); // only the concurrent one
    await queue.idle();
  });

  it('hides the previous chunks and bumps the version when a re-ingest fails', async () => {
    const good = createHashingEmbedder(256);
    let fail = false;
    const flaky: Embedder = {
      ...good,
      embed: (texts) => (fail ? Promise.reject(new Error('provider down')) : good.embed(texts)),
    };
    const { repo, files, queue, upload } = setup(flaky);
    const { document } = await upload('a.md', utf8(RESUME_MD));
    await queue.idle();
    const before = [...repo.chunks];
    expect(before.length).toBeGreaterThan(0);
    expect(await repo.getVersion(OWNER)).toBe(1);

    fail = true;
    await ingestDocument({ repo, files, embedder: flaky, log: silentLogger }, document);

    const after = await repo.getDocument(OWNER, document.id);
    expect(after?.status).toBe('failed');
    // The raw provider message stays in the logs; the owner sees a generic reason.
    expect(after?.error).not.toContain('provider down');
    // The chunks are kept (a successful retry replaces them) but no longer served,
    // and the version moved when they left the corpus.
    expect(repo.chunks).toEqual(before);
    expect(await repo.getVersion(OWNER)).toBe(2);
    const result = await retrieve({ repo, embedder: good }, OWNER, 'Kafka', 5);
    expect(result).toEqual({ version: 2, chunks: [] });
  });

  it('logs and survives a failure that cannot be recorded', async () => {
    const { repo, files, embedder } = setup();
    const { document } = await repo.createDocument({
      ownerId: OWNER,
      filename: 'gone.md',
      mimeType: 'text/markdown',
      sizeBytes: 1,
      sha256: 'a'.repeat(64),
      storagePath: `${OWNER}/gone.md`,
      kind: 'supporting',
    });
    vi.spyOn(repo, 'failIngestion').mockRejectedValue(new Error('database down'));
    const error = vi.fn();
    const log = { ...silentLogger, error, warn: vi.fn() };

    await expect(ingestDocument({ repo, files, embedder, log }, document)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: document.id }),
      expect.stringMatching(/Could not record/),
    );
  });

  it('rejects unsupported files before storing anything', async () => {
    const { files, upload, repo } = setup();
    await expect(upload('resume.docx', utf8('x'))).rejects.toThrow(/Unsupported file type/);
    expect(files.files.size).toBe(0);
    expect(await repo.listDocuments(OWNER)).toHaveLength(0);
  });

  it('returns the winner when an identical upload races past the dedupe check', async () => {
    const { repo, deps, queue } = setup();
    const winner = await uploadDocument(deps, {
      ownerId: OWNER,
      filename: 'a.md',
      bytes: utf8('# A'),
      kind: 'supporting',
    });
    // Simulate the race: the lookup misses, then the insert finds the existing row.
    vi.spyOn(repo, 'findBySha256').mockResolvedValueOnce(null);
    const loser = await uploadDocument(deps, {
      ownerId: OWNER,
      filename: 'a.md',
      bytes: utf8('# A'),
      kind: 'supporting',
    });
    expect(loser.deduplicated).toBe(true);
    expect(loser.document.id).toBe(winner.document.id);
    expect(await repo.listDocuments(OWNER)).toHaveLength(1);
    await queue.idle();
  });
});

describe('deleteDocument', () => {
  it('removes the document, its chunks and its file, and bumps the version', async () => {
    const { repo, files, queue, deps, upload } = setup();
    const { document } = await upload('a.md', utf8(RESUME_MD));
    await queue.idle();
    expect(await repo.getVersion(OWNER)).toBe(1);

    expect(await deleteDocument(deps, OWNER, document.id)).toBe(true);
    expect(await repo.getVersion(OWNER)).toBe(2);
    expect(repo.chunks).toHaveLength(0);
    expect(files.files.size).toBe(0);
  });

  it('does not bump the version for a document that never became ready', async () => {
    const { repo, deps, upload } = setup();
    const { document } = await upload('scan.pdf', makePdf([]));
    // Not ingested: still pending.
    expect(await deleteDocument(deps, OWNER, document.id)).toBe(true);
    expect(await repo.getVersion(OWNER)).toBe(0);
  });

  it('keeps the file when another row references the same storage key', async () => {
    const { repo, files, queue, deps, upload } = setup();
    const { document } = await upload('a.md', utf8(RESUME_MD));
    await queue.idle();
    // The same bytes re-uploaded between the row delete and the file delete.
    vi.spyOn(repo, 'isStoragePathInUse').mockResolvedValueOnce(true);
    expect(await deleteDocument(deps, OWNER, document.id)).toBe(true);
    expect(files.files.size).toBe(1);
  });

  it('does not delete another owner’s document', async () => {
    const { deps, upload } = setup();
    const { document } = await upload('a.md', utf8('# A'));
    expect(await deleteDocument(deps, 'someone-else', document.id)).toBe(false);
  });

  it('cancels a document still waiting in the queue, so the worker never touches it', async () => {
    const embedder = createHashingEmbedder(256);
    const embed = vi.spyOn(embedder, 'embed');
    const { repo, queue, deps, upload } = setup(embedder);
    const markProcessing = vi.spyOn(repo, 'markProcessing');
    const first = await upload('a.md', utf8('# First'));
    const waiting = await upload('b.md', utf8('# Waiting'));
    expect(queue.has(waiting.document.id)).toBe(true);

    expect(await deleteDocument(deps, OWNER, waiting.document.id)).toBe(true);
    expect(queue.has(waiting.document.id)).toBe(false);
    await queue.idle();
    expect(markProcessing.mock.calls.map(([id]) => id)).toEqual([first.document.id]);
    expect(embed).toHaveBeenCalledTimes(1);
  });
});

describe('helpers', () => {
  it('cleanFilename strips paths and control characters', () => {
    expect(cleanFilename('C:\\Users\\me\\resume.pdf')).toBe('resume.pdf');
    expect(cleanFilename('../../etc/passwd')).toBe('passwd');
    expect(cleanFilename('a\u0000b.md')).toBe('ab.md');
    expect(cleanFilename('')).toBe('upload');
  });

  it('cleanFilename truncates by code points and keeps the extension', () => {
    const long = `${'é'.repeat(300)}.PDF`;
    const cleaned = cleanFilename(long);
    expect(Array.from(cleaned)).toHaveLength(255);
    expect(cleaned.endsWith('.PDF')).toBe(true);

    // Astral characters are two UTF-16 units; truncation never splits one.
    const emoji = cleanFilename(`${'😀'.repeat(300)}.md`);
    expect(Array.from(emoji)).toHaveLength(255);
    expect(emoji.endsWith('😀.md')).toBe(true);
  });

  it('isUniqueViolation finds 23505 directly or in a cause chain', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
    expect(isUniqueViolation(new Error('wrapped', { cause: { code: '23505' } }))).toBe(true);
    expect(isUniqueViolation(new Error('other'))).toBe(false);
  });

  it('toConflictError maps any unique violation to a 409 and leaves other errors alone', () => {
    // e.g. the one-primary-resume index, not the (owner, sha256) dedupe.
    const primaryIndex = new Error('Failed query', {
      cause: Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint_name: 'documents_owner_primary_resume_uq',
      }),
    });
    const mapped = toConflictError(primaryIndex);
    expect(mapped).toBeInstanceOf(ConflictError);
    expect(mapped).toMatchObject({ statusCode: 409, cause: primaryIndex });

    const other = new Error('connection reset');
    expect(toConflictError(other)).toBe(other);
  });

  it('publicIngestionError hides provider and internal details', () => {
    expect(
      publicIngestionError(
        new EmbeddingError('failed (503): secret detail', true, { status: 503 }),
      ),
    ).toBe('Embedding provider error (status 503)');
    expect(publicIngestionError(new Error('ECONNREFUSED 10.0.0.1:5432'))).not.toMatch(/10\.0/);
  });
});
