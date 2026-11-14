import { useRef, useState } from 'react';
import { ACCEPTED_EXTENSIONS, isAcceptedFile, type DocumentKind } from './types';

interface UploadDropzoneProps {
  /**
   * Uploads the files, reporting each failure itself; resolves once the
   * service has accepted or refused every one (ingestion continues).
   */
  onUploadBatch: (files: File[], kind: DocumentKind) => Promise<void>;
}

/** Drag-and-drop (or browse) upload for pdf, md and txt files. */
export default function UploadDropzone({ onUploadBatch }: UploadDropzoneProps) {
  const [kind, setKind] = useState<DocumentKind>('supporting');
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);

  const handleFiles = async (list: FileList | null) => {
    // One batch at a time; a drop during an upload is ignored.
    if (uploading || !list || list.length === 0) return;
    const files = Array.from(list);
    setRejected(files.filter((f) => !isAcceptedFile(f)).map((f) => f.name));
    const accepted = files.filter(isAcceptedFile);
    if (accepted.length === 0) return;

    setUploading(true);
    try {
      await onUploadBatch(accepted, kind);
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Upload</h3>
        <fieldset className="flex items-center gap-4 text-sm text-gray-700 dark:text-gray-300">
          <legend className="sr-only">Document kind</legend>
          {(['supporting', 'resume'] as const).map((value) => (
            <label key={value} className="flex items-center gap-1.5">
              <input
                type="radio"
                name="knowledge-kind"
                value={value}
                checked={kind === value}
                onChange={() => setKind(value)}
              />
              {value === 'resume' ? 'Resume' : 'Supporting document'}
            </label>
          ))}
        </fieldset>
      </div>

      <div
        role="button"
        tabIndex={0}
        aria-label="Upload files"
        aria-disabled={uploading}
        onClick={() => {
          if (!uploading) input.current?.click();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (!uploading) input.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void handleFiles(e.dataTransfer.files);
        }}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 text-center text-sm transition ${
          dragging
            ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
            : 'border-gray-300 hover:border-primary-400 dark:border-gray-600'
        }`}
      >
        <p className="font-medium text-gray-800 dark:text-gray-100">
          {uploading ? 'Uploading...' : 'Drop files here or click to browse'}
        </p>
        <p className="mt-1 text-gray-500 dark:text-gray-400">
          {ACCEPTED_EXTENSIONS.join(', ')}. Identical files are recognised and not stored twice.
        </p>
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPTED_EXTENSIONS.join(',')}
          className="hidden"
          onChange={(e) => void handleFiles(e.target.files)}
        />
      </div>

      {rejected.length > 0 && (
        <p className="mt-3 text-sm text-amber-700 dark:text-amber-300">
          Skipped (not pdf, md or txt): {rejected.join(', ')}
        </p>
      )}
    </section>
  );
}
