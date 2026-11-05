import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilesReply, FilesRequest } from './files-frames';
import { codeFor, FILES_RELAY_IN_FLIGHT, type FilesLink, FilesRelay } from './files-relay';
import type { FileReport } from './launcher-link';

type Started = {
  id: number;
  order: Parameters<FilesLink['startFile']>[0];
  onReport: (r: FileReport) => void;
};

function fakeLink() {
  const started: Started[] = [];
  const follow: { kind: string; id: number }[] = [];
  const ended: number[] = [];
  let next = 100;
  const link: FilesLink = {
    startFile(order, onReport) {
      const id = next++;
      started.push({ id, order, onReport });
      return id;
    },
    followFile(kind, id) {
      follow.push({ kind, id });
    },
    endFile(id) {
      ended.push(id);
    },
  };
  return { link, started, follow, ended };
}

function setup(labels = new Map<string, { label: string; agent: string }>()) {
  const fake = fakeLink();
  const sent: FilesReply[] = [];
  const logs: { event: string; fields: Record<string, string | number> }[] = [];
  const activity = vi.fn();
  const relay = new FilesRelay({
    link: fake.link,
    send: (reply) => sent.push(reply),
    labels: () => labels,
    activity,
    log: (event, fields) => logs.push({ event, fields }),
    onceDeadlineMs: 1000,
    zipDeadlineMs: 5000,
  });
  return { ...fake, sent, logs, activity, relay };
}

