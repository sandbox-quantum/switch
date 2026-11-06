import { describe, expect, it } from 'vitest';
import {
  agentFolder,
  CLOUD_FILES_CODES,
  cloudFilesMessage,
  looksLikeText,
  previewKind,
  safeSuggestedName,
  showsCloudFiles,
  videoTypeFromBytes,
  zipSuggestedName,
} from './cloud-files';

describe('previewKind', () => {
  it('shows the four safe image types as images', () => {
    expect(previewKind('a.png', 10)).toEqual({ kind: 'image', mimeType: 'image/png' });
    expect(previewKind('a.JPG', 10)).toEqual({ kind: 'image', mimeType: 'image/jpeg' });
    expect(previewKind('a.jpeg', 10)).toEqual({ kind: 'image', mimeType: 'image/jpeg' });
    expect(previewKind('a.gif', 10)).toEqual({ kind: 'image', mimeType: 'image/gif' });
    expect(previewKind('a.webp', 10)).toEqual({ kind: 'image', mimeType: 'image/webp' });
  });

  it('never previews HTML, SVG, XHTML or PDF: download only', () => {
    for (const name of ['page.html', 'page.htm', 'art.svg', 'x.xhtml', 'doc.pdf', 'app.command'])
      expect(previewKind(name, 10)).toEqual({ kind: 'download', reason: 'type' });
  });

  it('plays mp4 and webm, up to the 25 MB file cap', () => {
    expect(previewKind('clip.mp4', 10)).toEqual({ kind: 'video', mimeType: 'video/mp4' });
    expect(previewKind('clip.WEBM', 10)).toEqual({ kind: 'video', mimeType: 'video/webm' });
    expect(previewKind('clip.mp4', 25 * 1024 * 1024 + 1)).toEqual({
      kind: 'download',
      reason: 'too_large',
    });
    for (const name of ['clip.mov', 'clip.avi', 'song.mp3'])
      expect(previewKind(name, 10)).toEqual({ kind: 'download', reason: 'type' });
  });

  it('tells Markdown, JSON, CSV, code and plain text apart', () => {
    expect(previewKind('readme.md', 10)).toEqual({ kind: 'markdown' });
    expect(previewKind('data.json', 10)).toEqual({ kind: 'json' });
    expect(previewKind('menu.csv', 10)).toEqual({ kind: 'csv', delimiter: ',' });
    expect(previewKind('menu.tsv', 10)).toEqual({ kind: 'csv', delimiter: '\t' });
    expect(previewKind('main.py', 10)).toEqual({ kind: 'code', language: 'python' });
    expect(previewKind('app.tsx', 10)).toEqual({ kind: 'code', language: 'tsx' });
    expect(previewKind('Dockerfile', 10)).toEqual({ kind: 'code', language: 'docker' });
    expect(previewKind('notes.txt', 10)).toEqual({ kind: 'text' });
    expect(previewKind('README', 10)).toEqual({ kind: 'text' });
    expect(previewKind('.gitignore', 10)).toEqual({ kind: 'text' });
  });

  it('a text file over 1 MB, or an image over 10 MB, is too large to preview', () => {
    for (const [name, size] of [
      ['big.txt', 1024 * 1024 + 1],
      ['big.md', 1024 * 1024 + 1],
      ['big.json', 1024 * 1024 + 1],
      ['big.png', 10 * 1024 * 1024 + 1],
    ] as const)
      expect(previewKind(name, size)).toEqual({ kind: 'download', reason: 'too_large' });
  });

  it('an unknown type is download only, however small', () => {
    expect(previewKind('data.bin', 10)).toEqual({ kind: 'download', reason: 'type' });
    expect(previewKind('noextension', 10)).toEqual({ kind: 'download', reason: 'type' });
  });
});

describe('videoTypeFromBytes', () => {
  const mp4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2]);
  const html = new TextEncoder().encode('<!doctype html><script>');

  it('plays only bytes that match the extension’s type', () => {
    expect(videoTypeFromBytes(mp4, 'video/mp4')).toBe('video/mp4');
    expect(videoTypeFromBytes(webm, 'video/webm')).toBe('video/webm');
    expect(videoTypeFromBytes(webm, 'video/mp4')).toBeNull();
    expect(videoTypeFromBytes(mp4, 'video/webm')).toBeNull();
    expect(videoTypeFromBytes(html, 'video/mp4')).toBeNull();
    expect(videoTypeFromBytes(mp4, 'text/html')).toBeNull();
    expect(videoTypeFromBytes(new Uint8Array(3), 'video/webm')).toBeNull();
  });
});

