import { expect, it } from 'vitest';
import { formatApprovalPaths, isFileApproval, mergeApprovalPaths } from './approval-details';

it('retains omitted and null fields, but replaces explicitly supplied arrays', () => {
  const original = mergeApprovalPaths(
    {},
    {
      kind: 'edit',
      title: 'Write File',
      locations: [{ path: '/work/location.txt' }],
      content: [{ type: 'diff', path: '/work/diff.txt', newText: 'private' }],
      rawInput: { path: '/work/input.txt', contents: 'private' },
    }
  );
  const partial = mergeApprovalPaths(original, { locations: null, rawInput: null });
  expect(formatApprovalPaths(partial)).toContain('/work/location.txt');
  expect(formatApprovalPaths(partial)).toContain('/work/input.txt');
  const cleared = mergeApprovalPaths(partial, { locations: [], content: [] });
  expect(formatApprovalPaths(cleared)).not.toContain('/work/location.txt');
  expect(formatApprovalPaths(cleared)).not.toContain('/work/diff.txt');
  expect(formatApprovalPaths(cleared)).toContain('/work/input.txt');
});

it('keeps bracket and Windows paths literal in Console and rejects bidi controls', () => {
  const detail = formatApprovalPaths(
    mergeApprovalPaths(
      {},
      {
        kind: 'edit',
        title: 'Write File',
        locations: [
          { path: '/work/[label](link).txt' },
          { path: 'C:\\work\\file.txt' },
          { path: '/x\u202eevil' },
        ],
      }
    )
  );
  expect(detail).toContain('/work/[label](link).txt');
  expect(detail).toContain('C:\\work\\file.txt');
  expect(detail).not.toContain('\\[label');
  expect(detail).toContain('Some paths omitted from this approval');
  expect(detail).not.toContain('\u202e');
});

it('rejects every Unicode bidi control in a path', () => {
  const bidiControls = [
    0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
  ];
  for (const control of bidiControls) {
    const path = `/work/${String.fromCodePoint(control)}target.txt`;
    const detail = formatApprovalPaths(
      mergeApprovalPaths({}, { kind: 'edit', title: 'Write File', locations: [{ path }] })
    );
    expect(detail).toContain('Some paths omitted from this approval');
    expect(detail).not.toContain(path);
  }
});

it('omits paths containing link or platform mention syntax instead of sending it to bridges', () => {
  for (const path of [
    '/w/<@everyone>',
    '/w/<https://evil.test|label>',
    '/w/[x](https://evil.test)',
  ]) {
    const detail = formatApprovalPaths(
      mergeApprovalPaths({}, { kind: 'edit', title: 'Write File', rawInput: { path } })
    );
    expect(detail).toBe(
      'Other input and file contents are not displayed in this approval. Decline if needed.\n' +
        'Some paths omitted from this approval.\nNo paths shown.'
    );
  }
});

it('omits paths that could change Markdown rendering or insert Unicode line breaks', () => {
  for (const character of ['*', '_', '~', '`', '\u2028', '\u2029']) {
    const path = `/work/a${character}b.txt`;
    const detail = formatApprovalPaths(
      mergeApprovalPaths({}, { kind: 'edit', title: 'Write File', rawInput: { path } })
    );
    expect(detail).toBe(
      'Other input and file contents are not displayed in this approval. Decline if needed.\n' +
        'Some paths omitted from this approval.\nNo paths shown.'
    );
  }
});

it('omits mixed Windows and Markdown punctuation instead of losing a backslash', () => {
  for (const path of ['C:\\work\\[a].txt', '\\\\server\\share\\file.txt']) {
    const detail = formatApprovalPaths(
      mergeApprovalPaths({}, { kind: 'edit', title: 'Write File', rawInput: { path } })
    );
    expect(detail).toBe(
      'Other input and file contents are not displayed in this approval. Decline if needed.\n' +
        'Some paths omitted from this approval.\nNo paths shown.'
    );
  }
});

it('omits targets whose ASCII spaces could collapse in a bridge', () => {
  for (const path of ['/work/a  b.txt', ' /work/file.txt', '/work/file.txt ', 'C:\\work\\  file']) {
    const detail = formatApprovalPaths(
      mergeApprovalPaths({}, { kind: 'edit', title: 'Write File', rawInput: { path } })
    );
    expect(detail).toBe(
      'Other input and file contents are not displayed in this approval. Decline if needed.\n' +
        'Some paths omitted from this approval.\nNo paths shown.'
    );
  }
});