const req = (over: Partial<FilesRequest> = {}): FilesRequest => ({
  id: 'c-1',
  op: 'list',
  path: '',
  ...over,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('FilesRelay: one order per request, the reply under Core’s id', () => {
  it('maps list, read and zip to the launcher’s orders', () => {
    const t = setup();
    t.relay.request(req({ id: 'a', op: 'list', path: 'writer', cursor: 'b.txt' }));
    t.relay.request(req({ id: 'b', op: 'read', path: 'writer/a.txt', offset: 131072 }));
    t.relay.request(req({ id: 'c', op: 'zip', path: 'writer', caches: true }));
    expect(t.started.map((s) => s.order)).toEqual([
      { kind: 'files_list', path: 'writer', cursor: 'b.txt' },
      { kind: 'files_read', path: 'writer/a.txt', offset: 131072, length: 131072 },
      { kind: 'files_zip', path: 'writer', includeCaches: true },
    ]);
  });

  it('labels top-level folders only, from the controller’s own definitions', () => {
    const t = setup(new Map([['writer', { label: 'Writer', agent: 'writer' }]]));
    t.relay.request(req({ id: 'top' }));
    t.started[0]!.onReport({
      kind: 'reply',
      id: t.started[0]!.id,
      ok: true,
      listing: {
        entries: [
          { name: 'writer', kind: 'folder', size: 0, mtime: 1 },
          { name: 'notes', kind: 'folder', size: 0, mtime: 1 },
          { name: 'a.txt', kind: 'file', size: 3, mtime: 1 },
        ],
        cursor: 'notes',
      },
    });
    expect(t.sent).toEqual([
      {
        type: 'files.reply',
        id: 'top',
        seq: 0,
        last: true,
        cursor: 'notes',
        entries: [
          { name: 'writer', kind: 'folder', size: 0, mtime: 1, label: 'Writer', agent: 'writer' },
          { name: 'notes', kind: 'folder', size: 0, mtime: 1, label: 'Shared' },
          { name: 'a.txt', kind: 'file', size: 3, mtime: 1 },
        ],
      },
    ]);
    expect(t.ended).toEqual([t.started[0]!.id]);

    t.relay.request(req({ id: 'deep', path: 'writer' }));
    t.started[1]!.onReport({
      kind: 'reply',
      id: t.started[1]!.id,
      ok: true,
      listing: { entries: [{ name: 'writer', kind: 'folder', size: 0, mtime: 1 }] },
    });
    expect(t.sent[1]!.entries).toEqual([{ name: 'writer', kind: 'folder', size: 0, mtime: 1 }]);
  });

  it('passes a read’s chunk on as it came, with the total size', () => {
    const t = setup();
    t.relay.request(req({ id: 'r', op: 'read', path: 'a.txt' }));
    t.started[0]!.onReport({
      kind: 'files_chunk',
      id: t.started[0]!.id,
      seq: 0,
      data: 'aGk=',
      last: true,
      size: 2,
    });
    expect(t.sent).toEqual([
      { type: 'files.reply', id: 'r', seq: 0, last: true, data: 'aGk=', size: 2 },
    ]);
    expect(t.relay.inFlight).toBe(0);
  });

  it('passes the launcher’s fixed codes on, and maps its link codes', () => {
    const t = setup();
    t.relay.request(req({ id: 'x', path: 'secret' }));
    t.started[0]!.onReport({ kind: 'reply', id: t.started[0]!.id, ok: false, code: 'denied' });
    expect(t.sent).toEqual([{ type: 'files.reply', id: 'x', seq: 0, last: true, error: 'denied' }]);
    expect(codeFor('launcher_lost')).toBe('timeout');
    expect(codeFor('timed_out')).toBe('timeout');
    expect(codeFor('failed')).toBe('failed');
    expect(codeFor('bad_template')).toBe('failed');
    expect(codeFor(undefined)).toBe('failed');
  });
});

describe('FilesRelay: zip, one chunk at a time', () => {
  it('asks for the next chunk only after Core asks, and never twice', () => {
    const t = setup();
    t.relay.request(req({ id: 'z', op: 'zip', path: 'writer' }));
    const { id, onReport } = t.started[0]!;
    onReport({ kind: 'files_chunk', id, seq: 0, data: 'AA==', last: false });
    expect(t.follow).toEqual([]);
    t.relay.more('z');
    t.relay.more('z');
    expect(t.follow).toEqual([{ kind: 'files_more', id }]);
    onReport({ kind: 'files_chunk', id, seq: 1, data: '', last: true });
    expect(t.sent.map((r) => [r.seq, r.last])).toEqual([
      [0, false],
      [1, true],
    ]);
    expect(t.relay.inFlight).toBe(0);
  });

  it('ignores files.more for a list, a read or an unknown id', () => {
    const t = setup();
    t.relay.request(req({ id: 'l' }));
    t.relay.more('l');
    t.relay.more('nope');
    expect(t.follow).toEqual([]);
  });
});

describe('FilesRelay: limits, deadlines and cancel', () => {
  it('refuses the request past its limit with busy, sending nothing to the launcher', () => {
    const t = setup();
    for (let i = 0; i < FILES_RELAY_IN_FLIGHT; i++) t.relay.request(req({ id: `r${i}` }));
    t.relay.request(req({ id: 'over' }));
    expect(t.started).toHaveLength(FILES_RELAY_IN_FLIGHT);
    expect(t.sent).toEqual([
      { type: 'files.reply', id: 'over', seq: 0, last: true, error: 'busy' },
    ]);
  });

  it('refuses a second request under an id already open', () => {
    const t = setup();
    t.relay.request(req({ id: 'same' }));
    t.relay.request(req({ id: 'same' }));
    expect(t.started).toHaveLength(1);
    expect(t.sent[0]!.error).toBe('busy');
  });

  it('times a list or read out, cancelling it at the launcher', () => {
    const t = setup();
    t.relay.request(req({ id: 'slow', op: 'read', path: 'a' }));
    vi.advanceTimersByTime(1000);
    expect(t.follow).toEqual([{ kind: 'files_cancel', id: t.started[0]!.id }]);
    expect(t.sent).toEqual([
      { type: 'files.reply', id: 'slow', seq: 0, last: true, error: 'timeout' },
    ]);
    // A late chunk after the deadline goes nowhere.
    t.started[0]!.onReport({
      kind: 'files_chunk',
      id: t.started[0]!.id,
      seq: 0,
      data: '',
      last: true,
    });
    expect(t.sent).toHaveLength(1);
  });

  it('times a whole zip out on its own, longer deadline', () => {
    const t = setup();
    t.relay.request(req({ id: 'z', op: 'zip', path: 'w' }));
    vi.advanceTimersByTime(4999);
    expect(t.sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(t.sent[0]!.error).toBe('timeout');
  });

  it('cancels at the launcher when Core’s side goes away, and sends nothing more', () => {
    const t = setup();
    t.relay.request(req({ id: 'z', op: 'zip', path: 'w' }));
    t.relay.cancel('z');
    expect(t.follow).toEqual([{ kind: 'files_cancel', id: t.started[0]!.id }]);
    t.started[0]!.onReport({
      kind: 'files_chunk',
      id: t.started[0]!.id,
      seq: 0,
      data: 'AA==',
      last: false,
    });
    expect(t.sent).toEqual([]);
    expect(t.relay.inFlight).toBe(0);
  });

  it('cancels every open request when the socket to Core goes', () => {
    const t = setup();
    t.relay.request(req({ id: 'a' }));
    t.relay.request(req({ id: 'b', op: 'zip', path: 'w' }));
    t.relay.cancelAll();
    expect(t.follow.map((f) => f.kind)).toEqual(['files_cancel', 'files_cancel']);
    expect(t.relay.inFlight).toBe(0);
  });

  it('refuses, before the launcher, an order its schema would refuse (a name over 255 bytes)', () => {
    const t = setup();
    t.relay.request(req({ id: 'long', path: 'a'.repeat(300) }));
    expect(t.started).toEqual([]);
    expect(t.sent[0]!.error).toBe('not_found');
  });
});

describe('FilesRelay: activity, never an agent host, no paths in logs', () => {
  it('counts each request and each zip pull as box activity', () => {
    const t = setup();
    t.relay.request(req({ id: 'z', op: 'zip', path: 'w' }));
    t.started[0]!.onReport({
      kind: 'files_chunk',
      id: t.started[0]!.id,
      seq: 0,
      data: 'AA==',
      last: false,
    });
    t.relay.more('z');
    expect(t.activity).toHaveBeenCalledTimes(2);
  });

  it('logs codes and counts only, never a path or a name', () => {
    const t = setup(
      new Map([['secret-project', { label: 'Secret agent', agent: 'secret-agent' }]])
    );
    t.relay.request(req({ id: 'a', path: 'secret-project/private-file.txt', op: 'read' }));
    t.started[0]!.onReport({ kind: 'reply', id: t.started[0]!.id, ok: false, code: 'not_found' });
    t.relay.request(req({ id: 'b' }));
    t.started[1]!.onReport({
      kind: 'reply',
      id: t.started[1]!.id,
      ok: true,
      listing: { entries: [{ name: 'secret-project', kind: 'folder', size: 0, mtime: 1 }] },
    });
    const text = JSON.stringify(t.logs);
    expect(text).not.toMatch(/secret|private|Secret/);
    expect(t.logs.length).toBeGreaterThan(0);
  });
});