describe('looksLikeText', () => {
  it('is text only without NUL and as valid UTF-8', () => {
    expect(looksLikeText(new TextEncoder().encode('hello – world'))).toBe(true);
    expect(looksLikeText(new Uint8Array([104, 0, 105]))).toBe(false);
    expect(looksLikeText(new Uint8Array([0xff, 0xfe, 0xfd]))).toBe(false);
  });
});

describe('safeSuggestedName', () => {
  it('keeps the base name only, with nothing that could escape or hide it', () => {
    expect(safeSuggestedName('report.pdf', 'file')).toBe('report.pdf');
    expect(safeSuggestedName('../x', 'file')).toBe('x');
    expect(safeSuggestedName('a/b', 'file')).toBe('b');
    expect(safeSuggestedName('a\\b.txt', 'file')).toBe('b.txt');
    expect(safeSuggestedName('.bashrc', 'file')).toBe('bashrc');
    expect(safeSuggestedName('bad\r\nname.txt', 'file')).toBe('badname.txt');
    expect(safeSuggestedName('nul\u0000.txt', 'file')).toBe('nul.txt');
  });

  it('falls back when nothing is left', () => {
    expect(safeSuggestedName('', 'file')).toBe('file');
    expect(safeSuggestedName('...', 'file')).toBe('file');
    expect(safeSuggestedName('/', 'file')).toBe('file');
    expect(zipSuggestedName('dist')).toBe('dist.zip');
    expect(zipSuggestedName('')).toBe('files.zip');
    expect(zipSuggestedName('..')).toBe('files.zip');
  });
});

describe('showsCloudFiles', () => {
  const on = { flagsReadOk: true, hostedV2: true, cloudFiles: true, hasHostedAgent: true };

  it('shows only with a good read, v2 on, the feature on and a hosted agent', () => {
    expect(showsCloudFiles(on)).toBe(true);
    expect(showsCloudFiles({ ...on, flagsReadOk: false })).toBe(false);
    expect(showsCloudFiles({ ...on, hostedV2: false })).toBe(false);
    expect(showsCloudFiles({ ...on, cloudFiles: false })).toBe(false);
    expect(showsCloudFiles({ ...on, hasHostedAgent: false })).toBe(false);
  });
});

describe('cloudFilesMessage', () => {
  it('has a plain message for every code, with no path in it', () => {
    for (const code of [...CLOUD_FILES_CODES, 'unreachable', 'unknown'] as const) {
      const message = cloudFilesMessage(code);
      expect(message.length).toBeGreaterThan(5);
      expect(message).not.toMatch(/\/|data|agents|workspaces/);
    }
  });

  it('files_elsewhere and unreachable read as a try-again', () => {
    expect(cloudFilesMessage('unreachable')).toBe('Couldn’t reach your cloud. Try again.');
    expect(cloudFilesMessage('files_elsewhere')).toBe(cloudFilesMessage('unreachable'));
  });
});

describe('agentFolder', () => {
  const entries = [
    {
      name: 'web',
      kind: 'folder' as const,
      size: 0,
      mtime: 1,
      label: 'Web Frontend',
      agent: 'web-frontend',
    },
    { name: 'shared', kind: 'folder' as const, size: 0, mtime: 1, label: 'Shared' },
    { name: 'notes.txt', kind: 'file' as const, size: 1, mtime: 1, agent: 'stray' },
  ];

  it('finds the folder by the agent key, not the display label', () => {
    expect(agentFolder(entries, 'web-frontend')?.name).toBe('web');
    expect(agentFolder(entries, 'Web Frontend')).toBeNull();
  });

  it('never picks Shared or a file', () => {
    expect(agentFolder(entries, 'Shared')).toBeNull();
    expect(agentFolder(entries, 'stray')).toBeNull();
  });
});
