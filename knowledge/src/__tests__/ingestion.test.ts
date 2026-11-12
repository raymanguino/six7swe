import { describe, expect, it, vi } from 'vitest';
import type { DocumentRecord } from '../db/api/repository.js';
import {
  deleteDocument,
  isUniqueViolation,
  uploadDocument,
  cleanFilename,
} from '../services/documents.js';
import { createHashingEmbedder } from '../services/embedding/hashing.js';
import type { Embedder } from '../services/embedding/index.js';
import { ingestDocument } from '../services/ingestion/pipeline.js';
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
  const queue = new SerialQueue<DocumentRecord>((doc) =>
    ingestDocument({ repo, files, embedder, log: silentLogger }, doc),
  );
  const deps = { repo, files, queue, log: silentLogger };
  const upload = (
    filename: string,
    bytes: Uint8Array,
    kind: 'resume' | 'supporting' = 'supporting',
  ) => uploadDocument(deps, { ownerId: OWNER, filename, bytes, kind });
  return { repo, files, queue, deps, embedder, upload };
}

describe('SerialQueue', () => {
  it('runs items one at a time, skips duplicates, and survives a failing item', async () => {
    const order: string[] = [];
    let running = 0;
    const errors: string[] = [];
    const queue = new SerialQueue<{ id: string }>(
      async ({ id }) => {
        running++;
        expect(running).toBe(1);
        await new Promise((r) => setTimeout(r, 1));
        order.push(id);
        running--;
        if (id === 'b') throw new Error('boom');
      },
      (item) => errors.push(item.id),
    );
    queue.enqueue({ id: 'a' });
    queue.enqueue({ id: 'b' });
    queue.enqueue({ id: 'b' });
    queue.enqueue({ id: 'c' });
    await queue.idle();
    expect(order).toEqual(['a', 'b', 'c']);
    expect(errors).toEqual(['b']);
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

  it('makes a resume the primary resume and demotes the previous one', async () => {
    const { repo, upload } = setup();
    const first = await upload('old.md', utf8('# Old resume'), 'resume');
    const second = await upload('new.md', utf8('# New resume'), 'resume');
    expect((await repo.getDocument(OWNER, first.document.id))?.isPrimaryResume).toBe(false);
    expect((await repo.getDocument(OWNER, second.document.id))?.isPrimaryResume).toBe(true);
  });

  it('treats identical bytes as a no-op', async () => {
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

  it('keeps the previous chunks when a re-ingest fails', async () => {
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

    fail = true;
    await ingestDocument({ repo, files, embedder: flaky, log: silentLogger }, document);

    const after = await repo.getDocument(OWNER, document.id);
    expect(after?.status).toBe('failed');
    expect(after?.error).toBe('provider down');
    expect(repo.chunks).toEqual(before);
    expect(await repo.getVersion(OWNER)).toBe(1);
  });

  it('rejects unsupported files before storing anything', async () => {
    const { files, upload, repo } = setup();
    await expect(upload('resume.docx', utf8('x'))).rejects.toThrow(/Unsupported file type/);
    expect(files.files.size).toBe(0);
    expect(await repo.listDocuments(OWNER)).toHaveLength(0);
  });

  it('returns the winner when an identical upload races past the dedupe check', async () => {
    const { repo, deps } = setup();
    const winner = await uploadDocument(deps, {
      ownerId: OWNER,
      filename: 'a.md',
      bytes: utf8('# A'),
      kind: 'supporting',
    });
    // Simulate the race: the lookup misses, then the insert hits the unique index.
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
  });
});

describe('deleteDocument', () => {
  it('removes the document, its chunks and its file, and bumps the version', async () => {
    const { repo, files, queue, deps, upload } = setup();
    const { document } = await upload('a.md', utf8(RESUME_MD));
    await queue.idle();
    expect(await repo.getVersion(OWNER)).toBe(1);

    const result = await deleteDocument(deps, OWNER, document.id);
    expect(result).toEqual({ deleted: true, version: 2 });
    expect(repo.chunks).toHaveLength(0);
    expect(files.files.size).toBe(0);
  });

  it('does not bump the version for a document that never became ready', async () => {
    const { repo, deps, upload } = setup();
    const { document } = await upload('scan.pdf', makePdf([]));
    // Not ingested: still pending.
    const result = await deleteDocument(deps, OWNER, document.id);
    expect(result.version).toBe(0);
    expect(await repo.getVersion(OWNER)).toBe(0);
  });

  it('does not delete another owner’s document', async () => {
    const { deps, upload } = setup();
    const { document } = await upload('a.md', utf8('# A'));
    expect(await deleteDocument(deps, 'someone-else', document.id)).toEqual({
      deleted: false,
      version: null,
    });
  });
});

describe('helpers', () => {
  it('cleanFilename strips paths and control characters', () => {
    expect(cleanFilename('C:\\Users\\me\\resume.pdf')).toBe('resume.pdf');
    expect(cleanFilename('../../etc/passwd')).toBe('passwd');
    expect(cleanFilename('a\u0000b.md')).toBe('ab.md');
    expect(cleanFilename('')).toBe('upload');
  });

  it('isUniqueViolation finds 23505 directly or in a cause chain', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
    expect(isUniqueViolation(new Error('wrapped', { cause: { code: '23505' } }))).toBe(true);
    expect(isUniqueViolation(new Error('other'))).toBe(false);
  });
});
