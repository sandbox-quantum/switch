import {
  File,
  FileArchive,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
} from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { FILE_KIND_EXTENSIONS, FILE_KIND_LOOK, FILE_KIND_WORDS, fileKind } from './file-kind';

// Pinned to the shared explorer spec (motion and icons, 7 Nov): the same
// eight kinds, extensions and colours as Switch web. Change the spec first,
// then both apps.

const file = (name: string) => ({ name, kind: 'file' as const });

describe('file kinds, as in the shared explorer spec', () => {
  it('maps exactly the spec’s extensions to each kind', () => {
    expect(FILE_KIND_EXTENSIONS).toEqual({
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
    });
  });

  it('gives each kind the spec’s icon and soft colour, light and dark, on the icon only', () => {
    expect(FILE_KIND_LOOK).toEqual({
      folder: { icon: Folder, className: 'text-[#B7791F] dark:text-[#F6C453]' },
      markdown: { icon: FileText, className: 'text-[#2B6CB0] dark:text-[#7FB3F5]' },
      code: { icon: FileCode, className: 'text-[#6B46C1] dark:text-[#B794F4]' },
      data: { icon: FileSpreadsheet, className: 'text-[#2C7A7B] dark:text-[#6FD3D0]' },
      image: { icon: FileImage, className: 'text-[#2F855A] dark:text-[#7AD39B]' },
      video: { icon: FileVideo, className: 'text-[#C53030] dark:text-[#F28B8B]' },
      archive: { icon: FileArchive, className: 'text-[#C05621] dark:text-[#F6AD6B]' },
      other: { icon: File, className: 'text-foreground-muted' },
    });
  });

  it('says each kind in words, so colour is never the only signal', () => {
    expect(FILE_KIND_WORDS).toEqual({
      folder: 'Folder',
      markdown: 'Markdown file',
      code: 'Code file',
      data: 'Data file',
      image: 'Image',
      video: 'Video',
      archive: 'Archive',
      other: 'File',
    });
  });

  it('reads the kind from the name only, by its last extension, in any case', () => {
    expect(fileKind({ name: 'reports', kind: 'folder' })).toBe('folder');
    expect(fileKind({ name: 'archive.zip', kind: 'folder' })).toBe('folder');
    expect(fileKind(file('README.md'))).toBe('markdown');
    expect(fileKind(file('App.TSX'))).toBe('code');
    expect(fileKind(file('Dockerfile'))).toBe('code');
    expect(fileKind(file('orders.csv'))).toBe('data');
    expect(fileKind(file('.env'))).toBe('data');
    expect(fileKind(file('logo.svg'))).toBe('image');
    expect(fileKind(file('demo.MOV'))).toBe('video');
    expect(fileKind(file('backup.tar.gz'))).toBe('archive');
  });

  it('anything else, or no extension, is Other', () => {
    for (const name of [
      'notes.txt',
      'report.pdf',
      'server.log',
      'LICENSE',
      'trailing.',
      'a.b.unknown',
    ])
      expect(fileKind(file(name))).toBe('other');
  });
});
