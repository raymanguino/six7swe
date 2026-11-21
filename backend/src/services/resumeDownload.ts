import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { getDefaultResumeClient, type KnowledgeResumeClient } from './knowledge/resumeClient';
import { KnowledgeBodyTooLargeError } from './knowledge/transport';
import { getDefaultRetrievalClient, type RetrievalClient } from './knowledgeRetrieval';

/** The resume PDF to download (with an ETag derived from its bytes), or none. */
export type ResumeDownload = { found: true; body: Buffer; etag: string } | { found: false };

export interface ResumeSources {
  /** Null when the knowledge service is not configured. */
  getResumeClient(): KnowledgeResumeClient | null;
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
type CacheEntry = { version: number; pdf: Buffer | null; etag: string | null; validatedAt: number };

/**
 * The resume's ETag, from a hash of the PDF itself. The corpus version restarts when the knowledge
 * database is reset, so a version-based validator could match a different file after a reset.
 */
export function resumeEtag(pdf: Buffer): string {
  return `"resume-${createHash('sha256').update(pdf).digest('hex').slice(0, 32)}"`;
}

const entry = (version: number, pdf: Buffer | null, validatedAt: number): CacheEntry => ({
  version,
  pdf,
  etag: pdf ? resumeEtag(pdf) : null,
  validatedAt,
});

/** The primary resume is not something to serve (too large, not a PDF). */
class InvalidResumeError extends Error {}

/**
 * Serves the knowledge service's primary resume (`/resume.pdf`), cached by the corpus `/version`.
 * The version is re-read at most every `versionTtlMs`, so a new primary resume shows up within
 * that window and the PDF is downloaded once per version. Concurrent requests share one version
 * read and one download. If `/version` cannot be read, or a newer version's download fails, the
 * cached PDF is served for up to `maxStaleMs`; past that, or with nothing cached, the error
 * propagates. A failed `/version` read is also remembered for `versionTtlMs`, so an outage costs
 * one attempt per window rather than one per request. A resume that is too large or not a PDF is
 * remembered as bad for `versionTtlMs`, so it is not downloaded again on every request.
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
  let versionFailure: { error: unknown; at: number } | null = null;
  const downloads = new Map<number, Promise<Buffer | null>>();
  let badResume: { version: number; error: Error; at: number } | null = null;

  const toDownload = ({ pdf, etag }: CacheEntry): ResumeDownload =>
    pdf && etag ? { found: true, body: pdf, etag } : { found: false };

  const staleUsable = (): CacheEntry | null =>
    cache && now() - cache.validatedAt < maxStaleMs ? cache : null;

  function readVersion(client: Pick<RetrievalClient, 'getVersion'>): Promise<number> {
    if (lastVersion && now() - lastVersion.at < versionTtlMs) {
      return Promise.resolve(lastVersion.version);
    }
    if (versionFailure && now() - versionFailure.at < versionTtlMs) {
      return Promise.reject(versionFailure.error);
    }
    versionInflight ??= client
      .getVersion()
      .then(
        (version) => {
          lastVersion = { version, at: now() };
          versionFailure = null;
          return version;
        },
        (error: unknown) => {
          versionFailure = { error, at: now() };
          throw error;
        },
      )
      .finally(() => {
        versionInflight = null;
      });
    return versionInflight;
  }

  async function downloadPdf(client: KnowledgeResumeClient): Promise<Buffer | null> {
    let pdf: Buffer | null;
    try {
      pdf = await client.getResumePdf(maxPdfBytes);
    } catch (error) {
      if (error instanceof KnowledgeBodyTooLargeError) throw new InvalidResumeError(error.message);
      throw error;
    }
    if (pdf === null) return null;
    if (pdf.length > maxPdfBytes) {
      throw new InvalidResumeError(`Primary resume is larger than ${maxPdfBytes} bytes`);
    }
    if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      throw new InvalidResumeError('Primary resume is not a PDF');
    }
    return pdf;
  }

  function download(client: KnowledgeResumeClient, version: number): Promise<Buffer | null> {
    if (badResume && badResume.version === version && now() - badResume.at < versionTtlMs) {
      return Promise.reject(badResume.error);
    }
    let inflight = downloads.get(version);
    if (!inflight) {
      inflight = downloadPdf(client)
        .catch((error: unknown) => {
          if (error instanceof InvalidResumeError) badResume = { version, error, at: now() };
          throw error;
        })
        .finally(() => {
          downloads.delete(version);
        });
      downloads.set(version, inflight);
    }
    return inflight;
  }

  return {
    async get(log: Logger): Promise<ResumeDownload> {
      const resumes = sources.getResumeClient();
      const versions = sources.getVersionClient();
      if (!resumes || !versions) {
        log.warn('Resume unavailable: the knowledge service is not configured');
        return { found: false };
      }

      let version: number;
      try {
        version = await readVersion(versions);
      } catch (error) {
        const stale = staleUsable();
        if (!stale) throw error;
        log.warn(
          { err: error },
          'Could not read the knowledge corpus version; serving the cached resume',
        );
        return toDownload(stale);
      }

      if (cache && cache.version === version) {
        // Only a real `/version` read counts as validation, not a TTL-cached request.
        if (lastVersion) cache.validatedAt = Math.max(cache.validatedAt, lastVersion.at);
        return toDownload(cache);
      }

      // Any other version (older too: the knowledge database may have been reset) is a change.
      let pdf: Buffer | null;
      try {
        pdf = await download(resumes, version);
      } catch (error) {
        const stale = staleUsable();
        if (!stale) throw error;
        log.warn(
          { err: error },
          'Could not download the new primary resume; serving the cached one',
        );
        return toDownload(stale);
      }

      // A download that finished after a newer version was observed must not replace the entry.
      if (lastVersion?.version === version) {
        cache = entry(version, pdf, lastVersion.at);
        return toDownload(cache);
      }
      return toDownload(cache ?? entry(version, pdf, now()));
    },
  };
}

const defaultDownloader = createResumeDownloader({
  getResumeClient: getDefaultResumeClient,
  getVersionClient: getDefaultRetrievalClient,
});

/** The primary resume, shared by `/resume` and the public MCP's `get_resume_pdf`. */
export function getResumeDownload(log: Logger): Promise<ResumeDownload> {
  return defaultDownloader.get(log);
}
