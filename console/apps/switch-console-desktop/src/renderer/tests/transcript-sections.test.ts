import { describe, expect, it } from 'vitest';
import {
  composerPlaceholder,
  draftToAnswer,
} from '@renderer/features/sessions/components/transcript/transcript-inputs';
import {
  buildTranscriptSections,
  groupActivity,
} from '@renderer/features/sessions/components/transcript/transcript-sections';
import type { TranscriptEntry, TranscriptTurn } from '@shared/core/sessions/session-transcript';

const AT = '2026-01-01T00:00:00.000Z';

const item = (id: string, turnId: string, title: string): TranscriptEntry => ({
  kind: 'item',
  id,
  turnId,
  createdAt: AT,
  item: { type: 'command_execution', status: 'completed', title },
});

const user = (id: string, turnId: string): TranscriptEntry => ({
  kind: 'user',
  id,
  turnId,
  text: 'go',
  source: 'console',
  createdAt: AT,
});

const notice = (id: string): TranscriptEntry => ({
  kind: 'notice',
  id,
  level: 'warning',
  text: 'heads up',
  createdAt: AT,
});

describe('groupActivity', () => {
  it('collapses consecutive activity entries into one block', () => {
    const blocks = groupActivity([
      user('u1', 't1'),
      item('i1', 't1', 'ls'),
      item('i2', 't1', 'cat'),
      item('i3', 't1', 'rm'),
    ]);

    expect(blocks.map((block) => block.kind)).toEqual(['entry', 'activity']);
    expect(blocks[1]).toMatchObject({ kind: 'activity' });
    expect(blocks[1].kind === 'activity' && blocks[1].items).toHaveLength(3);
  });

  it('starts a new group when a message interrupts the run', () => {
    const blocks = groupActivity([
      item('i1', 't1', 'ls'),
      user('u1', 't1'),
      item('i2', 't1', 'cat'),
    ]);

    expect(blocks.map((block) => block.kind)).toEqual(['activity', 'entry', 'activity']);
  });
});

describe('buildTranscriptSections', () => {
  const turns: TranscriptTurn[] = [
    { turnId: 't1', status: 'completed', startedAt: AT },
    { turnId: 't2', status: 'running', startedAt: AT },
  ];

  it('splits on the turn boundary and attaches the turn', () => {
    const sections = buildTranscriptSections(
      [user('u1', 't1'), item('i1', 't1', 'ls'), user('u2', 't2')],
      turns
    );

    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({ turnId: 't1' });
    expect(sections[0].turn?.status).toBe('completed');
    expect(sections[1]).toMatchObject({ turnId: 't2' });
    expect(sections[1].turn?.status).toBe('running');
  });

  it('gives a notice its own turnless section without swallowing the turn around it', () => {
    const sections = buildTranscriptSections(
      [user('u1', 't1'), notice('n1'), item('i1', 't1', 'ls')],
      turns
    );

    expect(sections.map((section) => section.turnId)).toEqual(['t1', null, 't1']);
  });

  it('has no sections for an empty transcript', () => {
    expect(buildTranscriptSections([], turns)).toEqual([]);
  });
});

describe('draftToAnswer', () => {
  const base = {
    id: 'q',
    question: 'Which?',
    options: [
      { label: 'A', value: 'a' },
      { label: 'B', value: 'b' },
    ],
  };

  it('returns a single value for a single-select question', () => {
    const question = { ...base, multiSelect: false, allowCustomAnswer: false };
    expect(draftToAnswer(question, { selected: ['a'], custom: '' })).toBe('a');
    expect(draftToAnswer(question, { selected: [], custom: '' })).toBeNull();
  });

  it('returns an array for a multi-select question', () => {
    const question = { ...base, multiSelect: true, allowCustomAnswer: false };
    expect(draftToAnswer(question, { selected: ['a', 'b'], custom: '' })).toEqual(['a', 'b']);
    expect(draftToAnswer(question, { selected: [], custom: '' })).toBeNull();
  });

  it('prefers typed text over a selection, and joins it in for a multi-select', () => {
    expect(
      draftToAnswer(
        { ...base, multiSelect: false, allowCustomAnswer: true },
        { selected: ['a'], custom: ' something else ' }
      )
    ).toBe('something else');
    expect(
      draftToAnswer(
        { ...base, multiSelect: true, allowCustomAnswer: true },
        { selected: ['a'], custom: 'c' }
      )
    ).toEqual(['a', 'c']);
  });
});

describe('composerPlaceholder', () => {
  it('says what will happen to the message', () => {
    expect(composerPlaceholder('starting', false)).toMatch(/Starting/);
    expect(composerPlaceholder('stopped', false)).toMatch(/stopped/);
    expect(composerPlaceholder('error', false)).toMatch(/error/);
    expect(composerPlaceholder('running', true)).toMatch(/running turn/);
    expect(composerPlaceholder('ready', false)).toMatch(/Message the agent/);
  });
});
