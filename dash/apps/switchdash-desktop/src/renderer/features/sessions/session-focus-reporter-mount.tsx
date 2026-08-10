import { useEffect } from 'react';
import { startSessionFocusReporter } from './stores/session-focus-reporter';

/** Mounts the focus reporter for the lifetime of the app. Renders nothing. */
export function SessionFocusReporter(): null {
  useEffect(() => startSessionFocusReporter(), []);
  return null;
}
