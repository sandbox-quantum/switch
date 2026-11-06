/**
 * Your cloud files in Switch web: the pure rules, the same as Console's
 * (`console/.../shared/core/cloud-files/cloud-files.ts`), so both apps show a
 * box's files the same way. Read-only; nothing here changes a file.
 */

/** One entry of a folder listing, as Core answers it. */
export interface CloudFileEntry {
  name: string;
  kind: "file" | "folder";
  size: number;
  /** When it last changed, as epoch milliseconds. */
  mtime: number;
  /** A cache folder shown closed: "large folder, open anyway?". */
  collapsed?: boolean;
  /** On a top-level folder: the agent's label, or "Shared". For display only. */
  label?: string;
  /** On a top-level folder that belongs to one agent: its definition name. View files matches on this. */
  agent?: string;
}

/** The fixed codes Core answers with. Never a path. */
export const CLOUD_FILES_CODES = [
  "no_files",
  "box_resting",
  "files_elsewhere",
  "bad_path",
  "bad_request",
  "denied",
  "outside_root",
  "not_found",
  "too_large",
  "not_regular",
  "busy",
  "timeout",
  "bad_reply",
  "failed",
] as const;

export type CloudFilesCode = (typeof CLOUD_FILES_CODES)[number] | "unreachable" | "unknown";

/** What the person reads for each code: plain words, never a path or the server's own text. */
export function cloudFilesMessage(code: CloudFilesCode): string {
  switch (code) {
    case "no_files":
      return "There are no cloud files to show for this account.";
    case "box_resting":
      return "Your cloud is resting.";
    case "files_elsewhere":
    case "unreachable":
      return "Couldn’t reach your cloud. Try again.";
    case "bad_path":
    case "bad_request":
      return "That file or folder name can’t be opened here.";
    case "denied":
    case "outside_root":
      return "That file or folder isn’t available here.";
    case "not_found":
      return "That file or folder isn’t there any more.";
    case "too_large":
      return "That’s too large to open here.";
    case "not_regular":
      return "That isn’t a file or folder that can be opened.";
    case "busy":
      return "Your cloud is busy. Try again in a moment.";
    case "timeout":
      return "Your cloud took too long to answer. Try again.";
    case "bad_reply":
    case "failed":
    case "unknown":
      return "Something went wrong reading your cloud files. Try again.";
  }
}

/** A refusal or failure from the cloud-files routes, by code only. */
export class CloudFilesError extends Error {
  constructor(
    readonly code: CloudFilesCode,
    readonly status?: number,
  ) {
    super(cloudFilesMessage(code));
    this.name = "CloudFilesError";
  }
}

/** The largest file Core reads: 25 MB. */
export const CLOUD_FILE_MAX_BYTES = 25 * 1024 * 1024;
/** How long a download's Blob address is kept after the click: some Safari versions cancel the download otherwise. */
export const DOWNLOAD_REVOKE_MS = 5_000;
/** The largest text or Markdown file shown in the page. */
export const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;
/** The largest image shown in the page. */
export const IMAGE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
/** The largest video played in the page: Core's own file cap, since it's fetched whole. */
export const VIDEO_PREVIEW_MAX_BYTES = CLOUD_FILE_MAX_BYTES;
/** Code larger than this shows as plain text, without highlighting. */
export const HIGHLIGHT_MAX_BYTES = 200 * 1024;

/** Video types played inline, by extension. The bytes must match too (see `videoTypeFromBytes`). */
const VIDEO_EXTENSIONS: Record<string, "video/mp4" | "video/webm"> = { mp4: "video/mp4", webm: "video/webm" };

/** Code highlighted in the preview, by extension or plain name, as the highlighter's language. */
export const CODE_LANGUAGES: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp", php: "php",
  sh: "bash", bash: "bash", zsh: "bash", sql: "sql", css: "css", scss: "scss", less: "less",
  yaml: "yaml", yml: "yaml", toml: "toml", ini: "ini", xml: "markup", vue: "markup", svelte: "markup",
  jsonl: "json", dockerfile: "docker", makefile: "makefile",
};

/** The four image types shown inline. Never SVG. */
const IMAGE_EXTENSIONS: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const SAFE_IMAGE_TYPES = new Set(Object.values(IMAGE_EXTENSIONS));

/** Text and code shown as plain text. HTML, SVG and XHTML are deliberately not here. */
const TEXT_EXTENSIONS = new Set([
  "txt", "log", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "ini", "cfg", "conf",
  "env", "xml", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt",
  "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "sql", "css",
  "scss", "less", "vue", "svelte", "lock", "gitignore", "dockerfile", "makefile", "md",
  "markdown",
]);
const TEXT_NAMES = new Set(["readme", "license", "makefile", "dockerfile", "procfile"]);

/** Why a file is download only: a type never previewed, or over its preview size. */
export type NoPreviewReason = "type" | "too_large";

export type PreviewKind =
  | { kind: "image"; mimeType: string }
  | { kind: "video"; mimeType: "video/mp4" | "video/webm" }
  | { kind: "markdown" }
  | { kind: "json" }
  | { kind: "csv"; delimiter: "," | "\t" }
  | { kind: "code"; language: string }
  | { kind: "text" }
  | { kind: "download"; reason: NoPreviewReason };

function extensionOf(name: string): string {
  const base = name.toLowerCase();
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return base.startsWith(".") ? base.slice(1) : "";
  return base.slice(dot + 1);
}

/**
 * How the page shows a file, from its name and size: one of the four safe
 * image types, mp4 or webm video, Markdown, JSON, CSV, highlighted code, plain
 * text, or download only. HTML, SVG, PDF and anything unknown are download
 * only (`type`), and so is anything over its preview size (`too_large`).
 */
