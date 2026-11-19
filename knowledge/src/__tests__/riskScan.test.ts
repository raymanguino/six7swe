import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import {
  DocumentFindingsResponseSchema,
  DocumentListResponseSchema,
  DocumentResponseSchema,
  RetrieveResponseSchema,
  UploadResponseSchema,
} from '../contract.js';
import { createHashingEmbedder } from '../services/embedding/hashing.js';
import { detectPatternFindings } from '../services/risk/patterns.js';
import {
  locateExcerpt,
  scanDocument,
  SCAN_MAX_WINDOWS,
  SCAN_WINDOW_CHARS,
} from '../services/risk/scan.js';
import {
  createMiniMaxRiskScanner,
  createStubRiskScanner,
  parseScanAnswer,
  RiskScanError,
  type RiskScanner,
} from '../services/risk/scanner.js';
import {
  createMemoryFileStore,
  multipartFile,
  RESUME_MD,
  silentLogger,
  utf8,
} from './support/fixtures.js';
import { createMemoryEvalRepository } from './support/memoryEvalRepository.js';
import { createMemoryProfileRepository } from './support/memoryProfileRepository.js';
import { createMemoryRepository } from './support/memoryRepository.js';

/** A fictional note with a phone number and a salary figure. */
const RISKY_NOTE = `Notes for recruiters

Reach me on 416-555-0199 any weekday.
My salary expectation is $185,000 base.
I build billing platforms on Kafka.`;

const CLEAN_NOTE = `Side project notes

I build billing platforms on Kafka and Fastify.`;

describe('detectPatternFindings', () => {
  it('flags emails, phone numbers and postal addresses at their offsets', () => {
    const text =
      'Mail jordan@example.com or call +1 (416) 555-0199.\n' +
      'Home: 123 Maple Street, Toronto ON M5V 2T6.\n' +
      'Also jordan@example.com again.';
    const found = detectPatternFindings(text);
    expect(found.map((f) => [f.category, f.excerpt])).toEqual([
      ['contact_details', 'jordan@example.com'],
      ['contact_details', '+1 (416) 555-0199'],
      ['home_address', '123 Maple Street'],
      ['home_address', 'M5V 2T6'],
    ]);
    for (const f of found) {
      expect(f.source).toBe('pattern');
      expect(text.slice(f.location.offset ?? -1).startsWith(f.excerpt)).toBe(true);
    }
  });

  it('leaves the ordinary content of a resume alone', () => {
    expect(detectPatternFindings(RESUME_MD)).toEqual([]);
    expect(detectPatternFindings('Worked there 2019 - 2024, then 2024-2025.')).toEqual([]);
  });
});

describe('parseScanAnswer', () => {
  it('reads the findings, tolerating fences and unknown categories', () => {
    const answer =
      '```json\n{"findings":[{"category":"compensation","excerpt":"$185,000","reason":"Salary."},' +
      '{"category":"gossip","excerpt":"Bob is lazy","reason":"Mean."},' +
      '{"category":"credentials","excerpt":"  ","reason":"empty"}]}\n```';
    expect(parseScanAnswer(answer)).toEqual([
      { category: 'compensation', excerpt: '$185,000', reason: 'Salary.' },
      { category: 'other', excerpt: 'Bob is lazy', reason: 'Mean.' },
    ]);
    expect(parseScanAnswer('{"findings": []}')).toEqual([]);
  });

  it('throws on an answer that is not the findings shape, without quoting it', () => {
    expect(() => parseScanAnswer('Looks fine to me: 416-555-0199')).toThrow(RiskScanError);
    try {
      parseScanAnswer('{"verdict": "416-555-0199"}');
    } catch (error) {
      expect(error).toBeInstanceOf(RiskScanError);
      expect(String((error as RiskScanError).detail)).not.toContain('416');
    }
  });
});

describe('locateExcerpt', () => {
  it('finds an excerpt exactly, then ignoring case and whitespace, else null', () => {
    const text = 'One.\nMy Salary   expectation is high.';
    expect(locateExcerpt(text, 'Salary', 0)).toBe(8);
    expect(locateExcerpt(text, 'my salary expectation', 0)).toBe(5);
    expect(locateExcerpt(text, 'not there', 0)).toBeNull();
  });
});

