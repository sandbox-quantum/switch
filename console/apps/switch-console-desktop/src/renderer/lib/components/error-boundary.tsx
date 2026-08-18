import React from 'react';
import { log } from '@renderer/utils/logger';
import { rpc } from '../ipc';
import { Button } from '../ui/button';

type ErrorBoundaryState = {
  hasError: boolean;
  error: Error | null;
};

type ErrorBoundaryProps = {
  children?: React.ReactNode;
};

/**
 * The crash screen is the user's whole account of a failure that took the app
 * with it, so the raw message stays — demoted out of the lead sentence, but
 * present, and selectable so it can be pasted into a bug report.
 */
function ErrorFallback({ message, onReload }: { message: string; onReload: () => void }) {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-background p-6">
      <div className="bg-card text-card-foreground max-w-xl rounded-md border border-border p-6 shadow-sm">
        <h1 className="mb-2 text-lg font-semibold">Switch Console hit an error and stopped</h1>
        <p className="text-muted-foreground mb-4 text-sm">Reloading usually recovers it.</p>
        <p className="text-muted-foreground mb-4 font-mono text-xs break-all select-text">
          {message}
        </p>
        <Button variant="default" onClick={onReload}>
          Reload
        </Button>
      </div>
    </div>
  );
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  /**
   * Without this the crash existed only on screen: React reports it to the
   * console, which is not the file log, so the one failure most worth having a
   * record of left none.
   */
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    log.error('Renderer crashed', {
      event: 'renderer_crash',
      error: { name: error.name, message: error.message, stack: error.stack },
      componentStack: info.componentStack,
    });
  }

  handleReload = () => {
    void rpc.viewState.reset().finally(() => {
      try {
        window.location.reload();
      } catch {}
    });
  };

  render() {
    if (!this.state.hasError) return this.props.children as React.ReactElement;
    const message = this.state.error?.message || 'No further detail was reported.';
    return <ErrorFallback message={message} onReload={this.handleReload} />;
  }
}
