import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '../../../utils/api';
import type { DocumentKind, KnowledgeDocument, UploadResponse } from './types';

/** How often the list is re-read while any document is still being ingested. */
const POLL_INTERVAL_MS = 2000;

const isInFlight = (doc: KnowledgeDocument) =>
  doc.status === 'pending' || doc.status === 'processing';

const errorMessage = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback;

export interface KnowledgeDocuments {
  documents: KnowledgeDocument[];
  loading: boolean;
  error: string | null;
  clearError: () => void;
  upload: (file: File, kind: DocumentKind) => Promise<UploadResponse | null>;
  /**
   * Uploads `file` as the new version of `previous`, then deletes `previous`.
   * Identical bytes resolve to the same document, which is then kept.
   */
  replace: (previous: KnowledgeDocument, file: File) => Promise<void>;
  remove: (doc: KnowledgeDocument) => Promise<void>;
  setPrimary: (doc: KnowledgeDocument) => Promise<void>;
}

/**
 * The owner's documents through the backend's `/knowledge/*` proxy, with
 * live status: while any document is pending or processing, the list is
 * polled until every one has settled (ready or failed).
 */
export function useKnowledgeDocuments(enabled: boolean): KnowledgeDocuments {
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const data = (await apiRequest('/knowledge/documents')) as {
        documents?: KnowledgeDocument[];
      };
      if (mounted.current) setDocuments(data.documents ?? []);
    } catch (err) {
      if (mounted.current) setError(errorMessage(err, 'Failed to load documents'));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  const polling = documents.some(isInFlight);
  useEffect(() => {
    if (!enabled || !polling) return;
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [enabled, polling, load]);

  const run = useCallback(
    async <T>(action: () => Promise<T>, fallback: string): Promise<T | null> => {
      setError(null);
      try {
        return await action();
      } catch (err) {
        if (mounted.current) setError(errorMessage(err, fallback));
        return null;
      } finally {
        await load();
      }
    },
    [load],
  );

  const uploadFile = (file: File, kind: DocumentKind) => {
    const body = new FormData();
    body.append('file', file);
    return apiRequest(`/knowledge/documents?kind=${kind}`, {
      method: 'POST',
      body,
    }) as Promise<UploadResponse>;
  };

  const upload = useCallback(
    (file: File, kind: DocumentKind) => run(() => uploadFile(file, kind), 'Upload failed'),
    [run],
  );

  const replace = useCallback(
    async (previous: KnowledgeDocument, file: File) => {
      await run(async () => {
        const uploaded = await uploadFile(file, previous.kind);
        // Same bytes: the service returns the existing document, which must not be deleted.
        if (uploaded.document.id === previous.id) return;
        await apiRequest(`/knowledge/documents/${previous.id}`, { method: 'DELETE' });
      }, 'Replace failed');
    },
    [run],
  );

  const remove = useCallback(
    async (doc: KnowledgeDocument) => {
      await run(
        () => apiRequest(`/knowledge/documents/${doc.id}`, { method: 'DELETE' }),
        'Delete failed',
      );
    },
    [run],
  );

  const setPrimary = useCallback(
    async (doc: KnowledgeDocument) => {
      await run(
        () => apiRequest(`/knowledge/documents/${doc.id}/primary`, { method: 'PUT' }),
        'Could not set the primary resume',
      );
    },
    [run],
  );

  return {
    documents,
    loading,
    error,
    clearError: () => setError(null),
    upload,
    replace,
    remove,
    setPrimary,
  };
}
