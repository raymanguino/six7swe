import { useEffect, useState } from 'react';
import { apiRequest } from '../../../utils/api';
import { errorMessage } from '../../../utils/errorMessage';
import { parseText, type KnowledgeDocument } from './types';

interface TextPreviewProps {
  doc: KnowledgeDocument;
  onClose: () => void;
}

/** The text the service extracted from a document, as chunking and retrieval see it. */
export default function TextPreview({ doc, onClose }: TextPreviewProps) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiRequest(`/knowledge/documents/${doc.id}/text`)
      .then((data: unknown) => {
        if (!cancelled) setText(parseText(data).text);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err, 'Failed to load the text'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Re-read when the document is re-ingested, not only when another is picked.
  }, [doc.id, doc.updatedAt]);

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
          Extracted text: {doc.filename}
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="text-sm font-medium text-gray-600 hover:underline dark:text-gray-300"
        >
          Close
        </button>
      </div>
      {loading ? (
        <p className="text-sm text-gray-500">Loading text...</p>
      ) : error ? (
        <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
      ) : text === null ? (
        <p className="text-sm text-gray-500">No text has been extracted yet.</p>
      ) : (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-gray-50 p-4 font-mono text-xs text-gray-800 dark:bg-gray-900 dark:text-gray-200">
          {text}
        </pre>
      )}
    </section>
  );
}
