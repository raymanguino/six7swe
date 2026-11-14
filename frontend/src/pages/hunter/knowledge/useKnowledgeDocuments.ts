import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '../../../utils/api';
import { errorMessage } from '../../../utils/errorMessage';
import {
  parseDocument,
  parseDocumentList,
  parseUpload,
  type DocumentKind,
  type KnowledgeDocument,
} from './types';

/** How often the list is re-read while any document is still being ingested. */
const POLL_INTERVAL_MS = 2000;
/** Live status gives up after this long; the next action or a reload starts it again. */
const POLL_LIMIT_MS = 5 * 60 * 1000;

const isInFlight = (doc: KnowledgeDocument) =>
  doc.status === 'pending' || doc.status === 'processing';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface KnowledgeDocuments {
  documents: KnowledgeDocument[];
  loading: boolean;
  /** The last list read failed; cleared by the next one that succeeds. */
  loadError: string | null;
  /** Failures of the owner's actions, one line each, until dismissed. */
  actionErrors: string[];
  dismissErrors: () => void;
  /** Uploads the files one by one, collecting every failure, then re-reads the list once. */
  uploadBatch: (files: File[], kind: DocumentKind) => Promise<void>;
  /**
   * Uploads `file` as the new version of `previous`, waits until the new
   * document is ready, then deletes `previous`. If the new one fails, the
   * previous one is kept. Identical bytes resolve to the same document,
   * which is then kept as it is.
   */
  replace: (previous: KnowledgeDocument, file: File) => Promise<void>;
  remove: (doc: KnowledgeDocument) => Promise<void>;
  setPrimary: (doc: KnowledgeDocument) => Promise<void>;
}

async function uploadFile(file: File, kind: DocumentKind) {
  const body = new FormData();
  body.append('file', file);
  return parseUpload(
    await apiRequest(`/knowledge/documents?kind=${kind}`, { method: 'POST', body }),
  );
}

/**
 * The owner's documents through the backend's `/knowledge/*` proxy, with
 * live status: while any document is pending or processing, the list is
 * re-read until every one has settled (ready or failed), for at most
 * `POLL_LIMIT_MS`.
 */
