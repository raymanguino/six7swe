import type { DocumentDto } from '@six7swe/knowledge-types';
import { createKnowledgeDocumentClient } from '../../services/knowledge/documentsClient';
import type { FetchLike } from '../../services/knowledge/ownerProxy';

const DOC_ID = '00000000-0000-4000-8000-000000000001';
const config = { baseUrl: 'http://127.0.0.1:3100/', ownerKey: 'o'.repeat(32), timeoutMs: 1000 };

const document: DocumentDto = {
  id: DOC_ID,
  filename: 'resume.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 100,
  kind: 'resume',
  isPrimaryResume: true,
  status: 'ready',
  error: null,
  chunkCount: 3,
  createdAt: '2026-11-13T00:00:00.000Z',
  updatedAt: '2026-11-13T00:00:00.000Z',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('createKnowledgeDocumentClient', () => {
  it('lists documents and reads text with the owner key', async () => {
    const fetchFn = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>(async (url) =>
      url.endsWith('/text')
        ? json({ documentId: DOC_ID, text: 'Terraform' })
        : json({ documents: [document] }),
    );
    const client = createKnowledgeDocumentClient(config, fetchFn);

    await expect(client.listDocuments()).resolves.toEqual([document]);
    await expect(client.getDocumentText(DOC_ID)).resolves.toBe('Terraform');

    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:3100/documents',
      `http://127.0.0.1:3100/documents/${DOC_ID}/text`,
    ]);
    for (const [, init] of fetchFn.mock.calls) {
      expect(init.method).toBe('GET');
      expect(init.headers).toEqual({ 'x-knowledge-key': config.ownerKey });
    }
  });

  it('passes through a null text (not extracted yet)', async () => {
    const client = createKnowledgeDocumentClient(config, async () =>
      json({ documentId: DOC_ID, text: null }),
    );
    await expect(client.getDocumentText(DOC_ID)).resolves.toBeNull();
  });

  it('rejects an error status, a broken contract and an unreachable service', async () => {
    await expect(
      createKnowledgeDocumentClient(config, async () =>
        json({ error: 'Unauthorized' }, 401),
      ).listDocuments(),
    ).rejects.toThrow('Knowledge service /documents answered 401');

    await expect(
      createKnowledgeDocumentClient(config, async () => json({ docs: [] })).listDocuments(),
    ).rejects.toThrow('did not match the contract');

    await expect(
      createKnowledgeDocumentClient(config, async () => {
        throw new TypeError('fetch failed');
      }).getDocumentText(DOC_ID),
    ).rejects.toThrow('unreachable: fetch failed');
  });
});
