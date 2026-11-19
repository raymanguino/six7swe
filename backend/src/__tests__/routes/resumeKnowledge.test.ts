import Fastify, { FastifyInstance } from 'fastify';
import { attachmentDisposition, resumeHandler } from '../../routes/handlers/resumeHandlers';
import { createResumeDownloader, getResumeDownload } from '../../services/resumeDownload';
import type { KnowledgeProfileClient } from '../../services/knowledge/profileClient';

jest.mock('../../services/resumeDownload', () => ({
  ...jest.requireActual('../../services/resumeDownload'),
  getResumeDownload: jest.fn(),
}));

const mockedGetResumeDownload = jest.mocked(getResumeDownload);
const PDF = Buffer.from('%PDF-1.4 resume');

describe('attachmentDisposition', () => {
  it('keeps a plain name', () => {
    expect(attachmentDisposition('resume.pdf')).toBe(
      `attachment; filename="resume.pdf"; filename*=UTF-8''resume.pdf`,
    );
  });

  it('replaces quotes, backslashes and non-ASCII in the plain name and encodes the real one', () => {
    expect(attachmentDisposition('a"b\\c.pdf')).toBe(
      `attachment; filename="a_b_c.pdf"; filename*=UTF-8''a%22b%5Cc.pdf`,
    );
    expect(attachmentDisposition('履歴書 (2026).pdf')).toBe(
      `attachment; filename="___ (2026).pdf"; filename*=UTF-8''${encodeURIComponent('履歴書')}%20%282026%29.pdf`,
    );
  });
});

