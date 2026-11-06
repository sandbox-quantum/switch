import { describe, expect, it } from 'vitest';
import { AgentsDisk, DISK_STALE_MS } from './agents-disk';

type Reply = Awaited<ReturnType<ConstructorParameters<typeof AgentsDisk>[0]['ask']>>;

const ok = (free: number, total: number): Reply => ({
  kind: 'reply',
  id: 1,
  ok: true,
  disk: { free, total },
});
const failed = (code: 'launcher_lost' | 'timed_out' | 'failed'): Reply => ({
  kind: 'reply',
  id: 1,
  ok: false,
  code,
});

function disk(answers: (Reply | 'hang' | 'throw')[], askMs = 20) {
  let clock = 0;
  const reader = new AgentsDisk({
    ask: () => {
      const next = answers.shift() ?? failed('launcher_lost');
      if (next === 'hang') return new Promise<Reply>(() => {});
      if (next === 'throw') return Promise.reject(new Error('socket closed'));
      return Promise.resolve(next);
    },
    now: () => clock,
    askMs,
  });
  return { reader, advance: (ms: number) => void (clock += ms) };
}

describe('AgentsDisk', () => {
  it('reports the launcher’s reading of the agents’ volume', async () => {
    const { reader } = disk([ok(12_000, 15_000)]);
    expect(await reader.reading()).toEqual({ free: 12_000, total: 15_000 });
  });

  it('keeps the last good reading through a short silence, then says unknown, never another disk', async () => {
    const { reader, advance } = disk([
      ok(12_000, 15_000),
      failed('timed_out'),
      'hang',
      failed('launcher_lost'),
    ]);
    expect(await reader.reading()).toEqual({ free: 12_000, total: 15_000 });
    advance(5_000);
    expect(await reader.reading()).toEqual({ free: 12_000, total: 15_000 });
    advance(5_000);
    // An ask that never answers is cut short, and the last reading still stands.
    expect(await reader.reading()).toEqual({ free: 12_000, total: 15_000 });
    advance(DISK_STALE_MS);
    expect(await reader.reading()).toBeNull();
  });

  it('is unknown from the start when the launcher can’t answer', async () => {
    expect(await disk([failed('launcher_lost')]).reader.reading()).toBeNull();
    expect(await disk(['throw']).reader.reading()).toBeNull();
    expect(await disk(['hang']).reader.reading()).toBeNull();
  });

  it('takes no reading from an answer that makes no sense', async () => {
    expect(await disk([ok(0, 0)]).reader.reading()).toBeNull();
    expect(await disk([ok(20, 10)]).reader.reading()).toBeNull();
    expect(await disk([{ kind: 'reply', id: 1, ok: true }]).reader.reading()).toBeNull();
  });
});
