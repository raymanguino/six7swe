import { randomUUID } from 'node:crypto';
import type { RetrievedChunkDto, RetrieveResponse } from '@six7swe/knowledge-types';
import { DEFAULT_VERSION_TTL_MS as CHAT_VERSION_TTL_MS } from '../../config/knowledgeRetrieval';
import { createJobKnowledgeSource } from '../../services/jobHunt/knowledgeSource';
import { createCachedRetriever, type RetrievalClient } from '../../services/knowledgeRetrieval';
import {
  createResumeDownloader,
  DEFAULT_VERSION_TTL_MS as RESUME_VERSION_TTL_MS,
} from '../../services/resumeDownload';

/**
 * #130: every background cache is keyed to the knowledge corpus version
 * (`/version`), so a corpus change (an upload, a delete, a new primary resume)
 * reaches every backend replica on its own, with no in-process cache bust and
 * no broadcast between replicas.
 *
 * Each test runs two replicas (two independent caches, as two processes would
 * hold) against one shared knowledge service, changes the corpus there, and
 * checks that both replicas serve the new background within the stated bound:
 * the chat retriever and `/resume` re-read the version at most every 30 s; the
 * job hunter reads it at the start of every run.
 */

/** A knowledge service shared by every replica. Its corpus changes under them. */
function knowledgeService() {
  const state = { version: 1, content: 'Worked at Acme.', pdf: Buffer.from('%PDF-1.4 v1') };
  const chunk = (): RetrievedChunkDto => ({
    chunkId: randomUUID(),
    documentId: randomUUID(),
    filename: 'resume.md',
    heading: null,
    content: state.content,
    similarity: 0.9,
  });
  const client = (): RetrievalClient & { calls: number } => {
    const c = {
      calls: 0,
      async getVersion() {
        c.calls += 1;
        return state.version;
      },
      async retrieve(): Promise<RetrieveResponse> {
        c.calls += 1;
        return { version: state.version, chunks: [chunk()] };
      },
    };
    return c;
  };
  return {
    state,
    client,
    /** What an upload does in the knowledge service: new content, a new version. */
    upload(content: string, pdf: string) {
      state.version += 1;
      state.content = content;
      state.pdf = Buffer.from(pdf);
    },
  };
}

describe('background caches across replicas (#130)', () => {
  it('chat: a corpus change reaches every replica within the version TTL', async () => {
    const service = knowledgeService();
    let now = 0;
    const replica = () =>
      createCachedRetriever(service.client(), {
        k: 6,
        versionTtlMs: CHAT_VERSION_TTL_MS,
        failureCooldownMs: 15_000,
        maxEntries: 10,
        now: () => now,
      });
    const a = replica();
    const b = replica();

    expect((await a.retrieve('Where did you work?'))[0]?.content).toBe('Worked at Acme.');
    expect((await b.retrieve('Where did you work?'))[0]?.content).toBe('Worked at Acme.');

    service.upload('Worked at Globex.', '%PDF-1.4 v2');

    // Inside the bound, a replica may still answer from its cache...
    now += CHAT_VERSION_TTL_MS - 1;
    expect((await a.retrieve('Where did you work?'))[0]?.content).toBe('Worked at Acme.');

    // ...and once the version is re-read, both serve the new corpus. Nothing was invalidated.
    now += 1;
    expect((await a.retrieve('Where did you work?'))[0]?.content).toBe('Worked at Globex.');
    expect((await b.retrieve('Where did you work?'))[0]?.content).toBe('Worked at Globex.');
  });

  it('job hunter: each run reads the version, so the next run on any replica sees the change', async () => {
    const service = knowledgeService();
    const a = createJobKnowledgeSource({ retrieval: service.client(), documents: null });
    const b = createJobKnowledgeSource({ retrieval: service.client(), documents: null });

    // A run: read the version, then the overall background at that version.
    const run = async (source: typeof a) =>
      (await source.getBackgroundSummary(await source.getVersion()))[0]?.content;

    expect(await run(a)).toBe('Worked at Acme.');
    expect(await run(b)).toBe('Worked at Acme.');

    service.upload('Worked at Globex.', '%PDF-1.4 v2');

    expect(await run(a)).toBe('Worked at Globex.');
    expect(await run(b)).toBe('Worked at Globex.');
  });

  it('/resume: a new primary resume reaches every replica within the version TTL', async () => {
    const service = knowledgeService();
    let now = 0;
    const log = { warn: jest.fn() };
    const replica = () => {
      const versions = service.client();
      return createResumeDownloader(
        {
          getResumeClient: () => ({ getResumePdf: async () => service.state.pdf }),
          getVersionClient: () => versions,
        },
        { now: () => now },
      );
    };
    const a = replica();
    const b = replica();
    const body = async (r: ReturnType<typeof replica>) => {
      const download = await r.get(log);
      return download.found ? download.body.toString() : null;
    };

    expect(await body(a)).toBe('%PDF-1.4 v1');
    expect(await body(b)).toBe('%PDF-1.4 v1');

    service.upload('Worked at Globex.', '%PDF-1.4 v2');
    now += RESUME_VERSION_TTL_MS;

    expect(await body(a)).toBe('%PDF-1.4 v2');
    expect(await body(b)).toBe('%PDF-1.4 v2');
  });
});
