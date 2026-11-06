/**
 * Your cloud files: a read-only view of the person's own box's workspaces
 * (`/data/agents/workspaces`), through Core's owner-only `/gateway/cloud-files`
 * routes. Shared between the main process (which talks to Core and writes
 * downloads to disk) and the renderer (which shows the files).
 */

/** One entry of a folder listing, as Core answers it. */
export type CloudFileEntry = {
  name: string;
  kind: 'file' | 'folder';
  /** Bytes; a folder's is what the box reports for it. */
  size: number;
  /** When it last changed, as epoch milliseconds. */
  mtime: number;
  /** A cache folder (`node_modules`, `.git`…) shown closed: "large folder, open anyway?". */
  collapsed?: boolean;
  /** On a top-level folder only: the agent's label, or "Shared". For display. */
  label?: string;
  /** On a top-level folder that belongs to one agent: that agent's definition name. View files matches on it. */
  agent?: string;
};

/** One page of a folder listing. `cursor` asks for the next page. */
export type CloudFileListing = { entries: CloudFileEntry[]; cursor?: string };

/** The fixed codes Core answers with (engineer-4's v3.1, section 3). Never a path. */
export const CLOUD_FILES_CODES = [
  'no_files',
  'box_resting',
  'files_elsewhere',
  'bad_path',
  'bad_request',
  'denied',
  'outside_root',
  'not_found',
  'too_large',
  'not_regular',
  'busy',
  'timeout',
  'bad_reply',
  'failed',
] as const;

export type CloudFilesCode = (typeof CLOUD_FILES_CODES)[number] | 'unreachable' | 'unknown';

/** What the person reads for each code: plain words, never a path or a server's own text. */
export function cloudFilesMessage(code: CloudFilesCode): string {
  switch (code) {
    case 'no_files':
      return 'There are no cloud files to show for this account.';
    case 'box_resting':
      return 'Your cloud is resting.';
    case 'files_elsewhere':
    case 'unreachable':
      return 'Couldn’t reach your cloud. Try again.';
    case 'bad_path':
    case 'bad_request':
      return 'That file or folder name can’t be opened here.';
    case 'denied':
    case 'outside_root':
      return 'That file or folder isn’t available here.';
    case 'not_found':
      return 'That file or folder isn’t there any more.';
    case 'too_large':
      return 'That’s too large to open here.';
    case 'not_regular':
      return 'That isn’t a file or folder that can be opened.';
    case 'busy':
      return 'Your cloud is busy. Try again in a moment.';
    case 'timeout':
      return 'Your cloud took too long to answer. Try again.';
    case 'bad_reply':
    case 'failed':
    case 'unknown':
      return 'Something went wrong reading your cloud files. Try again.';
  }
}

/** A refusal or failure from the cloud-files routes, by code only. */
export class CloudFilesError extends Error {
  constructor(
    readonly code: CloudFilesCode,
    readonly status?: number
  ) {
    super(cloudFilesMessage(code));
    this.name = 'CloudFilesError';
  }
}

/** The largest file Core reads (v1): 25 MB. */
export const CLOUD_FILE_MAX_BYTES = 25 * 1024 * 1024;
/** One chunk, the same from end to end: 128 KiB. */
export const CLOUD_FILE_CHUNK_BYTES = 128 * 1024;
/** The largest text, code or Markdown file previewed inside Console. */
export const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;
/** The largest image previewed inside Console. */
export const IMAGE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
/** The largest video played inside Console: Core's own file cap, since it's fetched whole. */
export const VIDEO_PREVIEW_MAX_BYTES = CLOUD_FILE_MAX_BYTES;
/** Code larger than this shows as plain text, without highlighting. */
export const HIGHLIGHT_MAX_BYTES = 200 * 1024;

/** Video types played inline, by extension. The bytes must match too (see `videoTypeFromBytes`). */
const VIDEO_EXTENSIONS: Record<string, 'video/mp4' | 'video/webm'> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
};

/** Code highlighted in the preview, by extension or plain name, as the highlighter's language. */
const CODE_LANGUAGES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
  css: 'css',
  scss: 'scss',
  less: 'less',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  xml: 'markup',
  vue: 'markup',
  svelte: 'markup',
  jsonl: 'json',
  dockerfile: 'docker',
  makefile: 'makefile',
};

/** Image types shown inline, by extension. Only the four the chat shows; never SVG. */
const IMAGE_EXTENSIONS: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** Extensions shown as text or code. HTML, SVG and XHTML are deliberately not here. */
const TEXT_EXTENSIONS = new Set([
  'txt',
  'log',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'env',
  'xml',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'php',
  'sh',
  'bash',
  'zsh',
  'sql',
  'css',
  'scss',
  'less',
  'vue',
  'svelte',
  'lock',
  'gitignore',
  'dockerfile',
  'makefile',
]);

/** Plain names with no extension that are text all the same. */
const TEXT_NAMES = new Set(['readme', 'license', 'makefile', 'dockerfile', 'procfile']);

/** Why a file is download only: a type never previewed, or over its preview size. */
export type NoPreviewReason = 'type' | 'too_large';

