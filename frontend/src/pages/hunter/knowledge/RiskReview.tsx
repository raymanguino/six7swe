import { useEffect, useRef, useState } from 'react';
import { apiRequest } from '../../../utils/api';
import { errorMessage } from '../../../utils/errorMessage';
import {
  ACCEPTED_EXTENSIONS,
  hasFindingsToReview,
  parseFindings,
  type KnowledgeDocument,
  type RiskCategory,
  type RiskFinding,
} from './types';

interface RiskReviewProps {
  documents: KnowledgeDocument[];
  onApprove: (doc: KnowledgeDocument) => Promise<void>;
  onReplace: (doc: KnowledgeDocument, file: File) => Promise<void>;
}

const CATEGORY_LABELS: Record<RiskCategory, string> = {
  contact_details: 'Contact details',
  home_address: 'Home address',
  compensation: 'Compensation',
  reference_details: 'Reference details',
  confidential: 'Confidential',
  personal_details: 'Personal details',
  credentials: 'Credentials',
  negative_remarks: 'Negative remark',
  other: 'Other',
  scan_failed: 'Scan failed',
};

const SOURCE_LABELS: Record<RiskFinding['source'], string> = {
  pattern: 'pattern check',
  model: 'model',
  scan: 'scan',
};

function location(finding: RiskFinding): string | null {
  const { page, offset } = finding.location;
  if (page !== null) return `page ${page}`;
  if (offset !== null) return `character ${offset}`;
  return null;
}

/** One flagged document's findings, re-read whenever the document changes. */
function Findings({ doc }: { doc: KnowledgeDocument }) {
  const [findings, setFindings] = useState<RiskFinding[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    apiRequest(`/knowledge/documents/${doc.id}/findings`)
      .then((data: unknown) => {
        if (!cancelled) setFindings(parseFindings(data).findings);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err, 'Failed to load the findings'));
      });
    return () => {
      cancelled = true;
    };
  }, [doc.id, doc.updatedAt]);

  if (error) return <p className="text-sm text-red-700 dark:text-red-300">{error}</p>;
  if (findings === null) return <p className="text-sm text-gray-500">Loading findings...</p>;
  return (
    <ul className="space-y-2">
      {findings.map((finding, i) => {
        const where = location(finding);
        return (
          <li key={i} className="rounded-lg bg-gray-50 p-3 text-sm dark:bg-gray-900">
            <p className="font-medium text-gray-900 dark:text-white">
              {CATEGORY_LABELS[finding.category]}
              <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">
                {SOURCE_LABELS[finding.source]}
                {where && ` · ${where}`}
              </span>
            </p>
            {finding.excerpt && (
              <p className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-gray-800 dark:text-gray-200">
                {finding.excerpt}
              </p>
            )}
            <p className="mt-1 text-gray-600 dark:text-gray-300">{finding.reason}</p>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The risk scan's review (#212): the documents it flagged, with their
 * findings. The owner approves a document as it is, or replaces the file
 * (which is scanned again). There is no in-app editing, so the stored file
 * and its searchable text never diverge.
 */
export default function RiskReview({ documents, onApprove, onReplace }: RiskReviewProps) {
  const flagged = documents.filter(hasFindingsToReview);
  const replaceInput = useRef<HTMLInputElement>(null);
  const [replacing, setReplacing] = useState<KnowledgeDocument | null>(null);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());

  if (flagged.length === 0) return null;

  const withBusy = async (doc: KnowledgeDocument, action: () => Promise<void>) => {
    setBusyIds((ids) => new Set(ids).add(doc.id));
    try {
      await action();
    } finally {
      setBusyIds((ids) => {
        const next = new Set(ids);
        next.delete(doc.id);
        return next;
      });
    }
  };

  const handleApprove = (doc: KnowledgeDocument) => {
    const message =
      doc.status === 'needs_review'
        ? `Approve ${doc.filename} as it is? Visitors' chat can then quote everything flagged here.`
        : `Approve ${doc.filename} as it is? It stays searchable, including everything flagged here.`;
    if (!window.confirm(message)) return;
    void withBusy(doc, () => onApprove(doc));
  };

  return (
    <section className="space-y-4">
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
      <div>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Needs review</h3>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
          Everything uploaded is public: the chat answers from it and can quote it. The risk scan
          flagged these documents. A document that needs review is not searchable until you approve
          it; one that was already searchable before the scan keeps serving until you act. To change
          what a document says, edit the file and replace it; it is scanned again.
        </p>
      </div>
      {flagged.map((doc) => {
        const busy = busyIds.has(doc.id);
        return (
          <article
            key={doc.id}
            className="space-y-3 rounded-xl border border-amber-200 bg-white p-4 dark:border-amber-800 dark:bg-gray-800"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-medium text-gray-900 dark:text-white">{doc.filename}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {doc.status === 'needs_review'
                    ? 'Not searchable until approved'
                    : 'Searchable; uploaded before the scan'}
                </p>
              </div>
              <div className="flex gap-3 text-sm font-medium">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => handleApprove(doc)}
                  className="text-primary-600 hover:underline disabled:opacity-50"
                >
                  Approve as is
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setReplacing(doc);
                    replaceInput.current?.click();
                  }}
                  className="text-primary-600 hover:underline disabled:opacity-50"
                >
                  Replace file
                </button>
              </div>
            </div>
            <Findings doc={doc} />
          </article>
        );
      })}
    </section>
  );
}
