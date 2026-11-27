import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface State {
  failed: boolean;
}

/**
 * Catches a failed lazy chunk (typically a stale asset after a deploy) so the
 * rest of the app keeps rendering, and offers a reload.
 */
export default class ChunkErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Failed to load part of the app', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="mx-auto max-w-lg p-8 text-center">
        <h1 className="mb-2 text-xl font-bold text-gray-900 dark:text-white">
          This page could not be loaded
        </h1>
        <p className="mb-4 text-sm text-gray-600 dark:text-gray-300">
          The site may have been updated. Reload to get the latest version.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
        >
          Reload
        </button>
      </div>
    );
  }
}
