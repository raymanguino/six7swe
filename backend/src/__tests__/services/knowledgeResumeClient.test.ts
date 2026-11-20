import { SERVICE_KEY_HEADER } from '@six7swe/knowledge-types';
import { createKnowledgeResumeClient } from '../../services/knowledge/resumeClient';
import type { FetchLike } from '../../services/knowledge/transport';

const SERVICE_URL = 'http://knowledge.internal:3100';
const SERVICE_KEY = 's'.repeat(40);

describe('createKnowledgeResumeClient', () => {
  function client(respond: (url: string) => Response | Promise<Response>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return respond(url);
    };
    return {
      calls,
      client: createKnowledgeResumeClient(
        { baseUrl: SERVICE_URL, key: SERVICE_KEY, timeoutMs: 1000 },
        fetch,
      ),
    };
  }

  it('returns the resume PDF bytes with the service key, or null when there is none', async () => {
    const pdf = Buffer.from('%PDF-1.4 test');
    const ok = client(
      () => new Response(new Uint8Array(pdf), { headers: { 'content-type': 'application/pdf' } }),
    );
    expect(await ok.client.getResumePdf()).toEqual(pdf);
    expect(ok.calls[0]?.url).toBe(`${SERVICE_URL}/resume.pdf`);
    expect((ok.calls[0]?.init.headers as Record<string, string>)[SERVICE_KEY_HEADER]).toBe(
      SERVICE_KEY,
    );

    expect(
      await client(() =>
        Response.json({ error: 'No PDF resume' }, { status: 404 }),
      ).client.getResumePdf(),
    ).toBeNull();
  });

  it('rejects a body that is not a PDF, an error status, and an outage', async () => {
    await expect(
      client(() => Response.json({ not: 'a pdf' })).client.getResumePdf(),
    ).rejects.toThrow('did not send a PDF');
    await expect(
      client(() => new Response('', { status: 500 })).client.getResumePdf(),
    ).rejects.toMatchObject({ status: 500 });
    await expect(
      client(() => Promise.reject(new TypeError('fetch failed'))).client.getResumePdf(),
    ).rejects.toThrow(/unreachable/);
  });
});