const miniMaxReply = (content: string, finishReason = 'stop') =>
  new Response(
    JSON.stringify({
      choices: [{ finish_reason: finishReason, message: { content } }],
      base_resp: { status_code: 0 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const miniMaxScanner = (fetchImpl: typeof fetch) =>
  createMiniMaxRiskScanner({
    url: 'https://minimax.test/v1/chat/completions',
    apiKey: 'mm-key',
    model: 'MiniMax-M3',
    fetchImpl,
  });

describe('scanDocument', () => {
  it('combines the patterns and the model pass, locating the model excerpts', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      miniMaxReply(
        JSON.stringify({
          findings: [
            {
              category: 'compensation',
              excerpt: 'My salary expectation is $185,000 base.',
              reason: 'A salary expectation.',
            },
          ],
        }),
      ),
    );
    const findings = await scanDocument(RISKY_NOTE, {
      scanner: miniMaxScanner(fetchImpl),
      log: silentLogger,
    });
    expect(findings.map((f) => [f.category, f.source])).toEqual([
      ['contact_details', 'pattern'],
      ['compensation', 'model'],
    ]);
    expect(findings[1]?.location.offset).toBe(RISKY_NOTE.indexOf('My salary'));

    // The document goes to the model as delimited data, never with the key in the body.
    const init = fetchImpl.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    expect(body.messages[1]?.content).toContain('DOCUMENT\n"""');
    expect(body.messages[1]?.content).toContain('416-555-0199');
    expect(String(init?.body)).not.toContain('mm-key');
  });

  it('records a scan failure when the provider is down, keeping the pattern findings', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('down', { status: 503 }));
    const findings = await scanDocument(RISKY_NOTE, {
      scanner: miniMaxScanner(fetchImpl),
      log: silentLogger,
    });
    expect(findings[0]).toMatchObject({ category: 'scan_failed', source: 'scan', excerpt: '' });
    expect(findings[0]?.reason).toContain('status 503');
    expect(findings.some((f) => f.category === 'contact_details')).toBe(true);
  });

  it('records a scan failure for an answer cut off at the token limit', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => miniMaxReply('{"findings": [', 'length'));
    const findings = await scanDocument(CLEAN_NOTE, {
      scanner: miniMaxScanner(fetchImpl),
      log: silentLogger,
    });
    expect(findings).toMatchObject([{ category: 'scan_failed' }]);
  });

  it('records a scan failure when the scan runs out of time', async () => {
    const hanging: RiskScanner = {
      name: 'hanging',
      scan: (_text, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    };
    const findings = await scanDocument(CLEAN_NOTE, {
      scanner: hanging,
      log: silentLogger,
      deadlineMs: 20,
    });
    expect(findings).toMatchObject([
      { category: 'scan_failed', reason: expect.stringContaining('did not finish in time') },
    ]);
  });

  it('scans long text in windows and reports what it could not reach', async () => {
    const scan = vi.fn<RiskScanner['scan']>(async () => []);
    const text = 'a '.repeat((SCAN_WINDOW_CHARS * (SCAN_MAX_WINDOWS + 1)) / 2);
    const findings = await scanDocument(text, {
      scanner: { name: 'spy', scan },
      log: silentLogger,
    });
    expect(scan).toHaveBeenCalledTimes(SCAN_MAX_WINDOWS);
    expect(findings).toMatchObject([
      { category: 'scan_failed', reason: expect.stringContaining('too long to scan in full') },
    ]);
  });

  it('is clean when nothing is found', async () => {
    expect(
      await scanDocument(CLEAN_NOTE, { scanner: createStubRiskScanner(), log: silentLogger }),
    ).toEqual([]);
  });
});

const KEY = 'k'.repeat(40);
const OWNER_KEY = 'o'.repeat(40);
const serviceAuth = { 'x-knowledge-key': KEY };
const ownerAuth = { 'x-knowledge-key': OWNER_KEY };

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (!app) return;
  await app.ingestionQueue.idle();
  await app.riskBackfill.idle();
  await app.evalRunner.idle();
  await app.evalSet.idle();
  await app.close();
  app = undefined;
});

