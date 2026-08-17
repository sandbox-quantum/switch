import React from 'react';
import { log } from '@renderer/utils/logger';
import { rpc } from '../ipc';
import { Button } from '../ui/button';

type ErrorBoundaryState = {
  hasError: boolean;
  error: Error | null;
  copyState: CopyState;
};

type ErrorBoundaryProps = {
  children?: React.ReactNode;
};

type CopyState = 'idle' | 'copying' | 'copied' | 'failed';

const COPY_LABEL: Record<CopyState, string> = {
  idle: 'Copy diagnostics',
  copying: 'Collecting…',
  copied: 'Copied to clipboard',
  failed: 'Could not collect diagnostics',
};

/**
 * The crash screen is the user's whole account of a failure that took the app
 * with it, so the raw message stays — demoted out of the lead sentence, but
 * present. What it adds is a way to get the message somewhere else: the text is
 * selectable and the button copies it together with the redacted diagnostic log.
 */
function ErrorFallback({
  message,
  onReload,
  onCopyDiagnostics,
  copyState,
}: {
  message: string;
  onReload: () => void;
  onCopyDiagnostics: () => void;
  copyState: CopyState;
}) {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-background p-6">
      <div className="bg-card text-card-foreground max-w-xl rounded-md border border-border p-6 shadow-sm">
        <h1 className="mb-2 text-lg font-semibold">Switch Console hit an error and stopped</h1>
        <p className="text-muted-foreground mb-4 text-sm">
          Reloading usually recovers it. If it keeps happening, copy the diagnostics and include
          them in a bug report.
        </p>
        <p className="text-muted-foreground mb-4 font-mono text-xs break-all select-text">
          {message}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="default" onClick={onReload}>
            Reload
          </Button>
          <Button
            variant="outline"
            onClick={onCopyDiagnostics}
            disabled={copyState === 'copying' || copyState === 'copied'}
          >
            {COPY_LABEL[copyState]}
          </Button>
        </div>
      </div>
    </div>
  );
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null, copyState: 'idle' };

  static getDerivedStateFromError(error: Error): Pick<ErrorBoundaryState, 'hasError' | 'error'> {
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

  private setCopyState(next: CopyState) {
    this.setState({ copyState: next });
  }

  handleCopyDiagnostics = () => {
    this.setCopyState('copying');
    const error = this.state.error;
    const header = [
      'Switch Console crash report',
      `error: ${error?.name ?? 'Error'}: ${error?.message ?? 'unknown'}`,
      error?.stack ? `stack:\n${error.stack}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    void rpc.app
      .getDiagnosticLogAttachment()
      .then(({ content }) => rpc.app.clipboardWriteText(`${header}\n\n${content}`))
      .then(() => this.setCopyState('copied'))
      // The button reports its own failure rather than looking like it worked;
      // the crash text above is still selectable, so there is a way through.
      .catch(() => this.setCopyState('failed'));
  };

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
    return (
      <ErrorFallback
        message={message}
        onReload={this.handleReload}
        onCopyDiagnostics={this.handleCopyDiagnostics}
        copyState={this.state.copyState}
      />
    );
  }
}
