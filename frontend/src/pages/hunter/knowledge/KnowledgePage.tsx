import { useState } from 'react';
import { Navigate, useOutletContext } from 'react-router-dom';
import type { HunterOutletContext } from '../HunterLayout';
import DocumentTable from './DocumentTable';
import EvalSetPanel from './EvalSetPanel';
import RiskReview from './RiskReview';
import { useBusyRows, useReplacePicker } from './rowActions';
import SearchPlayground from './SearchPlayground';
import TextPreview from './TextPreview';
import UploadDropzone from './UploadDropzone';
import { useEvalSet } from './useEvalSet';
import { useKnowledgeDocuments } from './useKnowledgeDocuments';

/**
 * The owner's knowledge base: upload, the risk scan's review (#212), the
 * document table with live status, the extracted-text preview, the "ask as a
 * visitor" playground, and the chat eval set (#85). Chat, fitcheck and the job
 * matcher all answer from retrieval over these documents.
 *
 * Owner only. Anyone the backend says is not the owner is sent back to the
 * profiles; the backend answers 403 to their requests regardless.
 */
export default function KnowledgePage() {
  const { knowledgeOwner } = useOutletContext<HunterOutletContext>();
  const knowledge = useKnowledgeDocuments(knowledgeOwner.isOwner === true);
  // Any change to the ready documents may start an eval run, so the set is
  // re-read when one does.
  const readyKey = knowledge.documents
    .filter((d) => d.status === 'ready')
    .map((d) => `${d.id}:${d.updatedAt}`)
    .join(',');
  const evalSet = useEvalSet(knowledgeOwner.isOwner === true, readyKey);
  const [previewId, setPreviewId] = useState<string | null>(null);
  // Shared by the risk review and the table, so a row busy in one is busy in both.
  const rows = useBusyRows();
  const replacePicker = useReplacePicker(knowledge.replace, rows.withBusy);

  if (knowledgeOwner.failed) {
    return (
      <p className="text-sm text-gray-600 dark:text-gray-300">
        Could not check access to the knowledge base. Reload the page to try again.
      </p>
    );
  }
  if (knowledgeOwner.isOwner === null) {
    return <p className="text-sm text-gray-500">Loading...</p>;
  }
  if (!knowledgeOwner.isOwner) {
    return <Navigate to="/hunter/profiles" replace />;
  }

  const previewed = knowledge.documents.find((d) => d.id === previewId) ?? null;

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Knowledge</h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
          The documents the portfolio chat, the fit check and the job matcher answer from. Every
          upload is scanned for anything risky to make public; a flagged document waits for your
          review before it is searchable. When a resume finishes processing, the newest ready resume
          becomes primary. &ldquo;Make primary&rdquo; picks another one until the next resume
          finishes processing.
        </p>
      </section>

      {knowledge.loadError && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/40 dark:text-red-200">
          {knowledge.loadError}
        </p>
      )}

      {knowledge.actionErrors.length > 0 && (
        <div className="flex items-start justify-between gap-3 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/40 dark:text-red-200">
          <ul className="list-disc space-y-1 pl-5">
            {knowledge.actionErrors.map((message, i) => (
              <li key={i}>{message}</li>
            ))}
          </ul>
          <button type="button" onClick={knowledge.dismissErrors} className="font-medium underline">
            Dismiss
          </button>
        </div>
      )}

      <UploadDropzone onUploadBatch={knowledge.uploadBatch} />

      {replacePicker.input}

      <RiskReview
        documents={knowledge.documents}
        onApprove={knowledge.approve}
        onPickReplacement={replacePicker.pick}
        busyIds={rows.busyIds}
        withBusy={rows.withBusy}
      />

      <section className="space-y-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Documents</h3>
        <DocumentTable
          documents={knowledge.documents}
          loading={knowledge.loading}
          selectedId={previewId}
          onPreview={(doc) => setPreviewId(doc.id)}
          onPickReplacement={replacePicker.pick}
          busyIds={rows.busyIds}
          withBusy={rows.withBusy}
          onDelete={async (doc) => {
            await knowledge.remove(doc);
            if (doc.id === previewId) setPreviewId(null);
          }}
          onSetPrimary={knowledge.setPrimary}
        />
      </section>

      {previewed && <TextPreview doc={previewed} onClose={() => setPreviewId(null)} />}

      <SearchPlayground />

      <EvalSetPanel evalSet={evalSet} />
    </div>
  );
}
