function stripMarkupAndTruncate(raw: string): string {
  if (!raw) return 'Unknown update error';

  const withoutData = raw.includes('Data:') ? raw.slice(0, raw.indexOf('Data:')) : raw;
  const noHtml = withoutData.replace(/<!DOCTYPE html.*$/is, '').replace(/<html.*$/is, '');
  const collapsed = noHtml.replace(/\s+/g, ' ').trim();
  if (!collapsed) return 'Unknown update error';
  return collapsed.length > 240 ? `${collapsed.slice(0, 240)}…` : collapsed;
}

type UpdaterError = Error & {
  statusCode?: unknown;
  code?: unknown;
  statusMessage?: string;
  description?: string;
};

/**
 * electron-updater's own failures (a feed it cannot parse, a release with no
 * channel file) carry an `ERR_UPDATER_*` code and say what went wrong in the
 * message. Their first line is the sentence; what follows is a stack trace or
 * the feed XML the updater could not read.
 */
function isUpdaterErrorCode(code: unknown): code is string {
  return typeof code === 'string' && code.startsWith('ERR_UPDATER_');
}

/** The error code to log next to a message, so failures can be counted. */
export function updaterErrorCode(error: unknown): string | undefined {
  const code = (error as UpdaterError | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

export function formatUpdaterError(error: unknown): string {
  const err = (error ?? {}) as UpdaterError;
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown update error');

  if (isUpdaterErrorCode(err.code)) {
    return stripMarkupAndTruncate(message.split('\n', 1)[0] ?? '');
  }

  if (typeof err.statusCode === 'number') {
    const base = `Update request failed with HTTP ${err.statusCode}`;
    const statusText = err.statusMessage || err.description;
    return statusText ? `${base}: ${stripMarkupAndTruncate(String(statusText))}` : base;
  }

  return stripMarkupAndTruncate(message);
}

export function sanitizeUpdaterLogArgs(args: unknown[]) {
  return args.map((arg) => {
    if (arg instanceof Error) return formatUpdaterError(arg);
    if (typeof arg === 'string') return stripMarkupAndTruncate(arg);
    return arg;
  });
}
