import { describe, expect, it } from 'vitest';
import { HostTickets, TICKET_TTL_MS } from './host-tickets';

const A = 'agent-a';
const B = 'agent-b';

function tickets() {
  let clock = 0;
  let n = 0;
  const store = new HostTickets(
    () => clock,
    (size) => Buffer.alloc(size, ++n)
  );
  return { store, advance: (ms: number) => (clock += ms) };
}

describe('HostTickets', () => {
  it('makes 128-bit tickets, and takes each once for its own agent and launch', () => {
    const { store } = tickets();
    const t = store.mint(A, 3);
    expect(t).toMatch(/^[0-9a-f]{32}$/);
    expect(store.take(A, t)).toEqual({ ok: true, launchId: 3 });
    expect(store.take(A, t)).toEqual({ ok: false, reason: 'spent' });
  });

  it('refuses a ticket after about 10 s', () => {
    const { store, advance } = tickets();
    const t = store.mint(A, 1);
    advance(TICKET_TTL_MS);
    expect(store.take(A, t)).toEqual({ ok: false, reason: 'expired' });
  });

  it("refuses another agent's ticket, and spends it so it can't be tried again", () => {
    const { store } = tickets();
    const t = store.mint(A, 1);
    expect(store.take(B, t)).toEqual({ ok: false, reason: 'wrong_agent' });
    expect(store.take(A, t)).toEqual({ ok: false, reason: 'spent' });
  });

  it('refuses a guess, and anything that is not a ticket', () => {
    const { store } = tickets();
    store.mint(A, 1);
    expect(store.take(A, 'f'.repeat(32))).toEqual({ ok: false, reason: 'unknown' });
    expect(store.take(A, '../x')).toEqual({ ok: false, reason: 'unknown' });
  });

  it("a new launch's ticket replaces the agent's unspent one, and forget ends them all", () => {
    const { store } = tickets();
    const first = store.mint(A, 1);
    const second = store.mint(A, 2);
    expect(store.take(A, first)).toEqual({ ok: false, reason: 'expired' });
    const other = store.mint(B, 1);
    store.forget(B);
    expect(store.take(B, other)).toEqual({ ok: false, reason: 'expired' });
    expect(store.take(A, second)).toEqual({ ok: true, launchId: 2 });
    expect(store.pending).toBe(0);
  });
});
