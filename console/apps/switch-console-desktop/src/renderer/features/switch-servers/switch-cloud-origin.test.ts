import { describe, expect, it, vi } from 'vitest';

const switchCloud = vi.hoisted(() => vi.fn(async () => ({ url: 'https://cloud.example.com' })));

vi.mock('@renderer/lib/ipc', () => ({ rpc: { switchServers: { switchCloud } } }));
vi.mock('@renderer/utils/logger', () => ({ log: { error: vi.fn() } }));
vi.mock('./switch-servers-store', () => ({ switchServersStore: { servers: [] } }));

const { isSwitchCloudServer, loadSwitchCloudOrigin } = await import('./switch-cloud-origin');

describe('isSwitchCloudServer', () => {
  it('recognises the Cloud by its one address', async () => {
    await loadSwitchCloudOrigin();

    expect(isSwitchCloudServer({ url: 'https://cloud.example.com' })).toBe(true);
    expect(isSwitchCloudServer({ url: 'https://CLOUD.example.com/' })).toBe(true);
    expect(isSwitchCloudServer({ url: 'https://switch.example.com' })).toBe(false);
  });
});