it('omits relative targets instead of rendering possible Markdown blocks', () => {
  for (const path of ['---', '# foo', '1. file', 'workspace/file', 'C:relative']) {
    const detail = formatApprovalPaths(
      mergeApprovalPaths({}, { kind: 'edit', title: 'Write File', rawInput: { path } })
    );
    expect(detail).toBe(
      'Other input and file contents are not displayed in this approval. Decline if needed.\n' +
        'Some paths omitted from this approval.\nNo paths shown.'
    );
  }
});

it('omits paths with Unicode default-ignorable characters', () => {
  for (const control of [0x00ad, 0x034f, 0x200b, 0x2060, 0xfe0f, 0xfeff, 0xe0001]) {
    const path = `/work/a${String.fromCodePoint(control)}b.txt`;
    const detail = formatApprovalPaths(
      mergeApprovalPaths({}, { kind: 'edit', title: 'Write File', rawInput: { path } })
    );
    expect(detail).toBe(
      'Other input and file contents are not displayed in this approval. Decline if needed.\n' +
        'Some paths omitted from this approval.\nNo paths shown.'
    );
  }
});

it('keeps details below the Core limit and warns instead of showing a partial path', () => {
  const longPath = `/work/${'a'.repeat(3100)}`;
  const detail = formatApprovalPaths(
    mergeApprovalPaths(
      {},
      {
        kind: 'edit',
        title: 'Write File',
        locations: [{ path: longPath }, { path: '/work/short.txt' }],
      }
    )
  );
  expect(detail.length).toBeLessThanOrEqual(4000);
  expect(detail).toContain('Some paths omitted from this approval');
  expect(detail).toContain('/work/short.txt');
  expect(detail).not.toContain('a'.repeat(100));
});

it('uses compact whole-path details exercised by the Core renderer tests', () => {
  const warning =
    'Other input and file contents are not displayed in this approval. Decline if needed.';
  const detail = (path: string) =>
    formatApprovalPaths(
      mergeApprovalPaths({}, { kind: 'edit', title: 'Write File', rawInput: { path } })
    );
  expect(detail('/workspace/example.txt')).toBe(
    `${warning}\nReported paths:\n- /workspace/example.txt`
  );
  expect(detail(`/workspace/${'x'.repeat(1000)}`)).toBe(
    `${warning}\nSome paths omitted from this approval.\nNo paths shown.`
  );
  expect(detail('/w/[a](b)')).toBe(`${warning}\nReported paths:\n- /w/[a](b)`);
  expect(detail('C:\\work\\file.txt')).toBe(`${warning}\nReported paths:\n- C:\\work\\file.txt`);
});

it('omits whole paths when representative escaped room detail would be too long', () => {
  const escapeForRoom = (text: string) =>
    text
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#x27;')
      .replaceAll('@', '@\u200b')
      .replaceAll(']', ']\u200b');
  for (const path of [
    `/workspace/${'x'.repeat(500)}`,
    `/workspace/${'&'.repeat(100)}`,
    `/workspace/${'@'.repeat(100)}`,
    '/workspace/example.txt',
  ]) {
    const detail = formatApprovalPaths(
      mergeApprovalPaths({}, { kind: 'edit', title: 'Write File', rawInput: { path } })
    );
    // A 1,800-character neutral card has at least 450 characters for detail.
    expect(escapeForRoom(detail).length).toBeLessThanOrEqual(450);
    if (!detail.includes(path)) {
      expect(detail).toContain('Some paths omitted from this approval');
      expect(detail).not.toContain(path.slice(0, 50));
    }
  }
});

it('permits other to refine to edit without retaining earlier unclassified input', () => {
  const earlier = mergeApprovalPaths(
    {},
    { kind: 'other', rawInput: { path: '/private-unclassified-value' } }
  );
  const refined = mergeApprovalPaths(earlier, { kind: 'edit', title: 'Write File' });
  expect(isFileApproval(refined)).toBe(true);
  expect(formatApprovalPaths(refined)).not.toContain('/private-unclassified-value');
  expect(formatApprovalPaths(refined)).toContain('Some paths omitted from this approval');
  const resent = mergeApprovalPaths(refined, { rawInput: { path: '/work/target.txt' } });
  expect(formatApprovalPaths(resent)).toContain('/work/target.txt');
});
