import { describe, expect, it } from 'vitest';
import { attachmentBlobType, showsInline } from './attachment-blob-type';

// An attachment's bytes never sit in the renderer as something that can run.
describe('attachmentBlobType', () => {
  it('keeps the image types the chat shows inline', () => {
    expect(attachmentBlobType('image/png')).toBe('image/png');
    expect(attachmentBlobType('image/jpeg')).toBe('image/jpeg');
    expect(attachmentBlobType('image/gif')).toBe('image/gif');
    expect(attachmentBlobType('IMAGE/WEBP; charset=binary')).toBe('image/webp');
  });

  it('keeps HTML as bytes only, whatever its spelling', () => {
    expect(attachmentBlobType('text/html')).toBe('application/octet-stream');
    expect(attachmentBlobType('text/html; charset=utf-8')).toBe('application/octet-stream');
    expect(attachmentBlobType(' Text/HTML ')).toBe('application/octet-stream');
    expect(attachmentBlobType('application/xhtml+xml')).toBe('application/octet-stream');
  });

  it('keeps SVG as bytes only: it can carry script', () => {
    expect(attachmentBlobType('image/svg+xml')).toBe('application/octet-stream');
  });

  it('keeps anything else, or no type, as bytes only', () => {
    expect(attachmentBlobType('application/pdf')).toBe('application/octet-stream');
    expect(attachmentBlobType('text/plain')).toBe('application/octet-stream');
    expect(attachmentBlobType('')).toBe('application/octet-stream');
  });
});

describe('showsInline', () => {
  it('shows a safe image inline, and an SVG or HTML file as a file to save', () => {
    expect(showsInline('image/png')).toBe(true);
    expect(showsInline('image/svg+xml')).toBe(false);
    expect(showsInline('text/html')).toBe(false);
  });
});
