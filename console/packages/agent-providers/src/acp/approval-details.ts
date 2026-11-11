interface Paths {
  values: string[];
  incomplete: boolean;
}

/** Only path metadata is retained; arbitrary input and file contents are not. */
export interface ApprovalPaths {
  kind?: string;
  kindConflict?: boolean;
  writeFileTitle?: boolean;
  locations?: Paths;
  diffs?: Paths;
  input?: Paths;
  hasInput?: boolean;
  hasContent?: boolean;
  hasMcpIdentity?: boolean;
  hasNonFileIdentity?: boolean;
}

const PATH_LIMIT = 16;
const PATH_LENGTH_LIMIT = 4096;
// Neutral room renderers give detail at most a quarter of the available card.
// Reserve space for mentions and platform escaping; omit whole paths, not parts.
const DETAIL_RENDER_BUDGET = 320;

/** Upper-bound common bridge markup escaping, with extra room for punctuation. */
function renderCost(text: string): number {
  let cost = 0;
  for (const character of text) cost += /[A-Za-z0-9 /.:\n-]/.test(character) ? 1 : 12;
  return cost;
}

/** A Markdown backslash before punctuation can disappear when rendered. */
function hasAmbiguousBackslash(path: string): boolean {
  for (let index = 0; index + 1 < path.length; index++) {
    if (path[index] !== '\\') continue;
    const next = path.charCodeAt(index + 1);
    if (
      (next >= 33 && next <= 47) ||
      (next >= 58 && next <= 64) ||
      (next >= 91 && next <= 96) ||
      (next >= 123 && next <= 126)
    )
      return true;
  }
  return false;
}

function paths(values: unknown[]): Paths {
  const result: Paths = { values: [], incomplete: false };
  for (const value of values) {
    if (
      typeof value !== 'string' ||
      !value ||
      value.length > PATH_LENGTH_LIMIT ||
      !(value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) ||
      value.startsWith(' ') ||
      value.endsWith(' ') ||
      / {2}/.test(value) ||
      hasAmbiguousBackslash(value) ||
      /[<>*_~`]/.test(value) ||
      /\p{Default_Ignorable_Code_Point}/u.test(value) ||
      /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/.test(value) ||
      /[a-z][a-z\d+.-]*:\/\//i.test(value)
    ) {
      result.incomplete = true;
      continue;
    }
    if (result.values.includes(value)) continue;
    if (result.values.length >= PATH_LIMIT) {
      result.incomplete = true;
      continue;
    }
    result.values.push(value);
  }
  return result;
}

/** ACP tool-call updates are partial: missing and null fields retain their prior values. */
export function mergeApprovalPaths(
  prior: ApprovalPaths,
  update: {
    kind?: unknown;
    title?: unknown;
    locations?: unknown;
    content?: unknown;
    rawInput?: unknown;
  }
): ApprovalPaths {
  const next = { ...prior };
  if (update.kind != null) {
    if (typeof update.kind !== 'string') next.kindConflict = true;
    else if (next.kind === undefined || next.kind === 'other') next.kind = update.kind;
    else if (next.kind !== update.kind) next.kindConflict = true;
  }
  if (typeof update.title === 'string') next.writeFileTitle = update.title === 'Write File';
  if (update.locations != null) {
    next.locations =
      isFileApproval(next) && Array.isArray(update.locations)
        ? paths(
            update.locations.map((location: unknown) =>
              typeof location === 'object' && location !== null && 'path' in location
                ? location.path
                : undefined
            )
          )
        : { values: [], incomplete: true };
  }
  if (update.content != null) {
    next.hasContent = true;
    next.diffs =
      isFileApproval(next) && Array.isArray(update.content)
        ? paths(
            update.content.flatMap((part: unknown) =>
              typeof part === 'object' && part !== null && 'type' in part && part.type === 'diff'
                ? ['path' in part ? part.path : undefined]
                : []
            )
          )
        : { values: [], incomplete: true };
  }
  if (update.rawInput != null) {
    next.hasInput = true;
    const input = update.rawInput;
    if (isFileApproval(next) && typeof input === 'object' && !Array.isArray(input)) {
      const record = input as Record<string, unknown>;
      next.input = paths(
        ['path', 'file_path', 'filePath'].filter((key) => key in record).map((key) => record[key])
      );
    } else next.input = { values: [], incomplete: true };
  }
  return next;
}

/** Only the observed Kiro file-write title is handled; a conflicting kind fails closed. */
export function isFileApproval(snapshot: ApprovalPaths): boolean {
  return (
    !snapshot.kindConflict &&
    snapshot.writeFileTitle === true &&
    (snapshot.kind === undefined || snapshot.kind === 'edit')
  );
}

/** Approval details can be posted to a room: do not include contents or arbitrary input. */
export function formatApprovalPaths(snapshot: ApprovalPaths): string {
  const reports = [snapshot.locations, snapshot.diffs, snapshot.input];
  const values = [...new Set(reports.flatMap((report) => report?.values ?? []))];
  const warning =
    snapshot.hasInput || snapshot.hasContent
      ? 'Other input and file contents are not displayed in this approval. Decline if needed.'
      : 'Input and file contents were not provided in this approval. Decline if needed.';
  const multiple = 'Multiple paths reported; verify all.';
  const omittedWarning = 'Some paths omitted from this approval.';
  const heading = 'Reported paths:';
  // Reserve the omission warning even when every path happens to fit.
  const fixed = [warning, ...(values.length > 1 ? [multiple] : []), omittedWarning, heading].join(
    '\n'
  );
  const rendered: string[] = [];
  let used = renderCost(fixed);
  let omitted = reports.some((report) => report?.incomplete);
  for (const value of values) {
    // Keep the path literal for Console; each bridge escapes its own markup.
    const line = `- ${value}`;
    const cost = renderCost(`\n${line}`);
    if (used + cost > DETAIL_RENDER_BUDGET) {
      omitted = true;
      continue;
    }
    rendered.push(line);
    used += cost;
  }
  const lines = [warning];
  if (values.length > 1) lines.push(multiple);
  if (omitted) lines.push(omittedWarning);
  lines.push(rendered.length ? heading : 'No paths shown.');
  lines.push(...rendered);
  return lines.join('\n');
}
