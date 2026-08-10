import { describe, expect, it } from 'vitest';
import { InstallProgressReader } from './install-progress';

const ESC = '\u001b';

describe('InstallProgressReader', () => {
  it('reports the line a terminal would be showing', () => {
    const reader = new InstallProgressReader();
    reader.push('Reading package lists...\nBuilding dependency tree...\n');

    expect(reader.take()).toBe('Building dependency tree...');
  });

  it('follows a carriage-return repaint rather than concatenating its frames', () => {
    // apt draws its progress by rewriting one line hundreds of times. Joining
    // those frames would produce an unreadable smear of every percentage.
    const reader = new InstallProgressReader();
    reader.push('0% [Waiting for headers]\r25% [Connecting]\r90% [Unpacking git]');

    expect(reader.take()).toBe('90% [Unpacking git]');
  });

  it('assembles a line that arrives split across chunks', () => {
    const reader = new InstallProgressReader();
    reader.push('Get:3 http://archive.ubuntu.com ');
    reader.push('noble/main amd64 git amd64 2.43.0');

    expect(reader.take()).toBe('Get:3 http://archive.ubuntu.com noble/main amd64 git amd64 2.43.0');
  });

  it('strips the escape sequences a PTY carries', () => {
    const reader = new InstallProgressReader();
    reader.push(`${ESC}[1;32mSetting up git${ESC}[0m${ESC}]0;installing${ESC}\\`);

    expect(reader.take()).toBe('Setting up git');
  });

  it('says nothing when nothing has changed, so a caller can poll freely', () => {
    const reader = new InstallProgressReader();
    reader.push('Unpacking git\n');

    expect(reader.take()).toBe('Unpacking git');
    expect(reader.take()).toBeNull();
  });

  describe('keeping the last real message on screen', () => {
    it('does not blank the line for the trailing newline of a message', () => {
      // Every completed line leaves the cursor on an empty one. Reporting that
      // emptiness would flicker the display off between messages.
      const reader = new InstallProgressReader();
      reader.push('Setting up git (1:2.43.0-1ubuntu7.3) ...\n');

      expect(reader.take()).toBe('Setting up git (1:2.43.0-1ubuntu7.3) ...');

      reader.push('\n\n');
      expect(reader.take()).toBeNull();
    });

    it('reports nothing at all before any output arrives', () => {
      expect(new InstallProgressReader().take()).toBeNull();
    });
  });

  it('truncates a line that would reflow the row it is shown in', () => {
    const reader = new InstallProgressReader();
    reader.push('x'.repeat(400));

    expect(reader.take()).toHaveLength(160);
  });
});