async function setup(riskScanner: RiskScanner | null) {
  const repo = createMemoryRepository();
  const built = await buildApp({
    deps: { repo, files: createMemoryFileStore(), embedder: createHashingEmbedder(256) },
    profile: { repo: createMemoryProfileRepository(), drafter: null },
    evaluation: { repo: createMemoryEvalRepository(), answerer: null },
    serviceKey: KEY,
    ownerKey: OWNER_KEY,
    ownerId: 'owner',
    maxUploadBytes: 4096,
    logger: false,
    riskScanner,
  });
  app = built;

  const upload = async (name: string, text: string, kind = 'supporting') => {
    const { payload, headers } = multipartFile(name, utf8(text));
    const res = await built.inject({
      method: 'POST',
      url: `/documents?kind=${kind}`,
      payload,
      headers: { ...headers, ...ownerAuth },
    });
    await built.ingestionQueue.idle();
    return UploadResponseSchema.parse(res.json()).document.id;
  };
  const getDoc = async (id: string) =>
    DocumentResponseSchema.parse(
      (await built.inject({ method: 'GET', url: `/documents/${id}`, headers: ownerAuth })).json(),
    ).document;
  /** What a visitor's chat would get. */
  const retrieve = async (query: string) =>
    RetrieveResponseSchema.parse(
      (
        await built.inject({
          method: 'POST',
          url: '/retrieve',
          payload: { query },
          headers: serviceAuth,
        })
      ).json(),
    ).chunks;
  const approve = (id: string) =>
    built.inject({ method: 'POST', url: `/documents/${id}/approve`, headers: ownerAuth });
  const findings = async (id: string) =>
    DocumentFindingsResponseSchema.parse(
      (
        await built.inject({ method: 'GET', url: `/documents/${id}/findings`, headers: ownerAuth })
      ).json(),
    ).findings;
  return { app: built, repo, upload, getDoc, retrieve, approve, findings };
}

describe('the review gate', () => {
  it('makes a clean document ready and searchable', async () => {
    const { upload, getDoc, retrieve, findings } = await setup(createStubRiskScanner());
    const id = await upload('notes.txt', CLEAN_NOTE);
    expect(await getDoc(id)).toMatchObject({ status: 'ready', findingCount: 0, approvedAt: null });
    expect((await getDoc(id)).scannedAt).not.toBeNull();
    expect(await findings(id)).toEqual([]);
    expect((await retrieve('kafka billing')).map((c) => c.documentId)).toContain(id);
  });

  it('holds a document with a phone number and a salary for review until it is approved', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      miniMaxReply(
        JSON.stringify({
          findings: [
            {
              category: 'compensation',
              excerpt: 'salary expectation is $185,000',
              reason: 'A salary expectation.',
            },
          ],
        }),
      ),
    );
    const { upload, getDoc, retrieve, approve, findings } = await setup(miniMaxScanner(fetchImpl));
    const id = await upload('recruiters.txt', RISKY_NOTE);

    expect(await getDoc(id)).toMatchObject({ status: 'needs_review', findingCount: 2 });
    const flagged = await findings(id);
    expect(flagged.map((f) => f.category).sort()).toEqual(['compensation', 'contact_details']);
    expect(flagged.find((f) => f.category === 'contact_details')?.excerpt).toBe('416-555-0199');
    // "Ask as a visitor" does not find it.
    expect((await retrieve('kafka billing platforms')).map((c) => c.documentId)).not.toContain(id);

    const res = await approve(id);
    expect(res.statusCode).toBe(200);
    const approved = DocumentResponseSchema.parse(res.json()).document;
    expect(approved).toMatchObject({ status: 'ready', findingCount: 2 });
    expect(approved.approvedAt).not.toBeNull();
    expect((await retrieve('kafka billing platforms')).map((c) => c.documentId)).toContain(id);
    // The findings stay on record with the approval.
    expect(await findings(id)).toHaveLength(2);
    expect((await approve(id)).statusCode).toBe(409);
  });

  it('holds a document for review when the scan fails, never making it ready unscanned', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    const { upload, getDoc, retrieve, findings } = await setup(miniMaxScanner(fetchImpl));
    const id = await upload('notes.txt', CLEAN_NOTE);
    expect(await getDoc(id)).toMatchObject({ status: 'needs_review', findingCount: 1 });
    expect(await findings(id)).toMatchObject([
      { category: 'scan_failed', reason: expect.stringContaining('could not be reached') },
    ]);
    expect(await retrieve('kafka billing')).toEqual([]);
  });

  it('runs the pattern checks with no model configured', async () => {
    const { upload, getDoc } = await setup(null);
    const id = await upload('contact.md', '# Contact\n\nWrite to jordan@example.com.');
    expect(await getDoc(id)).toMatchObject({ status: 'needs_review', findingCount: 1 });
  });

  it('treats a re-upload of a flagged file as a duplicate, not a retry', async () => {
    const { app: built, upload } = await setup(null);
    const id = await upload('contact.md', 'Write to jordan@example.com.');
    const { payload, headers } = multipartFile('contact.md', utf8('Write to jordan@example.com.'));
    const res = await built.inject({
      method: 'POST',
      url: '/documents',
      payload,
      headers: { ...headers, ...ownerAuth },
    });
    expect(res.statusCode).toBe(200);
    expect(UploadResponseSchema.parse(res.json())).toMatchObject({
      deduplicated: true,
      document: { id, status: 'needs_review' },
    });
  });

  it('keeps a flagged resume from being primary until it is approved', async () => {
    const { upload, getDoc, approve } = await setup(null);
    const id = await upload('resume.md', `${RESUME_MD}\nPhone: 416-555-0199\n`, 'resume');
    expect(await getDoc(id)).toMatchObject({ status: 'needs_review', isPrimaryResume: false });
    await approve(id);
    expect(await getDoc(id)).toMatchObject({ status: 'ready', isPrimaryResume: true });
  });

  it('answers 404 for an unknown document and 409 for a clean one', async () => {
    const { upload, approve, app: built } = await setup(null);
    const unknown = '00000000-0000-4000-8000-000000000000';
    expect((await approve(unknown)).statusCode).toBe(404);
    expect(
      (
        await built.inject({
          method: 'GET',
          url: `/documents/${unknown}/findings`,
          headers: ownerAuth,
        })
      ).statusCode,
    ).toBe(404);
    const clean = await upload('notes.txt', CLEAN_NOTE);
    expect((await approve(clean)).statusCode).toBe(409);
  });

  it('keeps the findings and approval routes owner-only', async () => {
    const { upload, app: built } = await setup(null);
    const id = await upload('notes.txt', CLEAN_NOTE);
    for (const [method, url] of [
      ['GET', `/documents/${id}/findings`],
      ['POST', `/documents/${id}/approve`],
    ] as const) {
      expect((await built.inject({ method, url, headers: serviceAuth })).statusCode).toBe(401);
      expect((await built.inject({ method, url })).statusCode).toBe(401);
    }
  });
});

