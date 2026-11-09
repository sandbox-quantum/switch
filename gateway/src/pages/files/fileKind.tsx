// What kind of thing a row is, for its icon and colour only: the same eight
// kinds, extensions, colours and words as Switch Console's `file-kind.ts`
// (the shared explorer spec).
// It comes from the name alone, never from reading the file, and it decides
// nothing about previewing: `previewKind` still does, so an SVG or HTML file
// never renders. Change the spec, then both apps.

import ArticleOutlined from "@mui/icons-material/ArticleOutlined";
import CodeOutlined from "@mui/icons-material/CodeOutlined";
import Folder from "@mui/icons-material/Folder";
import FolderOpen from "@mui/icons-material/FolderOpen";
import FolderZipOutlined from "@mui/icons-material/FolderZipOutlined";
import ImageOutlined from "@mui/icons-material/ImageOutlined";
import InsertDriveFileOutlined from "@mui/icons-material/InsertDriveFileOutlined";
import MovieOutlined from "@mui/icons-material/MovieOutlined";
import TableChartOutlined from "@mui/icons-material/TableChartOutlined";
import type { SvgIconComponent } from "@mui/icons-material";
import type { CloudFileEntry } from "./cloudFiles";

export type FileKind = "folder" | "markdown" | "code" | "data" | "image" | "video" | "archive" | "other";

/** The extensions behind each kind (the spec's table). */
export const FILE_KIND_EXTENSIONS: Readonly<Record<Exclude<FileKind, "folder" | "other">, readonly string[]>> = {
  markdown: ["md", "markdown"],
  code: [
    "js",
    "jsx",
    "ts",
    "tsx",
    "mjs",
    "cjs",
    "py",
    "rb",
    "go",
    "rs",
    "java",
    "kt",
    "swift",
    "c",
    "h",
    "cpp",
    "hpp",
    "cs",
    "php",
    "sh",
    "bash",
    "zsh",
    "sql",
    "css",
    "scss",
    "less",
    "html",
    "vue",
    "svelte",
  ],
  data: ["json", "csv", "tsv", "yaml", "yml", "toml", "xml", "ini", "env"],
  image: ["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp"],
  video: ["mp4", "webm", "mov", "mkv", "avi"],
  archive: ["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar"],
};

/** Plain names with no extension that still count as code. */
export const FILE_KIND_CODE_NAMES: readonly string[] = ["dockerfile", "makefile"];

const BY_EXTENSION = new Map<string, FileKind>(
  Object.entries(FILE_KIND_EXTENSIONS).flatMap(([kind, list]) =>
    list.map((extension) => [extension, kind as FileKind] as const),
  ),
);

/** The kind of a file or folder, from its name only. */
export function fileKind(entry: Pick<CloudFileEntry, "name" | "kind">): FileKind {
  if (entry.kind === "folder") return "folder";
  const name = entry.name.toLowerCase();
  if (FILE_KIND_CODE_NAMES.includes(name)) return "code";
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return "other";
  return BY_EXTENSION.get(name.slice(dot + 1)) ?? "other";
}

/** Each kind's icon and soft colour, light and dark (the spec's table). `null` is the muted text colour. */
export const FILE_KIND_LOOK: Readonly<
  Record<FileKind, { icon: SvgIconComponent; light: string | null; dark: string | null }>
> = {
  folder: { icon: Folder, light: "#B7791F", dark: "#F6C453" },
  markdown: { icon: ArticleOutlined, light: "#2B6CB0", dark: "#7FB3F5" },
  code: { icon: CodeOutlined, light: "#6B46C1", dark: "#B794F4" },
  data: { icon: TableChartOutlined, light: "#2C7A7B", dark: "#6FD3D0" },
  image: { icon: ImageOutlined, light: "#2F855A", dark: "#7AD39B" },
  video: { icon: MovieOutlined, light: "#C53030", dark: "#F28B8B" },
  archive: { icon: FolderZipOutlined, light: "#C05621", dark: "#F6AD6B" },
  other: { icon: InsertDriveFileOutlined, light: null, dark: null },
};

/** Each kind in words, read after a row's name so colour is never the only signal. */
export const FILE_KIND_WORDS: Readonly<Record<FileKind, string>> = {
  folder: "Folder",
  markdown: "Markdown file",
  code: "Code file",
  data: "Data file",
  image: "Image",
  video: "Video",
  archive: "Archive",
  other: "File",
};

/** A row's icon in its kind's soft colour, from the name only. Hidden from screen readers: the name says the kind. */
export function FileKindIcon({
  entry,
  open = false,
}: {
  entry: Pick<CloudFileEntry, "name" | "kind">;
  /** A folder shown open (the one the list is in). */
  open?: boolean;
}) {
  const kind = fileKind(entry);
  const look = FILE_KIND_LOOK[kind];
  const Icon = kind === "folder" && open ? FolderOpen : look.icon;
  return (
    <Icon
      fontSize="small"
      aria-hidden
      data-file-kind={kind}
      // The theme switches schemes through CSS variables, so the dark colour
      // goes in `applyStyles`, not on `palette.mode`.
      sx={(theme) =>
        look.light === null || look.dark === null
          ? { color: "text.secondary" }
          : { color: look.light, ...theme.applyStyles("dark", { color: look.dark }) }
      }
    />
  );
}

/** A row's name for a screen reader, its kind after it: "README.md, Markdown file". */
export function spokenKind(entry: Pick<CloudFileEntry, "name" | "kind">): string {
  return FILE_KIND_WORDS[fileKind(entry)];
}