export type PreviewKind =
  | { kind: 'image'; mimeType: string }
  | { kind: 'video'; mimeType: 'video/mp4' | 'video/webm' }
  | { kind: 'markdown' }
  | { kind: 'json' }
  | { kind: 'csv'; delimiter: ',' | '\t' }
  | { kind: 'code'; language: string }
  | { kind: 'text' }
  | { kind: 'download'; reason: NoPreviewReason };

function extensionOf(name: string): string {
  const base = name.toLowerCase();
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return base.startsWith('.') ? base.slice(1) : '';
  return base.slice(dot + 1);
}

/**
 * How Console shows a file, from its name and size alone: one of the four safe
 * image types, mp4 or webm video, Markdown, JSON, CSV, highlighted code, plain
 * text, or download only. HTML, SVG, PDF and anything unknown are download
 * only (`type`), and so is anything over its preview size (`too_large`).
 */
export function previewKind(name: string, size: number): PreviewKind {
  const extension = extensionOf(name);
  const image = IMAGE_EXTENSIONS[extension];
  if (image)
    return size <= IMAGE_PREVIEW_MAX_BYTES
      ? { kind: 'image', mimeType: image }
      : { kind: 'download', reason: 'too_large' };
  const video = VIDEO_EXTENSIONS[extension];
  if (video)
    return size <= VIDEO_PREVIEW_MAX_BYTES
      ? { kind: 'video', mimeType: video }
      : { kind: 'download', reason: 'too_large' };
  const plainName = extension === '' && TEXT_NAMES.has(name.toLowerCase());
  const isText =
    extension === 'md' || extension === 'markdown' || TEXT_EXTENSIONS.has(extension) || plainName;
  if (!isText) return { kind: 'download', reason: 'type' };
  if (size > TEXT_PREVIEW_MAX_BYTES) return { kind: 'download', reason: 'too_large' };
  if (extension === 'md' || extension === 'markdown') return { kind: 'markdown' };
  if (extension === 'json') return { kind: 'json' };
  if (extension === 'csv') return { kind: 'csv', delimiter: ',' };
  if (extension === 'tsv') return { kind: 'csv', delimiter: '\t' };
  const language = CODE_LANGUAGES[plainName ? name.toLowerCase() : extension];
  if (language) return { kind: 'code', language };
  return { kind: 'text' };
}

/**
 * A video's type, only when its opening bytes match its extension's type: an
 * mp4 has `ftyp` at byte 4, a webm starts with the EBML header 1A 45 DF A3.
 * Anything else is null, and is offered for download instead.
 */
export function videoTypeFromBytes(
  bytes: Uint8Array,
  mimeType: string
): 'video/mp4' | 'video/webm' | null {
  if (mimeType === 'video/mp4')
    return bytes.length >= 12 &&
      bytes[4] === 0x66 &&
      bytes[5] === 0x74 &&
      bytes[6] === 0x79 &&
      bytes[7] === 0x70
      ? 'video/mp4'
      : null;
  if (mimeType === 'video/webm')
    return bytes.length >= 4 &&
      bytes[0] === 0x1a &&
      bytes[1] === 0x45 &&
      bytes[2] === 0xdf &&
      bytes[3] === 0xa3
      ? 'video/webm'
      : null;
  return null;
}

/** Whether bytes meant for a text preview really are text: no NUL, and valid UTF-8. */
export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

const UNSAFE_IN_NAME = /[\u0000-\u001f\u007f/\\]/g;

/**
 * The save dialog's suggested name, from a name the box gave: the base name
 * only, with no slash, backslash, NUL or control character, and no leading
 * dot (so it can't land as a hidden file). Falls back to `fallback`.
 */
export function safeSuggestedName(name: string, fallback: string): string {
  const base = name.split(/[/\\]/).pop() ?? '';
  const cleaned = base.replace(UNSAFE_IN_NAME, '').replace(/^\.+/, '').trim().slice(0, 200);
  return cleaned || fallback;
}

/** The suggested name for a folder's zip. */
export function zipSuggestedName(folderName: string): string {
  const name = safeSuggestedName(folderName, '');
  return name ? `${name}.zip` : 'files.zip';
}

/**
 * Whether Your cloud files shows at all: only from a good flags read that
 * says both `hosted_v2` and `hosted_cloud_files` are on, and only once the
 * person has at least one hosted agent. Anything else hides it, and Console
 * then calls none of its routes.
 */
export function showsCloudFiles(params: {
  flagsReadOk: boolean;
  hostedV2: boolean;
  cloudFiles: boolean;
  hasHostedAgent: boolean;
}): boolean {
  return params.flagsReadOk && params.hostedV2 && params.cloudFiles && params.hasHostedAgent;
}

/** The top-level folder View files opens for an agent: the one whose `agent` is its name. */
export function agentFolder(
  entries: readonly CloudFileEntry[],
  agentName: string
): CloudFileEntry | null {
  return entries.find((entry) => entry.kind === 'folder' && entry.agent === agentName) ?? null;
}

/** Whether the person has at least one hosted agent: an agent on a v2 box. */
export function hasHostedAgent(
  machines: readonly { backend?: 'vm' | 'box'; agents: readonly string[] }[] | null | undefined
): boolean {
  return (machines ?? []).some((machine) => machine.backend === 'box' && machine.agents.length > 0);
}
