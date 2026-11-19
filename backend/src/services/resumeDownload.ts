import type { FastifyBaseLogger } from 'fastify';
import { getKnowledgeRetrievalConfig } from '../config/knowledgeRetrieval';
import { getDefaultProfileClient, type KnowledgeProfileClient } from './knowledge/profileClient';
import { createHttpRetrievalClient, type RetrievalClient } from './knowledgeRetrieval';

/** The name the resume is offered under; the service does not send the uploaded name. */
export const RESUME_FILENAME = 'resume.pdf';

/** The resume PDF to download, or `found: false` when the knowledge service has no primary resume. */
export type ResumeDownload = { found: true; filename: string; body: Buffer } | { found: false };

export interface ResumeSources {
  /** Null when the knowledge service is not configured. */
  getProfileClient(): KnowledgeProfileClient | null;
  /** Null when the knowledge service is not configured. */
  getVersionClient(): Pick<RetrievalClient, 'getVersion'> | null;
}

type CacheEntry = { version: number; pdf: Buffer | null };

/**
 * Serves the knowledge service's primary resume (`/resume.pdf`), cached by the corpus
 * `/version`. Every request asks `/version` (a tiny call), so a new primary resume is served
 * as soon as the version moves and the PDF is downloaded once per version. If `/version`
 * cannot be read, the last cached PDF is served rather than failing the download.
 */
export function createResumeDownloader(sources: ResumeSources) {
  let cache: CacheEntry | null = null;

  const toDownload = (pdf: Buffer | null): ResumeDownload =>
    pdf ? { found: true, filename: RESUME_FILENAME, body: pdf } : { found: false };

  return {
    async get(log: Pick<FastifyBaseLogger, 'warn'>): Promise<ResumeDownload> {
      const profile = sources.getProfileClient();
      const versions = sources.getVersionClient();
      if (!profile || !versions) return { found: false };

      let version: number | null = null;
      try {
        version = await versions.getVersion();
      } catch (error) {
        log.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'Could not read the knowledge corpus version for the resume',
        );
        if (cache) return toDownload(cache.pdf);
      }

      if (version !== null && cache && cache.version === version) return toDownload(cache.pdf);

      const pdf = await profile.getResumePdf();
      if (version !== null) cache = { version, pdf };
      return toDownload(pdf);
    },
    /** For tests. */
    clear(): void {
      cache = null;
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

export function getResumeDownload(log: Pick<FastifyBaseLogger, 'warn'>): Promise<ResumeDownload> {
  return defaultDownloader.get(log);
}
