import { expect, it, vi } from 'vitest';

vi.mock('../paths', () => ({ localServerDir: () => '/tmp/switch-local-server' }));
vi.mock('../docker', () => ({ detectDocker: vi.fn(), dockerExecutable: () => 'docker' }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const { LocalServerHost } = await import('./local-host');

it('shares nothing with anyone, so a start here publishes nothing and takes no lock', () => {
  expect(new LocalServerHost().sharedState).toBeNull();
});
