import { beforeEach, describe, expect, it, vi } from 'vitest';

const stored = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => void stored.set(key, value),
});

async function freshStore() {
  vi.resetModules();
  return (await import('./buddy-intro-store')).buddyIntroStore;
}

beforeEach(() => {
  stored.clear();
});

describe('buddyIntroStore', () => {
  it('asks once per workspace, and remembers the answer across launches', async () => {
    const store = await freshStore();
    expect(store.isAnswered('ws-1')).toBe(false);

    store.answered('ws-1');

    expect(store.isAnswered('ws-1')).toBe(true);
    expect(store.isAnswered('ws-2')).toBe(false);
    expect((await freshStore()).isAnswered('ws-1')).toBe(true);
  });

  it('keeps away for the rest of the launch after Skip, and asks again on the next', async () => {
    const store = await freshStore();
    expect(store.skippedThisSession).toBe(false);

    store.skipped();

    expect(store.skippedThisSession).toBe(true);
    expect((await freshStore()).skippedThisSession).toBe(false);
  });
});