export function useKnowledgeDocuments(enabled: boolean): KnowledgeDocuments {
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionErrors, setActionErrors] = useState<string[]>([]);
  const [pollStartedAt, setPollStartedAt] = useState<number | null>(null);
  const [pollKick, setPollKick] = useState(0);
  const mounted = useRef(true);
  /** Only the newest read's answer is applied; an older one arriving late is dropped. */
  const loadSeq = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const docs = parseDocumentList(await apiRequest('/knowledge/documents'));
      if (!mounted.current || seq !== loadSeq.current) return;
      setDocuments(docs);
      setLoadError(null);
    } catch (err) {
      if (!mounted.current || seq !== loadSeq.current) return;
      setLoadError(errorMessage(err, 'Failed to load documents'));
    } finally {
      if (mounted.current && seq === loadSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  // The polling window opens when work appears or the owner acts (`pollKick`),
  // and closes once everything has settled.
  const inFlight = documents.some(isInFlight);
  useEffect(() => {
    setPollStartedAt(inFlight ? Date.now() : null);
  }, [inFlight, pollKick]);

  // A recursive timeout rather than an interval: the next read is scheduled
  // only after the previous one has finished, so reads never overlap.
  useEffect(() => {
    if (!enabled || pollStartedAt === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (cancelled || Date.now() - pollStartedAt > POLL_LIMIT_MS) return;
      await load();
      if (!cancelled) timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };
    timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, pollStartedAt, load]);

  const report = useCallback((message: string) => {
    if (mounted.current) setActionErrors((errors) => [...errors, message]);
  }, []);

  const uploadBatch = useCallback(
    async (files: File[], kind: DocumentKind) => {
      // One at a time: the service ingests serially anyway.
      for (const file of files) {
        try {
          await uploadFile(file, kind);
        } catch (err) {
          report(`${file.name}: ${errorMessage(err, 'Upload failed')}`);
        }
      }
      setPollKick((n) => n + 1);
      await load();
    },
    [load, report],
  );

  /**
   * Waits until the document settles; null when it is still in flight at the
   * limit. Bounded by the deadline only, not by the page staying open: a
   * replace keeps going after the owner navigates away.
   */
  const waitUntilSettled = useCallback(async (id: string) => {
    const deadline = Date.now() + POLL_LIMIT_MS;
    while (Date.now() < deadline) {
      const doc = parseDocument(await apiRequest(`/knowledge/documents/${id}`));
      if (!isInFlight(doc)) return doc;
      await sleep(POLL_INTERVAL_MS);
    }
    return null;
  }, []);

  const replace = useCallback(
    async (previous: KnowledgeDocument, file: File) => {
      const name = previous.filename;
      try {
        let uploaded: KnowledgeDocument;
        let deduplicated: boolean;
        try {
          ({ document: uploaded, deduplicated } = await uploadFile(file, previous.kind));
        } catch (err) {
          report(`Replacing ${name}: ${errorMessage(err, 'Upload failed')}. ${name} is unchanged.`);
          return;
        }
        // Same bytes: the service returned this very document, which stays.
        if (uploaded.id === previous.id) return;
        // The bytes are already stored as another document of a different
        // kind (deduplication ignores the kind). Deleting `previous` would,
        // say, leave a resume replaced by a supporting document.
        if (deduplicated && uploaded.kind !== previous.kind) {
          report(
            `Replacing ${name}: this file is already stored as a ${uploaded.kind} document ` +
              `(${uploaded.filename}). ${name} is unchanged.`,
          );
          return;
        }
        // Show the new row with live status while it ingests.
        if (mounted.current) {
          setPollKick((n) => n + 1);
          void load();
        }

        let settled: KnowledgeDocument | null;
        try {
          settled = await waitUntilSettled(uploaded.id);
        } catch (err) {
          report(
            `Replacing ${name}: could not follow ${uploaded.filename} (${errorMessage(err, 'request failed')}). ` +
              `Both versions are kept; delete ${name} once the new one is ready.`,
          );
          return;
        }
        if (settled === null) {
          report(
            `Replacing ${name}: ${uploaded.filename} is still processing. ` +
              `Both versions are kept; delete ${name} once the new one is ready.`,
          );
          return;
        }
        if (settled.status === 'failed') {
          report(
            `Replacing ${name}: ${settled.filename} failed (${settled.error ?? 'unknown error'}). ` +
              `${name} is kept.`,
          );
          return;
        }

        // Issued even if the page has been left: only the UI updates below
        // (report, the final load) depend on it still being mounted.
        try {
          await apiRequest(`/knowledge/documents/${previous.id}`, { method: 'DELETE' });
        } catch (err) {
          report(
            `Replacing ${name}: the new version ${settled.filename} is stored and ready, but ` +
              `${name} could not be deleted (${errorMessage(err, 'request failed')}). It remains; delete it by hand.`,
          );
        }
      } finally {
        if (mounted.current) await load();
      }
    },
    [load, report, waitUntilSettled],
  );

  const remove = useCallback(
    async (doc: KnowledgeDocument) => {
      try {
        await apiRequest(`/knowledge/documents/${doc.id}`, { method: 'DELETE' });
      } catch (err) {
        report(`Deleting ${doc.filename}: ${errorMessage(err, 'Delete failed')}`);
      }
      await load();
    },
    [load, report],
  );

  const setPrimary = useCallback(
    async (doc: KnowledgeDocument) => {
      try {
        parseDocument(
          await apiRequest(`/knowledge/documents/${doc.id}/primary`, { method: 'PUT' }),
        );
      } catch (err) {
        report(`Making ${doc.filename} primary: ${errorMessage(err, 'request failed')}`);
      }
      await load();
    },
    [load, report],
  );

  return {
    documents,
    loading,
    loadError,
    actionErrors,
    dismissErrors: useCallback(() => setActionErrors([]), []),
    uploadBatch,
    replace,
    remove,
    setPrimary,
  };
}
