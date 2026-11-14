import { useRef, useState } from 'react';
import { ACCEPTED_EXTENSIONS, type DocumentStatus, type KnowledgeDocument } from './types';

interface DocumentTableProps {
  documents: KnowledgeDocument[];
  loading: boolean;
  selectedId: string | null;
  onPreview: (doc: KnowledgeDocument) => void;
  onReplace: (doc: KnowledgeDocument, file: File) => Promise<void>;
  onDelete: (doc: KnowledgeDocument) => Promise<void>;
  onSetPrimary: (doc: KnowledgeDocument) => Promise<void>;
}

const STATUS_STYLES: Record<DocumentStatus, string> = {
  pending: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200',
  processing: 'bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-200',
  ready: 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-200',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200',
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The owner's documents with live status, chunk counts and per-row actions. */
export default function DocumentTable({
  documents,
  loading,
  selectedId,
  onPreview,
  onReplace,
  onDelete,
  onSetPrimary,
}: DocumentTableProps) {
  const replaceInput = useRef<HTMLInputElement>(null);
  const [replacing, setReplacing] = useState<KnowledgeDocument | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const withBusy = async (doc: KnowledgeDocument, action: () => Promise<void>) => {
    setBusyId(doc.id);
    try {
      await action();
    } finally {
      setBusyId(null);
    }
  };

  const startReplace = (doc: KnowledgeDocument) => {
    setReplacing(doc);
    replaceInput.current?.click();
  };

  const handleDelete = (doc: KnowledgeDocument) => {
    if (!window.confirm(`Delete ${doc.filename}? Its chunks stop being served immediately.`)) {
      return;
    }
    void withBusy(doc, () => onDelete(doc));
  };

  if (loading) {
    return <p className="text-sm text-gray-500">Loading documents...</p>;
  }

  if (documents.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500 dark:border-gray-600">
        No documents yet. Upload a resume to get started.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <input
        ref={replaceInput}
        type="file"
        accept={ACCEPTED_EXTENSIONS.join(',')}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          const target = replacing;
          e.target.value = '';
          setReplacing(null);
          if (file && target) void withBusy(target, () => onReplace(target, file));
        }}
      />
      <table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-700">
        <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:bg-gray-900/40 dark:text-gray-400">
          <tr>
            <th className="px-4 py-3">Document</th>
            <th className="px-4 py-3">Kind</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3 text-right">Chunks</th>
            <th className="px-4 py-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
          {documents.map((doc) => {
            const busy = busyId === doc.id;
            return (
              <tr
                key={doc.id}
                className={selectedId === doc.id ? 'bg-primary-50/60 dark:bg-primary-900/20' : ''}
              >
                <td className="px-4 py-3">
                  <p className="font-medium text-gray-900 dark:text-white">{doc.filename}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {formatSize(doc.sizeBytes)} · uploaded{' '}
                    {new Date(doc.createdAt).toLocaleString()}
                  </p>
                  {doc.status === 'failed' && doc.error && (
                    <p className="mt-1 text-xs text-red-700 dark:text-red-300">{doc.error}</p>
                  )}
                </td>
                <td className="px-4 py-3 text-gray-700 dark:text-gray-300">
                  {doc.kind === 'resume' ? 'Resume' : 'Supporting'}
                  {doc.isPrimaryResume && (
                    <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-900/50 dark:text-amber-200">
                      Primary
                    </span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_STYLES[doc.status]}`}
                  >
                    {doc.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-gray-700 dark:text-gray-300">
                  {doc.chunkCount}
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap justify-end gap-3 font-medium">
                    {doc.kind === 'resume' && doc.status === 'ready' && !doc.isPrimaryResume && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void withBusy(doc, () => onSetPrimary(doc))}
                        className="text-primary-600 hover:underline disabled:opacity-50"
                      >
                        Make primary
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={doc.status !== 'ready'}
                      onClick={() => onPreview(doc)}
                      className="text-primary-600 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Preview
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => startReplace(doc)}
                      className="text-primary-600 hover:underline disabled:opacity-50"
                    >
                      Replace
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleDelete(doc)}
                      className="text-red-600 hover:underline disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