describe('the backfill', () => {
  it('scans ready documents from before the scan once, leaving them searchable', async () => {
    const {
      app: built,
      repo,
      upload,
      getDoc,
      retrieve,
      approve,
      findings,
    } = await setup(createStubRiskScanner());
    const risky = await upload('old.txt', RISKY_NOTE);
    const clean = await upload('clean.txt', CLEAN_NOTE);
    await approve(risky);
    // As the migration leaves them: ready, never scanned.
    for (const id of [risky, clean]) {
      const doc = repo.documents.get(id);
      if (doc)
        repo.documents.set(id, { ...doc, scannedAt: null, approvedAt: null, findingCount: 0 });
      repo.findings.delete(id);
    }

    expect(await built.riskBackfill.start()).toBe(2);
    await built.riskBackfill.idle();

    const backfilled = await getDoc(risky);
    expect(backfilled).toMatchObject({ status: 'ready', approvedAt: null });
    expect(backfilled.findingCount).toBeGreaterThan(0);
    expect((await findings(risky)).map((f) => f.category)).toEqual(
      expect.arrayContaining(['contact_details', 'compensation']),
    );
    expect(await getDoc(clean)).toMatchObject({ status: 'ready', findingCount: 0 });
    expect((await retrieve('kafka billing platforms')).map((c) => c.documentId)).toContain(risky);

    // Done once: nothing is left to scan.
    expect(await built.riskBackfill.start()).toBe(0);

    // The owner approves the findings; the document keeps serving.
    const res = await approve(risky);
    expect(res.statusCode).toBe(200);
    expect(DocumentResponseSchema.parse(res.json()).document.approvedAt).not.toBeNull();
    const list = DocumentListResponseSchema.parse(
      (await built.inject({ method: 'GET', url: '/documents', headers: ownerAuth })).json(),
    );
    expect(list.documents.find((d) => d.id === risky)).toMatchObject({ status: 'ready' });
  });
});
