import type { FastifyBaseLogger } from 'fastify';
import { getKnowledgeRetrievalConfig } from '../config/knowledgeRetrieval';
import { getDefaultProfileClient, type KnowledgeProfileClient } from './knowledge/profileClient';
import { createHttpRetrievalClient, type RetrievalClient } from './knowledgeRetrieval';

/** The resume PDF to download (with an ETag for its corpus version), or none. */
export type ResumeDownload = { found: true; body: Buffer; etag: string } | { found: false };

export interface ResumeSources {
  /** Null when the knowledge service is not configured. */
  getProfileClient(): KnowledgeProfileClient | null;
  /** Null when the knowledge service is not configured. */
  getVersionClient(): Pick<RetrievalClient, 'getVersion'> | null;
}

export interface ResumeDownloaderOptions {
  /** How long a read corpus version is trusted before `/version` is asked again. */
  versionTtlMs?: number;
  /** How long a cached PDF may be served while `/version` is unreachable. */
  maxStaleMs?: number;
  maxPdfBytes?: number;
  now?: () => number;
}

export const DEFAULT_VERSION_TTL_MS = 30_000;
export const DEFAULT_MAX_STALE_MS = 60 * 60_000;
export const DEFAULT_MAX_PDF_BYTES = 10 * 1024 * 1024;

type Logger = Pick<FastifyBaseLogger, 'warn'>;
type CacheEntry = { version: number; pdf: Buffer | null; validatedAt: number };

/**
 * Serves the knowledge service's primary resume (`/resume.pdf`), cached by the corpus `/version`.
 * The version is re-read at most every `versionTtlMs`, so a new primary resume shows up within
 * that window and the PDF is downloaded once per version. Concurrent requests share one version
 * read and one download. If `/version` cannot be read, the cached PDF is served for up to
 * `maxStaleMs`; past that, or with nothing cached, the error propagates.
 */
export function createResumeDownloader(
  sources: ResumeSources,
  options: ResumeDownloaderOptions = {},
) {
  const versionTtlMs = options.versionTtlMs ?? DEFAULT_VERSION_TTL_MS;
  const maxStaleMs = options.maxStaleMs ?? DEFAULT_MAX_STALE_MS;
  const maxPdfBytes = options.maxPdfBytes ?? DEFAULT_MAX_PDF_BYTES;
  const now = options.now ?? Date.now;

  let cache: CacheEntry | null = null;
  let lastVersion: { version: number; at: number } | null = null;
  let versionInflight: Promise<number> | null = null;
  const downloads = new Map<number, Promise<Buffer | null>>();

  const toDownload = (entry: CacheEntry): ResumeDownload =>
    entry.pdf
      ? { found: true, body: entry.pdf, etag: `"resume-v${entry.version}"` }
      : { found: false };

  function readVersion(client: Pick<RetrievalClient, 'getVersion'>): Promise<number> {
    if (lastVersion && now() - lastVersion.at < versionTtlMs) {
      return Promise.resolve(lastVersion.version);
    }
    versionInflight ??= client
      .getVersion()
      .then((version) => {
        lastVersion = { version, at: now() };
        return version;
      })
      .finally(() => {
        versionInflight = null;
      });
    return versionInflight;
  }

  async function downloadPdf(client: KnowledgeProfileClient): Promise<Buffer | null> {
    const pdf = await client.getResumePdf();
    if (pdf === null) return null;
    if (pdf.length > maxPdfBytes) {
      throw new Error(`Primary resume is larger than ${maxPdfBytes} bytes`);
    }
    if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      throw new Error('Primary resume is not a PDF');
    }
    return pdf;
  }

  function download(client: KnowledgeProfileClient, version: number): Promise<Buffer | null> {
    let inflight = downloads.get(version);
    if (!inflight) {
      inflight = downloadPdf(client).finally(() => {
        downloads.delete(version);
      });
      downloads.set(version, inflight);
    }
    return inflight;
  }

  return {
    async get(log: Logger): Promise<ResumeDownload> {
      const profile = sources.getProfileClient();
      const versions = sources.getVersionClient();
      if (!profile || !versions) {
        log.warn('Resume unavailable: the knowledge service is not configured');
        return { found: false };
      }

      let version: number;
      try {
        version = await readVersion(versions);
      } catch (error) {
        if (cache && now() - cache.validatedAt < maxStaleMs) {
          log.warn(
            { err: error },
            'Could not read the knowledge corpus version; serving the cached resume',
          );
          return toDownload(cache);
        }
        throw error;
      }

      if (cache && cache.version >= version) {
        if (cache.version === version) cache.validatedAt = now();
        return toDownload(cache);
      }

      const pdf = await download(profile, version);
      // An older download that finishes late must not replace a newer entry.
      const entry: CacheEntry = { version, pdf, validatedAt: now() };
      if (!cache || cache.version <= version) cache = entry;
      return toDownload(cache);
    },
  };
}

const defaultDownloader = createResumeDownloader({
  getProfileClient: getDefaultProfileClient,
  getVersionClient() {
    const config = getKnowledgeRetrievalConfig();
    return config ? createHttpRetrievalClient(config) : null;
  },
});

export function getResumeDownload(log: Logger): Promise<ResumeDownload> {
  return defaultDownloader.get(log);
}
