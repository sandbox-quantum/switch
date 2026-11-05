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
/** The largest text or Markdown file shown in the page. */
export const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;
/** The largest image shown in the page. */
export const IMAGE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

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

export type PreviewKind = { kind: "image"; mimeType: string } | { kind: "text" } | { kind: "download" };

function extensionOf(name: string): string {
  const base = name.toLowerCase();
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return base.startsWith(".") ? base.slice(1) : "";
  return base.slice(dot + 1);
}

/**
 * How the page shows a file, from its name and size: one of the four safe
 * image types, plain text (code and Markdown included; Markdown is not
 * rendered in Switch web v1), or download only.
 */
export function previewKind(name: string, size: number): PreviewKind {
  const extension = extensionOf(name);
  const image = IMAGE_EXTENSIONS[extension];
  if (image) return size <= IMAGE_PREVIEW_MAX_BYTES ? { kind: "image", mimeType: image } : { kind: "download" };
  if (size > TEXT_PREVIEW_MAX_BYTES) return { kind: "download" };
  if (TEXT_EXTENSIONS.has(extension) || (extension === "" && TEXT_NAMES.has(name.toLowerCase())))
    return { kind: "text" };
  return { kind: "download" };
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

/** Folders first, then files, by name; at the top level, agent folders before Shared. */
export function sortEntries(entries: readonly CloudFileEntry[], topLevel: boolean): CloudFileEntry[] {
  const rank = (entry: CloudFileEntry) =>
    entry.kind === "file" ? 2 : topLevel && entry.agent === undefined ? 1 : 0;
  return [...entries].sort(
    (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
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
