import {
  File,
  FileArchive,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  type LucideIcon,
} from 'lucide-react';
import type { CloudFileEntry } from '@shared/core/cloud-files/cloud-files';

/**
 * What kind of thing a row is, for its icon and colour only: the same eight
 * kinds as Switch web (the shared explorer spec). It comes from the name alone,
 * never from reading the file, and it decides nothing about previewing:
 * `previewKind` still does that, so an SVG or HTML file never renders.
 */
export type FileKind =
  | 'folder'
  | 'markdown'
  | 'code'
  | 'data'
  | 'image'
  | 'video'
  | 'archive'
  | 'other';

const EXTENSIONS: Record<Exclude<FileKind, 'folder' | 'other'>, readonly string[]> = {
  markdown: ['md', 'markdown'],
  code: [
    'js',
    'jsx',
    'ts',
    'tsx',
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
    'html',
    'vue',
    'svelte',
  ],
  data: ['json', 'csv', 'tsv', 'yaml', 'yml', 'toml', 'xml', 'ini', 'env'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'],
  video: ['mp4', 'webm', 'mov', 'mkv', 'avi'],
  archive: ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar'],
};

/** Plain names with no extension that still count as code. */
const CODE_NAMES = new Set(['dockerfile', 'makefile']);

const BY_EXTENSION = new Map<string, FileKind>(
  Object.entries(EXTENSIONS).flatMap(([kind, list]) =>
    list.map((extension) => [extension, kind as FileKind] as const)
  )
);

/** The kind of a file or folder, from its name only. */
export function fileKind(entry: Pick<CloudFileEntry, 'name' | 'kind'>): FileKind {
  if (entry.kind === 'folder') return 'folder';
  const name = entry.name.toLowerCase();
  if (CODE_NAMES.has(name)) return 'code';
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return 'other';
  return BY_EXTENSION.get(name.slice(dot + 1)) ?? 'other';
}

/** Each kind's icon and its soft colour, light and dark (the spec's table). The colour is on the icon only. */
export const FILE_KIND_LOOK: Record<FileKind, { icon: LucideIcon; className: string }> = {
  folder: { icon: Folder, className: 'text-[#B7791F] dark:text-[#F6C453]' },
  markdown: { icon: FileText, className: 'text-[#2B6CB0] dark:text-[#7FB3F5]' },
  code: { icon: FileCode, className: 'text-[#6B46C1] dark:text-[#B794F4]' },
  data: { icon: FileSpreadsheet, className: 'text-[#2C7A7B] dark:text-[#6FD3D0]' },
  image: { icon: FileImage, className: 'text-[#2F855A] dark:text-[#7AD39B]' },
  video: { icon: FileVideo, className: 'text-[#C53030] dark:text-[#F28B8B]' },
  archive: { icon: FileArchive, className: 'text-[#C05621] dark:text-[#F6AD6B]' },
  other: { icon: File, className: 'text-foreground-muted' },
};

/** Each kind in words, read out after a row's name so colour is never the only signal (the spec's table). */
export const FILE_KIND_WORDS: Record<FileKind, string> = {
  folder: 'Folder',
  markdown: 'Markdown file',
  code: 'Code file',
  data: 'Data file',
  image: 'Image',
  video: 'Video',
  archive: 'Archive',
  other: 'File',
};

/** The extensions behind each kind, for the test that pins this table to the spec. */
export const FILE_KIND_EXTENSIONS = EXTENSIONS;
