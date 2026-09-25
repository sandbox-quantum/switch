import { describe, expect, it } from 'vitest';
import type { TemplateRun, TemplateRunRoom } from '@main/core/switch-servers/gateway-client';
import { isLiveRun, runAuthor, runLabel, runMatches, runRoomTree } from './template-runs';

function room(id: string, parentRoomId: string | null, agent?: string): TemplateRunRoom {
  return {
    id,
    name: `Room ${id}`,
    parentRoomId,
    createdByAgentId: agent ? `id-${agent}` : null,
    createdByAgentName: agent ?? null,
    templateName: null,
    createdAt: '2026-09-25T10:00:00Z',
    archived: false,
  };
}

function run(rooms: TemplateRunRoom[], changes: Partial<TemplateRun> = {}): TemplateRun {
  return {
    rootRoomId: rooms[0]?.id ?? 'root',
    rootRoomName: 'Root room',
    startedByName: 'alice',
    templateName: null,
    startedAt: '2026-09-25T10:00:00Z',
    lastActivityAt: '2026-09-25T10:00:00Z',
    state: 'running',
    reason: null,
    changedByName: null,
    pausedRepeatOf: null,
    canControl: true,
    rooms,
    ...changes,
  };
}

const tree = (rooms: TemplateRunRoom[]) =>
  runRoomTree(rooms).map(({ room: r, depth }) => `${depth}:${r.id}`);

describe('runRoomTree', () => {
  it('puts each room under its parent, siblings in creation order', () => {
    expect(
      tree([room('a', null), room('b', 'a'), room('c', 'a'), room('d', 'b'), room('e', 'c')])
    ).toEqual(['0:a', '1:b', '2:d', '1:c', '2:e']);
  });

  it('draws a room whose parent is missing at the top level', () => {
    expect(tree([room('a', null), room('b', 'gone'), room('c', 'b')])).toEqual([
      '0:a',
      '0:b',
      '1:c',
    ]);
  });

  it('keeps every room of a parent loop, once each', () => {
    expect(tree([room('a', null), room('b', 'c'), room('c', 'b')])).toEqual(['0:a', '0:b', '1:c']);
  });

  it('treats a room that names itself as parent as a top-level room', () => {
    expect(tree([room('a', 'a')])).toEqual(['0:a']);
  });
});

describe('runAuthor', () => {
  it('names the one agent that made rooms', () => {
    expect(runAuthor(run([room('a', null), room('b', 'a', 'planner')]))).toBe('planner');
  });

  it('counts further agents', () => {
    expect(
      runAuthor(
        run([
          room('a', null),
          room('b', 'a', 'planner'),
          room('c', 'b', 'writer'),
          room('d', 'b', 'planner'),
          room('e', 'c', 'critic'),
        ])
      )
    ).toBe('planner and 2 more');
  });

  it('is whoever started the run when no agent made a room', () => {
    expect(runAuthor(run([room('a', null)]))).toBe('alice');
  });
});

describe('runLabel and runMatches', () => {
  it('prefers the template name over the root room name', () => {
    expect(runLabel(run([room('a', null)], { templateName: 'Triage pair' }))).toBe('Triage pair');
    expect(runLabel(run([room('a', null)]))).toBe('Root room');
  });

  it('matches the label or any room name', () => {
    const r = run([room('a', null), room('b', 'a')], { templateName: 'Triage pair' });
    expect(runMatches(r, '')).toBe(true);
    expect(runMatches(r, 'triage')).toBe(true);
    expect(runMatches(r, 'room b')).toBe(true);
    expect(runMatches(r, 'nothing')).toBe(false);
  });
});

describe('isLiveRun', () => {
  it('is live while running or paused', () => {
    expect(isLiveRun(run([], { state: 'running' }))).toBe(true);
    expect(isLiveRun(run([], { state: 'paused' }))).toBe(true);
    expect(isLiveRun(run([], { state: 'stopped' }))).toBe(false);
  });
});
