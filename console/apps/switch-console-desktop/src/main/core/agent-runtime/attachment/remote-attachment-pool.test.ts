import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachQueue } from './attach-queue';
import { RemoteAttachmentPool } from './remote-attachment-pool';
import type { AttachState, AttachableRuntime } from './types';

vi.mock('@main/lib/logger', () => ({
  log: { child: () => ({ debug() {}, info() {}, warn() {} }), info() {}, warn() {}, error() {} },
}));

/** A runtime whose attach/detach just flips a flag, so policy is what's under test. */
class FakeRuntime implements AttachableRuntime {
  attached = false;
  attachCalls = 0;
  detachCalls = 0;
  failNextAttach = false;

  constructor(
    readonly attachSessionId: string,
    readonly attachHostKey: string
  ) {}

  async ensureAttachable(): Promise<void> {}

  async attach(): Promise<void> {
    this.attachCalls += 1;
    if (this.failNextAttach) {
      this.failNextAttach = false;
      throw new Error('attach failed');
    }
    this.attached = true;
  }

  async detachForEviction(): Promise<void> {
    this.detachCalls += 1;
    this.attached = false;
  }

  isAttached(): boolean {
    return this.attached;
  }
}

describe('RemoteAttachmentPool', () => {
  const HOST_A = 'agent-ssh:dev-vm';
  const HOST_B = 'agent-ssh:other-vm';

  let cap: number;
  let published: Array<{ sessionId: string; state: AttachState }>;
  let pool: RemoteAttachmentPool;

  const add = (sessionId: string, hostKey = HOST_A) => {
    const runtime = new FakeRuntime(sessionId, hostKey);
    pool.register(runtime);
    return runtime;
  };

  const attachedIds = (runtimes: FakeRuntime[]) =>
    runtimes.filter((r) => r.attached).map((r) => r.attachSessionId);

  beforeEach(() => {
    cap = 2;
    published = [];
    pool = new RemoteAttachmentPool({
      readCap: async () => cap,
      // No real timers: the stagger is AttachQueue's contract, tested there.
      makeQueue: () => new AttachQueue(0, async () => {}),
      publish: ({ sessionId, state }) => published.push({ sessionId, state }),
    });
  });

  it('attaches a registered session on request', async () => {
    const a = add('a');

    await expect(pool.requestAttach('a', 'user')).resolves.toBe('attached');
    expect(a.attached).toBe(true);
    expect(pool.stateOf('a')).toBe('attached');
  });

  it('is a no-op for a session it does not know', async () => {
    await expect(pool.requestAttach('ghost', 'user')).resolves.toBe('detached');
  });

  it('evicts the least-recently-viewed session when the host is at capacity', async () => {
    const a = add('a');
    const b = add('b');
    const c = add('c');

    await pool.requestAttach('a', 'user');
    await pool.requestAttach('b', 'user');
    await pool.requestAttach('c', 'user');

    // 'a' was viewed longest ago, so it makes room for 'c'.
    expect(attachedIds([a, b, c])).toEqual(['b', 'c']);
    expect(a.detachCalls).toBe(1);
  });

  it('counts capacity per host rather than globally', async () => {
    const a1 = add('a1', HOST_A);
    const a2 = add('a2', HOST_A);
    const b1 = add('b1', HOST_B);
    const b2 = add('b2', HOST_B);

    await pool.requestAttach('a1', 'user');
    await pool.requestAttach('b1', 'user');
    await pool.requestAttach('a2', 'user');
    await pool.requestAttach('b2', 'user');

    // Both hosts are at their own cap of 2; neither starved the other.
    expect(attachedIds([a1, a2, b1, b2])).toEqual(['a1', 'a2', 'b1', 'b2']);
  });

  it('never evicts the focused session', async () => {
    const a = add('a');
    const b = add('b');
    const c = add('c');

    // 'a' is focused and therefore pinned, even though it is the oldest.
    pool.setFocused('a');
    await pool.requestAttach('a', 'user');
    await pool.requestAttach('b', 'user');
    await pool.requestAttach('c', 'user');

    expect(a.attached).toBe(true);
    expect(attachedIds([a, b, c])).toEqual(['a', 'c']);
  });

  it('re-focusing unpins the previous session so a cap of one cannot deadlock', async () => {
    cap = 1;
    const a = add('a');
    const b = add('b');

    pool.setFocused('a');
    await pool.requestAttach('a', 'user');
    expect(a.attached).toBe(true);

    // Focus moves first, which is what makes 'a' evictable for 'b'.
    pool.setFocused('b');
    await pool.requestAttach('b', 'user');

    expect(a.attached).toBe(false);
    expect(b.attached).toBe(true);
  });

  it('treats a viewed session as recently used without attaching it', async () => {
    const a = add('a');
    const b = add('b');
    const c = add('c');

    await pool.requestAttach('a', 'user');
    await pool.requestAttach('b', 'user');
    pool.noteViewed('a');
    await pool.requestAttach('c', 'user');

    // 'a' was touched last, so 'b' is now the oldest and goes instead.
    expect(attachedIds([a, b, c])).toEqual(['a', 'c']);
  });

  it('reports a failed attach without leaving the session stuck attaching', async () => {
    const a = add('a');
    a.failNextAttach = true;

    await expect(pool.requestAttach('a', 'user')).resolves.toBe('failed');
    expect(pool.stateOf('a')).toBe('failed');
    expect(published.map((p) => p.state)).toEqual(['attaching', 'failed']);
  });

  it('publishes attaching then attached on success', async () => {
    add('a');

    await pool.requestAttach('a', 'user');

    expect(published).toEqual([
      { sessionId: 'a', state: 'attaching' },
      { sessionId: 'a', state: 'attached' },
    ]);
  });

  it('marks every session on a host detached when its connection drops', async () => {
    const a = add('a');
    const b = add('b');
    const other = add('z', HOST_B);
    await pool.requestAttach('a', 'user');
    await pool.requestAttach('b', 'user');
    await pool.requestAttach('z', 'user');

    pool.handleConnectionLost(HOST_A);

    expect(pool.stateOf('a')).toBe('detached');
    expect(pool.stateOf('b')).toBe('detached');
    // The other host is untouched.
    expect(pool.stateOf('z')).toBe('attached');
    // The PTYs died with the transport; the pool records that, it does not detach again.
    expect(a.detachCalls).toBe(0);
    expect(b.detachCalls).toBe(0);
    expect(other.detachCalls).toBe(0);
  });

  it('replays at most the cap after a reconnect, most-recently-viewed first', async () => {
    const runtimes = ['a', 'b', 'c', 'd'].map((id) => add(id));
    for (const id of ['a', 'b', 'c', 'd']) pool.noteViewed(id);
    // Simulate the transport dying: nothing is attached any more.
    for (const runtime of runtimes) runtime.attached = false;

    await pool.replayAfterReconnect(HOST_A);
    await vi.waitFor(() => expect(attachedIds(runtimes)).toHaveLength(2));

    // 'd' and 'c' were viewed most recently; 'a' and 'b' stay detached and keep
    // running on the VM rather than stampeding the transport that just returned.
    expect(attachedIds(runtimes).sort()).toEqual(['c', 'd']);
  });

  it('replays the focused session first even when it was not the most recent', async () => {
    cap = 1;
    const runtimes = ['a', 'b', 'c'].map((id) => add(id));
    pool.setFocused('a');
    pool.noteViewed('b');
    pool.noteViewed('c');
    for (const runtime of runtimes) runtime.attached = false;

    await pool.replayAfterReconnect(HOST_A);
    await vi.waitFor(() => expect(attachedIds(runtimes)).toHaveLength(1));

    expect(attachedIds(runtimes)).toEqual(['a']);
  });

  it('drops queued attaches when the connection is lost mid-replay', async () => {
    const gate = { release: () => {} };
    const blocker = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const a = add('a');
    const b = add('b');
    a.attach = async () => {
      await blocker;
      a.attached = true;
    };

    const first = pool.requestAttach('a', 'user');
    const second = pool.requestAttach('b', 'user');
    // 'b' is still queued behind 'a' when the transport dies.
    pool.handleConnectionLost(HOST_A);
    gate.release();
    await Promise.all([first, second]);

    expect(b.attachCalls).toBe(0);
    expect(pool.stateOf('b')).toBe('detached');
  });

  it('forgets a session on unregister and unpins it if focused', async () => {
    const a = add('a');
    await pool.requestAttach('a', 'user');

    pool.setFocused('a');
    pool.unregister('a');

    expect(pool.stateOf('a')).toBe('detached');
    await expect(pool.requestAttach('a', 'user')).resolves.toBe('detached');
    expect(a.attachCalls).toBe(1);
  });

  it('does not re-attach a session that is already attached', async () => {
    const a = add('a');
    await pool.requestAttach('a', 'user');
    await pool.requestAttach('a', 'focus');

    expect(a.attachCalls).toBe(1);
  });

  it('attaches a session that is focused before its runtime is registered', async () => {
    // The renderer reports focus on navigation, which can beat provisioning.
    // Without the catch-up in register(), the click would open nothing.
    pool.setFocused('a');
    const a = add('a');

    await vi.waitFor(() => expect(a.attached).toBe(true));
  });

  it('does not attach an unfocused session on registration', async () => {
    pool.setFocused('other');
    const a = add('a');

    await Promise.resolve();
    expect(a.attachCalls).toBe(0);
  });

  it('keeps a live session attached when its runtime re-registers', async () => {
    const a = add('a');
    await pool.requestAttach('a', 'user');

    pool.register(a);

    expect(pool.stateOf('a')).toBe('attached');
  });
});
