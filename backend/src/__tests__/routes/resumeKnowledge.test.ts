import Fastify, { FastifyInstance } from 'fastify';
import { resumeHandler } from '../../routes/handlers/resumeHandlers';
import {
  createResumeDownloader,
  getResumeDownload,
  type ResumeDownload,
} from '../../services/resumeDownload';
import type { KnowledgeProfileClient } from '../../services/knowledge/profileClient';

jest.mock('../../services/resumeDownload', () => ({
  ...jest.requireActual('../../services/resumeDownload'),
  getResumeDownload: jest.fn(),
}));

const mockedGetResumeDownload = jest.mocked(getResumeDownload);
const PDF = Buffer.from('%PDF-1.4 resume');

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

  it('serves the primary resume PDF as an attachment', async () => {
    mockedGetResumeDownload.mockResolvedValue({ found: true, filename: 'resume.pdf', body: PDF });

    const res = await app.inject({ method: 'GET', url: '/resume' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="resume.pdf"; filename*=UTF-8''resume.pdf`,
    );
    expect(res.rawPayload).toEqual(PDF);
  });

  it('answers 404 when there is no primary resume', async () => {
    mockedGetResumeDownload.mockResolvedValue({ found: false });

    const res = await app.inject({ method: 'GET', url: '/resume' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Resume not found' });
  });

  it('answers 500 when the knowledge service fails', async () => {
    mockedGetResumeDownload.mockRejectedValue(new Error('boom'));

    const res = await app.inject({ method: 'GET', url: '/resume' });

    expect(res.statusCode).toBe(500);
  });
});

describe('createResumeDownloader', () => {
  const log = { warn: jest.fn() };
  let version: number | Error;
  let resume: Buffer | null;
  let getResumePdf: jest.Mock<Promise<Buffer | null>, []>;
  let getVersion: jest.Mock<Promise<number>, []>;

  function build(configured = true) {
    const client: KnowledgeProfileClient = { getPublished: jest.fn(), getResumePdf };
    return createResumeDownloader({
      getProfileClient: () => (configured ? client : null),
      getVersionClient: () => (configured ? { getVersion } : null),
    });
  }

  beforeEach(() => {
    log.warn.mockReset();
    version = 1;
    resume = PDF;
    getResumePdf = jest.fn(() => Promise.resolve(resume));
    getVersion = jest.fn(() =>
      version instanceof Error ? Promise.reject(version) : Promise.resolve(version),
    );
  });

  it('downloads the PDF once per corpus version', async () => {
    const downloader = build();
    await downloader.get(log);
    const second = await downloader.get(log);

    expect(second).toEqual({ found: true, filename: 'resume.pdf', body: PDF });
    expect(getResumePdf).toHaveBeenCalledTimes(1);
  });

  it('serves the new primary resume as soon as the version changes', async () => {
    const downloader = build();
    await downloader.get(log);

    version = 2;
    resume = Buffer.from('%PDF-1.4 new primary');
    const next = await downloader.get(log);

    expect(getResumePdf).toHaveBeenCalledTimes(2);
    expect(next).toEqual({ found: true, filename: 'resume.pdf', body: resume });
  });

  it('is not found without a primary resume, and notices a later upload', async () => {
    resume = null;
    const downloader = build();
    expect(await downloader.get(log)).toEqual({ found: false });
    expect(await downloader.get(log)).toEqual({ found: false });
    expect(getResumePdf).toHaveBeenCalledTimes(1);

    version = 2;
    resume = PDF;
    expect((await downloader.get(log)).found).toBe(true);
  });

  it('drops a cached resume when the primary is removed', async () => {
    const downloader = build();
    await downloader.get(log);
    version = 2;
    resume = null;
    expect(await downloader.get(log)).toEqual({ found: false });
  });

  it('serves the cached PDF when /version is unreachable', async () => {
    const downloader = build();
    await downloader.get(log);

    version = new Error('down');
    const res: ResumeDownload = await downloader.get(log);

    expect(res).toEqual({ found: true, filename: 'resume.pdf', body: PDF });
    expect(getResumePdf).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalled();
  });

  it('is not found when the knowledge service is not configured', async () => {
    expect(await build(false).get(log)).toEqual({ found: false });
    expect(getResumePdf).not.toHaveBeenCalled();
  });
});
