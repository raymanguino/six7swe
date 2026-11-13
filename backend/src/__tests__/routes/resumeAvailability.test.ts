import Fastify, { FastifyInstance } from 'fastify';
import { Writable } from 'stream';
import { getPortfolioHandler } from '../../routes/handlers/portfolioHandlers';
import { resumeHandler } from '../../routes/handlers/resumeHandlers';
import { getPortfolioData } from '../../services/portfolioService';
import { findLocalResume, isResumeAvailable } from '../../services/resumeService';

jest.mock('../../services/portfolioService', () => ({ getPortfolioData: jest.fn() }));
jest.mock('../../services/resumeService', () => ({
  ...jest.requireActual('../../services/resumeService'),
  findLocalResume: jest.fn(),
  isResumeAvailable: jest.fn(),
}));

const mockedGetPortfolioData = jest.mocked(getPortfolioData);
const mockedFindLocalResume = jest.mocked(findLocalResume);
const mockedIsResumeAvailable = jest.mocked(isResumeAvailable);

/**
 * A deploy without a resume PDF must not advertise one (#104): `/portfolio` reports
 * `resumeAvailable: false`, and `/resume` logs the miss before answering 404.
 */
describe('resume availability', () => {
  let app: FastifyInstance;
  let logLines: Array<{ level: number; msg: string }>;

  beforeEach(async () => {
    delete process.env.PORTFOLIO_DATA_SOURCE;
    mockedGetPortfolioData.mockResolvedValue({
      profile: { name: 'Ray', title: 'Engineer', resumeFilename: 'ray.pdf' },
    } as never);

    logLines = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        logLines.push(JSON.parse(chunk.toString()) as { level: number; msg: string });
        callback();
      },
    });

    app = Fastify({ logger: { level: 'warn', stream } });
    app.get('/portfolio', getPortfolioHandler);
    app.get('/resume', resumeHandler);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    jest.resetAllMocks();
  });

  it.each([true, false])('/portfolio reports resumeAvailable: %s', async (available) => {
    mockedIsResumeAvailable.mockReturnValue(available);

    const response = await app.inject({ method: 'GET', url: '/portfolio' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      resumeFilename: 'ray.pdf',
      resumeAvailable: available,
    });
    expect(mockedIsResumeAvailable).toHaveBeenCalledWith('ray.pdf');
  });

  it('/resume logs a warning and answers 404 when no PDF is on disk', async () => {
    mockedFindLocalResume.mockReturnValue(null);

    const response = await app.inject({ method: 'GET', url: '/resume' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Resume not found' });
    // pino level 40 is warn.
    expect(logLines).toContainEqual(
      expect.objectContaining({ level: 40, msg: 'Resume not found' }),
    );
  });
});
