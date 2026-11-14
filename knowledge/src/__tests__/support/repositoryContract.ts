import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { KnowledgeRepository, NewChunk, NewDocument } from '../../db/api/repository.js';
import { EMBEDDING_DIMENSIONS } from '../../db/schema.js';
import { hashEmbed } from '../../services/embedding/hashing.js';

export interface ContractTarget {
  repo: KnowledgeRepository;
  /** A fresh owner id for one test, so no test sees another's rows. */
  newOwner: () => string;
}

/**
 * The behaviour every KnowledgeRepository must have, run against both the
 * in-memory double (always) and the Drizzle repository (with a database).
 * The memory double is only trustworthy because it passes the same suite.
 */
export function describeRepositoryContract(
  name: string,
  target: () => ContractTarget,
  options: { skip?: boolean } = {},
): void {
  describe.skipIf(options.skip ?? false)(`KnowledgeRepository contract: ${name}`, () => {
    const newDoc = (ownerId: string, overrides: Partial<NewDocument> = {}): NewDocument => {
      const id = randomUUID().replace(/-/g, '');
      return {
        ownerId,
        filename: `${id}.txt`,
        mimeType: 'text/plain',
        sizeBytes: 1,
        sha256: id.padEnd(64, '0'),
        storagePath: `${ownerId}/${id}.txt`,
        kind: 'supporting',
        ...overrides,
      };
    };
    const chunk = (text: string, ordinal = 0): NewChunk => ({
      ordinal,
      heading: null,
      content: text,
      tokenCount: 1,
      embedding: hashEmbed(text, EMBEDDING_DIMENSIONS),
    });
    /** Creates a document and ingests it to ready. */
    const ready = async (ownerId: string, text: string, overrides: Partial<NewDocument> = {}) => {
      const { repo } = target();
      const { document } = await repo.createDocument(newDoc(ownerId, overrides));
      await repo.completeIngestion(document.id, text, [chunk(text)]);
      return document;
    };

    it('creates a pending document and deduplicates identical bytes', async () => {
      const { repo, newOwner } = target();
      const owner = newOwner();
      const doc = newDoc(owner);
      const first = await repo.createDocument(doc);
      expect(first.created).toBe(true);
      expect(first.document).toMatchObject({ status: 'pending', isPrimaryResume: false });

      const again = await repo.createDocument({ ...doc, filename: 'other-name.txt' });
      expect(again).toEqual({ document: first.document, created: false });
      expect(await repo.findBySha256(owner, doc.sha256)).toMatchObject({ id: first.document.id });
      expect(await repo.listDocuments(owner)).toHaveLength(1);
    });

    it('scopes reads to the owner', async () => {
      const { repo, newOwner } = target();
      const owner = newOwner();
      const doc = await ready(owner, 'kafka billing');
      expect(await repo.getDocument(owner, doc.id)).toMatchObject({ id: doc.id });
      expect(await repo.getDocument(newOwner(), doc.id)).toBeNull();
      expect(await repo.deleteDocument(newOwner(), doc.id)).toBeNull();
    });

    it('bumps the version on ingest, on leaving ready, and on deleting a ready document', async () => {
      const { repo, newOwner } = target();
      const owner = newOwner();
      expect(await repo.getVersion(owner)).toBe(0);
      const doc = await ready(owner, 'kafka billing');
      expect(await repo.getVersion(owner)).toBe(1);

      await repo.markProcessing(doc.id); // ready -> processing hides its chunks
      expect(await repo.getVersion(owner)).toBe(2);
      await repo.failIngestion(doc.id, 'failed'); // already hidden
      expect(await repo.getVersion(owner)).toBe(2);
      await repo.resetToPending(doc.id);
      expect(await repo.getVersion(owner)).toBe(2);

      const other = await ready(owner, 'education');
      expect(await repo.getVersion(owner)).toBe(3);
      expect(await repo.deleteDocument(owner, other.id)).toMatchObject({ id: other.id });
      expect(await repo.getVersion(owner)).toBe(4);
      // A document that is not ready leaves the version alone when deleted.
      expect(await repo.deleteDocument(owner, doc.id)).toMatchObject({ id: doc.id });
      expect(await repo.getVersion(owner)).toBe(4);
    });

    it('searches only ready chunks of the owner, closest first', async () => {
      const { repo, newOwner } = target();
      const owner = newOwner();
      const kafka = await ready(owner, 'kafka billing migration');
      await ready(owner, 'university education degree');
      const hidden = await ready(owner, 'kafka billing migration platform');
      await repo.markProcessing(hidden.id);
      await ready(newOwner(), 'kafka billing migration');

      const found = await repo.search(owner, hashEmbed('kafka billing', EMBEDDING_DIMENSIONS), 5);
      expect(found.map((c) => c.documentId)).not.toContain(hidden.id);
      expect(found).toHaveLength(2);
      expect(found[0]?.documentId).toBe(kafka.id);
      expect(found[0]?.similarity).toBeGreaterThan(found[1]?.similarity ?? 1);
    });

    it('replaces a document’s chunks on re-ingest', async () => {
      const { repo, newOwner } = target();
      const owner = newOwner();
      const doc = await ready(owner, 'first version');
      await repo.completeIngestion(doc.id, 'second', [chunk('second version'), chunk('more', 1)]);
      expect(await repo.getDocument(owner, doc.id)).toMatchObject({ chunkCount: 2 });
      const found = await repo.search(owner, hashEmbed('version', EMBEDDING_DIMENSIONS), 10);
      expect(found.map((c) => c.content).sort()).toEqual(['more', 'second version']);
    });

    it('makes the newest ready resume primary, only once it is ingested', async () => {
      const { repo, newOwner } = target();
      const owner = newOwner();
      const old = await ready(owner, 'old resume', { kind: 'resume' });
      expect(await repo.getDocument(owner, old.id)).toMatchObject({ isPrimaryResume: true });

      // A newer resume does not displace the old one until its ingest succeeds.
      const { document: newer } = await repo.createDocument(newDoc(owner, { kind: 'resume' }));
      await repo.markProcessing(newer.id);
      await repo.failIngestion(newer.id, 'Could not parse the PDF.');
      expect(await repo.getDocument(owner, old.id)).toMatchObject({ isPrimaryResume: true });

      await repo.completeIngestion(newer.id, 'new resume', [chunk('new resume')]);
      expect(await repo.getDocument(owner, newer.id)).toMatchObject({ isPrimaryResume: true });
      expect(await repo.getDocument(owner, old.id)).toMatchObject({ isPrimaryResume: false });

      // Re-ingesting the older resume does not take the primary back.
      await repo.completeIngestion(old.id, 'old resume', [chunk('old resume')]);
      expect(await repo.getDocument(owner, newer.id)).toMatchObject({ isPrimaryResume: true });

      // Deleting the primary promotes the next newest ready resume.
      await repo.deleteDocument(owner, newer.id);
      expect(await repo.getDocument(owner, old.id)).toMatchObject({ isPrimaryResume: true });
    });

    it('lets the owner pick the primary among ready resumes', async () => {
      const { repo, newOwner } = target();
      const owner = newOwner();
      const old = await ready(owner, 'old resume', { kind: 'resume' });
      const newer = await ready(owner, 'new resume', { kind: 'resume' });
      expect(await repo.getDocument(owner, newer.id)).toMatchObject({ isPrimaryResume: true });

      expect(await repo.setPrimaryResume(owner, old.id)).toMatchObject({
        id: old.id,
        isPrimaryResume: true,
      });
      expect(await repo.getDocument(owner, newer.id)).toMatchObject({ isPrimaryResume: false });
      // Idempotent.
      expect(await repo.setPrimaryResume(owner, old.id)).toMatchObject({ isPrimaryResume: true });

      // Only a ready resume qualifies, and only the owner's own.
      const supporting = await ready(owner, 'notes');
      await expect(repo.setPrimaryResume(owner, supporting.id)).rejects.toThrow(/ready resume/);
      const { document: pending } = await repo.createDocument(newDoc(owner, { kind: 'resume' }));
      await expect(repo.setPrimaryResume(owner, pending.id)).rejects.toThrow(/ready resume/);
      expect(await repo.setPrimaryResume(newOwner(), old.id)).toBeNull();
      expect(await repo.getDocument(owner, old.id)).toMatchObject({ isPrimaryResume: true });

      // The next completed resume re-applies the newest-ready rule.
      await repo.completeIngestion(pending.id, 'newest resume', [chunk('newest resume')]);
      expect(await repo.getDocument(owner, pending.id)).toMatchObject({ isPrimaryResume: true });
      expect(await repo.getDocument(owner, old.id)).toMatchObject({ isPrimaryResume: false });
    });

    it('returns the extracted text to the owner only', async () => {
      const { repo, newOwner } = target();
      const owner = newOwner();
      const doc = await ready(owner, 'kafka billing');
      expect(await repo.getExtractedText(owner, doc.id)).toEqual({ text: 'kafka billing' });
      expect(await repo.getExtractedText(newOwner(), doc.id)).toBeNull();

      const { document: pending } = await repo.createDocument(newDoc(owner));
      expect(await repo.getExtractedText(owner, pending.id)).toEqual({ text: null });
    });

    it('reports storage keys in use and unfinished documents', async () => {
      const { repo, newOwner } = target();
      const owner = newOwner();
      const doc = newDoc(owner);
      const { document } = await repo.createDocument(doc);
      expect(await repo.isStoragePathInUse(doc.storagePath)).toBe(true);
      expect((await repo.listUnfinished()).map((d) => d.id)).toContain(document.id);

      await repo.deleteDocument(owner, document.id);
      expect(await repo.isStoragePathInUse(doc.storagePath)).toBe(false);
      expect((await repo.listUnfinished()).map((d) => d.id)).not.toContain(document.id);
    });
  });
}
