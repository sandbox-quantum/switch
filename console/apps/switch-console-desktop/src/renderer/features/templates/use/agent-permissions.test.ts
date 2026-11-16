import { describe, expect, it } from 'vitest';
import { chooseCase, runsWithoutAsking, whoCanAddress } from './agent-permissions';

describe('runsWithoutAsking', () => {
  it('reads a plain auto_approve', () => {
    expect(runsWithoutAsking(true, {})).toBe(true);
    expect(runsWithoutAsking(false, {})).toBe(false);
    expect(runsWithoutAsking(undefined, {})).toBe(false);
  });

  it('reads a {param} from the inputs', () => {
    expect(runsWithoutAsking('{bypass}', { bypass: true })).toBe(true);
    expect(runsWithoutAsking('{bypass}', { bypass: false })).toBe(false);
    expect(runsWithoutAsking('{bypass}', {})).toBe(false);
  });

  it('chooses among version 2 cases as the server does', () => {
    const cases = [{ if: '{mode} == yolo', value: true }, { value: false }];
    expect(runsWithoutAsking(cases, { mode: 'yolo' })).toBe(true);
    expect(runsWithoutAsking(cases, { mode: 'careful' })).toBe(false);
  });

  it('cannot tell a value it does not read, rather than calling it safe', () => {
    expect(runsWithoutAsking('yes', {})).toBeNull();
    expect(runsWithoutAsking({ always: true }, {})).toBeNull();
    expect(runsWithoutAsking('{mode}', { mode: 'sure' })).toBeNull();
  });
});

describe('whoCanAddress', () => {
  it('defaults to the owner and their agents', () => {
    expect(whoCanAddress(undefined, {})).toEqual({ kind: 'owner-agents' });
  });

  it('reads each plain addressing', () => {
    expect(whoCanAddress('owner', {})).toEqual({ kind: 'owner' });
    expect(whoCanAddress('owner-agents', {})).toEqual({ kind: 'owner-agents' });
    expect(whoCanAddress('anyone', {})).toEqual({ kind: 'anyone' });
  });

  it('reads the rooms an anyone_in names', () => {
    expect(whoCanAddress({ anyone_in: ['sprint_room'] }, {})).toEqual({
      kind: 'rooms',
      rooms: ['sprint_room'],
    });
  });

  it('chooses among version 2 cases, as the Switch expert template writes them', () => {
    const cases = [
      { if: '{start_in} == new_room', value: { anyone_in: ['expert_room'] } },
      { value: 'anyone' },
    ];
    expect(whoCanAddress(cases, { start_in: 'new_room' })).toEqual({
      kind: 'rooms',
      rooms: ['expert_room'],
    });
    expect(whoCanAddress(cases, { start_in: 'existing_room' })).toEqual({ kind: 'anyone' });
  });

  it('cannot tell a form it does not read', () => {
    expect(whoCanAddress('everyone', {})).toEqual({ kind: 'unknown' });
    expect(whoCanAddress({ anyone_in: 'room' }, {})).toEqual({ kind: 'unknown' });
  });
});

describe('chooseCase', () => {
  it('leaves a field without cases as it is', () => {
    expect(chooseCase(['a', 'b'], {})).toEqual(['a', 'b']);
    expect(chooseCase('anyone', {})).toBe('anyone');
  });

  it('chooses nothing when no case holds', () => {
    expect(chooseCase([{ if: '{x}', value: true }], { x: false })).toBeUndefined();
  });
});
