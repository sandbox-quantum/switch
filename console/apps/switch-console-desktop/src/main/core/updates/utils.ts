function stripMarkupAndTruncate(raw: string): string {
  if (!raw) return 'Unknown update error';

  const withoutData = raw.includes('Data:') ? raw.slice(0, raw.indexOf('Data:')) : raw;
  const noHtml = withoutData.replace(/<!DOCTYPE html.*$/is, '').replace(/<html.*$/is, '');
  const collapsed = noHtml.replace(/\s+/g, ' ').trim();
  if (!collapsed) return 'Unknown update error';
  return collapsed.length > 240 ? `${collapsed.slice(0, 240)}…` : collapsed;
}

export function formatUpdaterError(error: unknown): string {
  const err = error as Error & {
    statusCode?: number;
    code?: string;
    status?: number;
    statusMessage?: string;
    description?: string;
  };
  const status = err.statusCode || err.status;
  const statusText = err.statusMessage || err.description;
  if (status) {
    const base = `Update request failed with HTTP ${status}`;
    return statusText ? `${base}: ${stripMarkupAndTruncate(String(statusText))}` : base;
  }
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown update error');
  // electron-updater's own failures carry an ERR_UPDATER_* code, not an HTTP status.
  return err.code
    ? `${stripMarkupAndTruncate(message)} (${err.code})`
    : stripMarkupAndTruncate(message);
}

export function sanitizeUpdaterLogArgs(args: unknown[]) {
  return args.map((arg) => {
    if (arg instanceof Error) return formatUpdaterError(arg);
    if (typeof arg === 'string') return stripMarkupAndTruncate(arg);
    return arg;
  });
}