export function previewKind(name: string, size: number): PreviewKind {
  const extension = extensionOf(name);
  const image = IMAGE_EXTENSIONS[extension];
  if (image) return size <= IMAGE_PREVIEW_MAX_BYTES ? { kind: "image", mimeType: image } : { kind: "download", reason: "too_large" };
  const video = VIDEO_EXTENSIONS[extension];
  if (video) return size <= VIDEO_PREVIEW_MAX_BYTES ? { kind: "video", mimeType: video } : { kind: "download", reason: "too_large" };
  const plainName = extension === "" && TEXT_NAMES.has(name.toLowerCase());
  if (!TEXT_EXTENSIONS.has(extension) && !plainName) return { kind: "download", reason: "type" };
  if (size > TEXT_PREVIEW_MAX_BYTES) return { kind: "download", reason: "too_large" };
  if (extension === "md" || extension === "markdown") return { kind: "markdown" };
  if (extension === "json") return { kind: "json" };
  if (extension === "csv") return { kind: "csv", delimiter: "," };
  if (extension === "tsv") return { kind: "csv", delimiter: "\t" };
  const language = CODE_LANGUAGES[plainName ? name.toLowerCase() : extension];
  if (language) return { kind: "code", language };
  return { kind: "text" };
}

/**
 * A video's type, only when its opening bytes match its extension's type: an
 * mp4 has `ftyp` at byte 4, a webm starts with the EBML header 1A 45 DF A3.
 * Anything else is null, and is offered for download instead.
 */
export function videoTypeFromBytes(bytes: Uint8Array, mimeType: string): "video/mp4" | "video/webm" | null {
  if (mimeType === "video/mp4")
    return bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
      ? "video/mp4"
      : null;
  if (mimeType === "video/webm")
    return bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3
      ? "video/webm"
      : null;
  return null;
}

/** The type a file's bytes are kept under in the page: a safe image type as itself, anything else bytes only. */
export function blobType(mimeType: string): string {
  const base = (mimeType.split(";")[0] ?? "").trim().toLowerCase();
  return SAFE_IMAGE_TYPES.has(base) ? base : "application/octet-stream";
}

/** Whether bytes meant for a text preview really are text: no NUL, and valid UTF-8. */
export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

// oxlint-disable-next-line no-control-regex -- control characters are what's being removed
const UNSAFE_IN_NAME = /[\u0000-\u001f\u007f/\\]/g;

/** A download's name, from a name the box gave: the base name only, nothing that escapes or hides it. */
export function safeSuggestedName(name: string, fallback: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const cleaned = base.replace(UNSAFE_IN_NAME, "").replace(/^\.+/, "").trim().slice(0, 200);
  return cleaned || fallback;
}

/** A path param the page may open: plain names joined by `/`, no `.`, `..`, empty part, leading slash or NUL. */
export function openablePath(path: unknown): string | null {
  if (typeof path !== "string" || path === "" || path.length > 4096) return null;
  const parts = path.split("/");
  if (parts.length > 64) return null;
  return parts.every((part) => part !== "" && part !== "." && part !== ".." && !part.includes("\0"))
    ? path
    : null;
}

/** The top-level folder View files opens for an agent: the one whose `agent` is its name. */
export function agentFolder(entries: readonly CloudFileEntry[], agentName: string): CloudFileEntry | null {
  return entries.find((entry) => entry.kind === "folder" && entry.agent === agentName) ?? null;
}

/** A box-relative path with one more name on the end. The top level is ''. */
export function childPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/** The folder a path sits in; '' for the top level. */
export function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** The zip button's words: everything at the top level, otherwise the open folder. */
export function zipLabel(path: string): string {
  return path === "" ? "Download all as zip" : "Download folder as zip";
}

/** The folders on the way to `path`, for the breadcrumb. */
export function pathCrumbs(path: string): { name: string; path: string }[] {
  if (!path) return [];
  const parts = path.split("/");
  return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join("/") }));
}

/** A size in the units people read. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** How the open folder's list is sorted: by name, or by when each entry changed, newest first. */
export type EntryOrder = "name" | "changed";

/**
 * By name: folders first, then files; at the top level, agent folders before
 * Shared. By changed: newest first across folders and files, using the times
 * already in the listing (no extra reads), then by name.
 */
export function sortEntries(
  entries: readonly CloudFileEntry[],
  topLevel: boolean,
  order: EntryOrder = "name",
): CloudFileEntry[] {
  const byName = (a: CloudFileEntry, b: CloudFileEntry) =>
    a.name.localeCompare(b.name, undefined, { numeric: true });
  if (order === "changed") return [...entries].sort((a, b) => b.mtime - a.mtime || byName(a, b));
  const rank = (entry: CloudFileEntry) =>
    entry.kind === "file" ? 2 : topLevel && entry.agent === undefined ? 1 : 0;
  return [...entries].sort((a, b) => rank(a) - rank(b) || byName(a, b));
}

/** What the page calls an entry: its label at the top level, otherwise its name. */
export function entryTitle(entry: CloudFileEntry): string {
  return entry.label ?? entry.name;
}

/** Whether the page shows: a good flags read with both flags on, and an agent on a v2 box. */
export function showsCloudFiles(params: {
  hostedV2: boolean;
  cloudFiles: boolean;
  hasHostedAgent: boolean;
}): boolean {
  return params.hostedV2 && params.cloudFiles && params.hasHostedAgent;
}

/** Whether any machine is a v2 box with at least one agent. */
export function hasHostedAgent(
  machines: readonly { backend?: string; agents?: readonly unknown[]; state?: string }[] | null | undefined,
): boolean {
  return (machines ?? []).some(
    (machine) => machine.backend === "box" && machine.state !== "deleted" && (machine.agents?.length ?? 0) > 0,
  );
}