describe('GET /resume', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    app.get('/resume', resumeHandler);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    jest.resetAllMocks();
  });

  it('serves the primary resume PDF as a revalidated attachment', async () => {
    mockedGetResumeDownload.mockResolvedValue({ found: true, body: PDF, etag: '"resume-v3"' });

    const res = await app.inject({ method: 'GET', url: '/resume' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('public, max-age=0, must-revalidate');
    expect(res.headers.etag).toBe('"resume-v3"');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="resume.pdf"; filename*=UTF-8''resume.pdf`,
    );
    expect(res.rawPayload).toEqual(PDF);
  });

  it('answers 304 when the ETag matches', async () => {
    mockedGetResumeDownload.mockResolvedValue({ found: true, body: PDF, etag: '"resume-v3"' });

    const res = await app.inject({
      method: 'GET',
      url: '/resume',
      headers: { 'if-none-match': '"resume-v3"' },
    });

    expect(res.statusCode).toBe(304);
  });

  it.each([
    ['*', true],
    ['W/"resume-v3"', true],
    ['"resume-v1", "resume-v3"', true],
    ['"resume-v1", W/"resume-v3"', true],
    ['"resume-v1"', false],
    ['', false],
  ])('If-None-Match %j -> 304 is %s', async (header, hit) => {
    mockedGetResumeDownload.mockResolvedValue({ found: true, body: PDF, etag: '"resume-v3"' });

    const res = await app.inject({
      method: 'GET',
      url: '/resume',
      headers: { 'if-none-match': header },
    });

    expect(res.statusCode).toBe(hit ? 304 : 200);
  });

  it('answers HEAD with the PDF headers and no body (the landing page probe)', async () => {
    mockedGetResumeDownload.mockResolvedValue({ found: true, body: PDF, etag: '"resume-v3"' });

    const res = await app.inject({ method: 'HEAD', url: '/resume' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers.etag).toBe('"resume-v3"');
    expect(res.rawPayload.length).toBe(0);
  });

  it('answers HEAD 404 when there is no primary resume', async () => {
    mockedGetResumeDownload.mockResolvedValue({ found: false });

    const res = await app.inject({ method: 'HEAD', url: '/resume' });

    expect(res.statusCode).toBe(404);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.rawPayload.length).toBe(0);
  });

  it('answers 404, uncacheable, when there is no primary resume', async () => {
    mockedGetResumeDownload.mockResolvedValue({ found: false });

    const res = await app.inject({ method: 'GET', url: '/resume' });

    expect(res.statusCode).toBe(404);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({ error: 'Resume not found' });
  });

  it('answers 500 when the knowledge service fails', async () => {
    mockedGetResumeDownload.mockRejectedValue(new Error('boom'));

    const res = await app.inject({ method: 'GET', url: '/resume' });

    expect(res.statusCode).toBe(500);
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i++) await new Promise((r) => setTimeout(r, 0));
  expect(condition()).toBe(true);
}

describe('createResumeDownloader', () => {
  const log = { warn: jest.fn() };
  const TTL = 30_000;
  const STALE = 60 * 60_000;
  let clock: number;
  let version: number | Error;
  let resume: Buffer | null;
  let getResumePdf: jest.Mock<Promise<Buffer | null>, []>;
  let getVersion: jest.Mock<Promise<number>, []>;

  function build(options: { configured?: boolean; maxPdfBytes?: number } = {}) {
    const configured = options.configured ?? true;
    const client: KnowledgeProfileClient = { getPublished: jest.fn(), getResumePdf };
    return createResumeDownloader(
      {
        getProfileClient: () => (configured ? client : null),
        getVersionClient: () => (configured ? { getVersion } : null),
      },
      {
        versionTtlMs: TTL,
        maxStaleMs: STALE,
        maxPdfBytes: options.maxPdfBytes,
        now: () => clock,
      },
    );
  }

  /** Moves time past the version TTL so the next request re-reads `/version`. */
  const pastTtl = () => {
    clock += TTL + 1;
  };

  beforeEach(() => {
    log.warn.mockReset();
    clock = 1_000_000;
    version = 1;
    resume = PDF;
    getResumePdf = jest.fn(() => Promise.resolve(resume));
    getVersion = jest.fn(() =>
      version instanceof Error ? Promise.reject(version) : Promise.resolve(version),
    );
  });

  it('downloads the PDF once per version and reads /version at most once per TTL', async () => {
    const downloader = build();
    await downloader.get(log);
    const second = await downloader.get(log);

    expect(second).toEqual({ found: true, body: PDF, etag: '"resume-v1"' });
    expect(getVersion).toHaveBeenCalledTimes(1);

    pastTtl();
    await downloader.get(log);
    expect(getVersion).toHaveBeenCalledTimes(2);
    expect(getResumePdf).toHaveBeenCalledTimes(1);
  });

  it('serves the new primary resume once the version changes', async () => {
    const downloader = build();
    await downloader.get(log);

    version = 2;
    resume = Buffer.from('%PDF-1.4 new primary');
    pastTtl();
    const next = await downloader.get(log);

    expect(getResumePdf).toHaveBeenCalledTimes(2);
    expect(next).toEqual({ found: true, body: resume, etag: '"resume-v2"' });
  });

  it('shares one version read and one download between concurrent requests', async () => {
    const downloader = build();
    const results = await Promise.all([
      downloader.get(log),
      downloader.get(log),
      downloader.get(log),
    ]);

    expect(results.every((r) => r.found)).toBe(true);
    expect(getVersion).toHaveBeenCalledTimes(1);
    expect(getResumePdf).toHaveBeenCalledTimes(1);
  });

  it('retries after a failed download instead of caching the failure', async () => {
    const downloader = build();
    getResumePdf.mockRejectedValueOnce(new Error('unreachable'));
    await expect(downloader.get(log)).rejects.toThrow('unreachable');

    expect((await downloader.get(log)).found).toBe(true);
    expect(getResumePdf).toHaveBeenCalledTimes(2);
  });

  it('is not found without a primary resume, and notices a later upload', async () => {
    resume = null;
    const downloader = build();
    expect(await downloader.get(log)).toEqual({ found: false });
    pastTtl();
    expect(await downloader.get(log)).toEqual({ found: false });
    expect(getResumePdf).toHaveBeenCalledTimes(1);

    version = 2;
    resume = PDF;
    pastTtl();
    expect((await downloader.get(log)).found).toBe(true);
  });

  it('drops a cached resume when the primary is removed', async () => {
    const downloader = build();
    await downloader.get(log);
    version = 2;
    resume = null;
    pastTtl();
    expect(await downloader.get(log)).toEqual({ found: false });
  });

  it('never replaces a newer cache entry with an older download', async () => {
    const downloader = build();
    let releaseOld: (pdf: Buffer) => void = () => undefined;
    getResumePdf
      .mockImplementationOnce(() => new Promise<Buffer | null>((r) => (releaseOld = r)))
      .mockResolvedValueOnce(Buffer.from('%PDF-1.4 v2'));

    // v1 starts downloading and stalls; wait until it is actually inside getResumePdf.
    const slowV1 = downloader.get(log);
    await waitFor(() => getResumePdf.mock.calls.length === 1);

    version = 2;
    pastTtl();
    expect(await downloader.get(log)).toMatchObject({ found: true, etag: '"resume-v2"' });

    releaseOld(Buffer.from('%PDF-1.4 v1'));
    // The late v1 caller gets the newer entry, and the cache keeps v2.
    expect(await slowV1).toMatchObject({ found: true, etag: '"resume-v2"' });
    expect(await downloader.get(log)).toMatchObject({ found: true, etag: '"resume-v2"' });
    expect(getResumePdf).toHaveBeenCalledTimes(2);
  });

  it('re-downloads when the version goes backwards (knowledge database reset)', async () => {
    version = 5;
    const downloader = build();
    await downloader.get(log);

    version = 1;
    resume = Buffer.from('%PDF-1.4 after reset');
    pastTtl();
    expect(await downloader.get(log)).toEqual({ found: true, body: resume, etag: '"resume-v1"' });
    expect(getResumePdf).toHaveBeenCalledTimes(2);
  });

  it('serves the older cached PDF, bounded, when the newer version download fails', async () => {
    const downloader = build();
    await downloader.get(log);

    version = 2;
    pastTtl();
    getResumePdf.mockRejectedValue(new Error('service down'));
    expect(await downloader.get(log)).toEqual({ found: true, body: PDF, etag: '"resume-v1"' });

    clock += STALE;
    await expect(downloader.get(log)).rejects.toThrow('service down');
  });

  it('does not extend the stale window with requests served from the version TTL', async () => {
    const downloader = build();
    await downloader.get(log);
    // Many cached requests inside the TTL, then /version goes down for good.
    clock += TTL - 1;
    await downloader.get(log);
    version = new Error('down');
    // The stale window counts from the last real /version read, so it has now passed.
    clock += STALE - (TTL - 1);
    await expect(downloader.get(log)).rejects.toThrow('down');
  });

  it('remembers a bad resume for a TTL instead of downloading it on every request', async () => {
    resume = Buffer.from('<html>not a pdf</html>');
    const downloader = build();
    await expect(downloader.get(log)).rejects.toThrow(/not a PDF/);
    await expect(downloader.get(log)).rejects.toThrow(/not a PDF/);
    expect(getResumePdf).toHaveBeenCalledTimes(1);

    pastTtl();
    await expect(downloader.get(log)).rejects.toThrow(/not a PDF/);
    expect(getResumePdf).toHaveBeenCalledTimes(2);
  });

  it('serves the cached PDF when /version is unreachable, but only for a bounded time', async () => {
    const downloader = build();
    await downloader.get(log);

    version = new Error('down');
    pastTtl();
    expect(await downloader.get(log)).toEqual({ found: true, body: PDF, etag: '"resume-v1"' });
    expect(log.warn).toHaveBeenCalled();
    expect(getResumePdf).toHaveBeenCalledTimes(1);

    clock += STALE;
    await expect(downloader.get(log)).rejects.toThrow('down');
  });

  it('rejects a PDF over the size cap and one without the PDF magic', async () => {
    resume = Buffer.from('%PDF-1.4 ' + 'x'.repeat(100));
    await expect(build({ maxPdfBytes: 50 }).get(log)).rejects.toThrow(/larger than/);

    resume = Buffer.from('<html>not a pdf</html>');
    await expect(build().get(log)).rejects.toThrow(/not a PDF/);
  });

  it('rejects when the download fails and nothing is cached', async () => {
    getResumePdf.mockRejectedValue(new Error('service down'));
    await expect(build().get(log)).rejects.toThrow('service down');
  });

  it('is not found, with a distinct warning, when the knowledge service is not configured', async () => {
    expect(await build({ configured: false }).get(log)).toEqual({ found: false });
    expect(getResumePdf).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('not configured'));
  });
});
