import { describe, expect, it } from 'vitest';
import { agentFor, labelFor, SHARED_LABEL, topLevelLabels } from './file-labels';

const ROOT = '/data/agents/workspaces';

describe('topLevelLabels', () => {
  it('labels an agent’s default folder with its name, or its display name', () => {
    const labels = topLevelLabels(ROOT, [
      { name: 'writer', directory: null },
      { name: 'coder', displayName: 'Code helper', directory: null },
    ]);
    expect(labelFor(labels, 'writer')).toBe('writer');
    expect(labelFor(labels, 'coder')).toBe('Code helper');
  });

  it('labels an agent’s own folder when it is exactly one level under the workspaces folder', () => {
    const labels = topLevelLabels(ROOT, [
      { name: 'a', directory: `${ROOT}/project-x` },
      { name: 'b', directory: `${ROOT}/project-y/` },
    ]);
    expect(labelFor(labels, 'project-x')).toBe('a');
    expect(labelFor(labels, 'project-y')).toBe('b');
  });

  it('labels nothing for a nested folder, the root itself, or a folder outside it', () => {
    const labels = topLevelLabels(ROOT, [
      { name: 'nested', directory: `${ROOT}/team/nested` },
      { name: 'root', directory: ROOT },
      { name: 'outside', directory: '/data/agents/home' },
      { name: 'escape', directory: `${ROOT}/../controller` },
      { name: 'relative', directory: 'workspaces/rel' },
    ]);
    expect([...labels.keys()]).toEqual([]);
    expect(labelFor(labels, 'team')).toBe(SHARED_LABEL);
  });

  it('calls every other folder Shared', () => {
    const labels = topLevelLabels(ROOT, [{ name: 'writer', directory: null }]);
    expect(labelFor(labels, 'downloads')).toBe(SHARED_LABEL);
  });

  it('never gives one folder to two agents: a folder both work in is Shared', () => {
    const labels = topLevelLabels(ROOT, [
      { name: 'one', directory: `${ROOT}/common` },
      { name: 'two', directory: `${ROOT}/common` },
    ]);
    expect(labelFor(labels, 'common')).toBe(SHARED_LABEL);
  });

  it('ignores an agent whose name isn’t a safe folder name', () => {
    const labels = topLevelLabels(ROOT, [{ name: '../escape', directory: null }]);
    expect([...labels.keys()]).toEqual([]);
  });

  it('falls back to the name when the display name is blank', () => {
    const labels = topLevelLabels(ROOT, [{ name: 'writer', displayName: '  ', directory: null }]);
    expect(labelFor(labels, 'writer')).toBe('writer');
  });

  it('gives each agent’s folder its stable name as well as its label, and none to Shared', () => {
    const labels = topLevelLabels(ROOT, [
      { name: 'coder', displayName: 'Code helper', directory: null },
      { name: 'one', directory: `${ROOT}/common` },
      { name: 'two', directory: `${ROOT}/common` },
    ]);
    expect(agentFor(labels, 'coder')).toBe('coder');
    expect(labelFor(labels, 'coder')).toBe('Code helper');
    expect(agentFor(labels, 'common')).toBeUndefined();
    expect(agentFor(labels, 'downloads')).toBeUndefined();
  });

  it('leaves the agent key out, keeping the label, when the name isn’t one Core takes', () => {
    const long = 'a'.repeat(256);
    const labels = topLevelLabels(ROOT, [
      { name: long, directory: `${ROOT}/long-one` },
      { name: 'Upper_Case', directory: `${ROOT}/odd-one` },
      { name: 'b'.repeat(255), directory: `${ROOT}/max-one` },
    ]);
    expect(agentFor(labels, 'long-one')).toBeUndefined();
    // The label is kept, cut to Core's 255 characters.
    expect(labelFor(labels, 'long-one')).toBe('a'.repeat(255));
    expect(agentFor(labels, 'odd-one')).toBeUndefined();
    expect(labelFor(labels, 'odd-one')).toBe('Upper_Case');
    expect(agentFor(labels, 'max-one')).toBe('b'.repeat(255));
  });

  it('cuts a long display label to 255 whole characters, never mid-character', () => {
    const emoji = '😀'.repeat(300); // each is two UTF-16 units, one character
    const labels = topLevelLabels(ROOT, [
      { name: 'writer', displayName: emoji, directory: null },
      { name: 'short', displayName: 'Short name', directory: null },
    ]);
    const cut = labelFor(labels, 'writer');
    expect(Array.from(cut)).toHaveLength(255);
    expect(cut).toBe('😀'.repeat(255));
    expect(agentFor(labels, 'writer')).toBe('writer');
    expect(labelFor(labels, 'short')).toBe('Short name');
  });
});
