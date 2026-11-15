import { createRoot, type Root } from 'react-dom/client';
import { ErrorFallback, reloadAfterCrash } from './lib/components/error-boundary';
import { describeFailure } from './lib/errors/describe-failure';

/**
 * Bootstrap runs before the app mounts, so nothing else is on screen when it
 * fails: logging alone leaves a blank window, and the error reaches only the
 * log file, which the user has no reason to open (CHOO-3384).
 */
export function renderBootstrapFailure(container: HTMLElement, error: unknown): Root {
  const { headline, detail } = describeFailure(
    error,
    'Reloading may recover it. If it keeps happening, the error below says why.'
  );
  const root = createRoot(container);
  root.render(
    <ErrorFallback
      title="Switch Console could not start"
      hint={headline}
      message={detail ?? 'No further detail was reported.'}
      onReload={reloadAfterCrash}
    />
  );
  return root;
}
