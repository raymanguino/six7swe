import { useState } from 'react';
import { Navigate, useOutletContext } from 'react-router-dom';
import type { HunterOutletContext } from '../HunterLayout';
import DocumentTable from './DocumentTable';
import SearchPlayground from './SearchPlayground';
import TextPreview from './TextPreview';
import UploadDropzone from './UploadDropzone';
import { useKnowledgeDocuments } from './useKnowledgeDocuments';

/**
 * The owner's knowledge base: upload, the document table with live status,
 * the extracted-text preview and the "ask as a visitor" playground.
 *
 * Owner only. Anyone else is sent back to the profiles; the backend answers
 * 403 to their requests regardless.
 */
export default function KnowledgePage() {
  const { isKnowledgeOwner } = useOutletContext<HunterOutletContext>();
  const knowledge = useKnowledgeDocuments(isKnowledgeOwner === true);
  const [previewId, setPreviewId] = useState<string | null>(null);

  if (isKnowledgeOwner === null) {
    return <p className="text-sm text-gray-500">Loading...</p>;
  }
  if (!isKnowledgeOwner) {
    return <Navigate to="/hunter/profiles" replace />;
  }

  const previewed = knowledge.documents.find((d) => d.id === previewId) ?? null;

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Knowledge</h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
          The documents the portfolio chat and the job matcher answer from. The newest ready resume
          is primary unless you pick another.
        </p>
      </section>

      {knowledge.error && (
        <div className="flex items-start justify-between gap-3 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/40 dark:text-red-200">
          <p>{knowledge.error}</p>
          <button type="button" onClick={knowledge.clearError} className="font-medium underline">
            Dismiss
          </button>
        </div>
      )}

      <UploadDropzone onUpload={knowledge.upload} />

      <section className="space-y-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Documents</h3>
        <DocumentTable
          documents={knowledge.documents}
          loading={knowledge.loading}
          selectedId={previewId}
          onPreview={(doc) => setPreviewId(doc.id)}
          onReplace={knowledge.replace}
          onDelete={async (doc) => {
            await knowledge.remove(doc);
            if (doc.id === previewId) setPreviewId(null);
          }}
          onSetPrimary={knowledge.setPrimary}
        />
      </section>

      {previewed && <TextPreview document={previewed} onClose={() => setPreviewId(null)} />}

      <SearchPlayground />
    </div>
  );
}
