import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { kv } from '@main/db/schema';
import { sealingKeyPins } from './sealing-key-pins';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

describe('sealing key pins', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('keeps a key per server and machine, and replaces it when told to', async () => {
    expect(await sealingKeyPins.get('server-1', 'controller-1')).toBeNull();

    await sealingKeyPins.set('server-1', 'controller-1', 'first-key');
    await sealingKeyPins.set('server-2', 'controller-1', 'other-server-key');

    expect(await sealingKeyPins.get('server-1', 'controller-1')).toMatchObject({
      key: 'first-key',
    });
    expect(await sealingKeyPins.get('server-2', 'controller-1')).toMatchObject({
      key: 'other-server-key',
    });
    expect(await sealingKeyPins.get('server-1', 'controller-2')).toBeNull();

    await sealingKeyPins.set('server-1', 'controller-1', 'trusted-key');
    expect(await sealingKeyPins.get('server-1', 'controller-1')).toMatchObject({
      key: 'trusted-key',
    });
  });

  it('refuses a pin it cannot read rather than taking it for none', async () => {
    await fixture.db.insert(kv).values({
      key: `sealing-key-pin:${JSON.stringify(['server-1', 'controller-1'])}`,
      value: '{"key":',
      updatedAt: Date.now(),
    });

    await expect(sealingKeyPins.get('server-1', 'controller-1')).rejects.toThrow();
  });
});
