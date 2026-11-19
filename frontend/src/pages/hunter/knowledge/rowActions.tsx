import { useCallback, useRef, useState, type ReactElement } from 'react';
import { ACCEPTED_EXTENSIONS, type KnowledgeDocument } from './types';

export interface BusyRows {
  /** Documents with an action in progress; every panel disables that row's actions. */
  busyIds: ReadonlySet<string>;
  /** Marks the document busy for the length of `action`. */
  withBusy: (doc: KnowledgeDocument, action: () => Promise<void>) => Promise<void>;
}

/**
 * One busy state per document, shared by every panel that acts on documents
 * (the table and the risk review), so an action started in one disables the
 * same row's actions in the other. Per row: a replace can run for minutes
 * while other rows stay usable.
 */
export function useBusyRows(): BusyRows {
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const withBusy = useCallback(async (doc: KnowledgeDocument, action: () => Promise<void>) => {
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
  }, []);
  return { busyIds, withBusy };
}

export interface ReplacePicker {
  /** The hidden file input; render it once. */
  input: ReactElement;
  /** Opens the file picker to replace `doc`. */
  pick: (doc: KnowledgeDocument) => void;
}

/** One hidden file input for every panel's "Replace" action. */
export function useReplacePicker(
  onReplace: (doc: KnowledgeDocument, file: File) => Promise<void>,
  withBusy: BusyRows['withBusy'],
): ReplacePicker {
  const ref = useRef<HTMLInputElement>(null);
  const target = useRef<KnowledgeDocument | null>(null);
  const pick = useCallback((doc: KnowledgeDocument) => {
    target.current = doc;
    ref.current?.click();
  }, []);
  const input = (
    <input
      ref={ref}
      type="file"
      accept={ACCEPTED_EXTENSIONS.join(',')}
      className="hidden"
      onChange={(e) => {
        const file = e.target.files?.[0];
        const doc = target.current;
        e.target.value = '';
        target.current = null;
        if (file && doc) void withBusy(doc, () => onReplace(doc, file));
      }}
    />
  );
  return { input, pick };
}
