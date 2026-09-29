import { beforeEach, expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({
  getStatuses: vi.fn(() => []),
  detectDocker: vi.fn(),
  probe: vi.fn(),
  register: vi.fn(),
  start: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  stop: vi.fn(),
  reset: vi.fn(),
  cancelWait: vi.fn(),
}));
vi.mock('./remote-server-service', () => ({ remoteServerService: service }));

const { remoteSwitchServerController: rpc } = await import('./remote-controller');

beforeEach(() => vi.clearAllMocks());

it('hands the renderer’s shared-server calls to the supervisor for the host they name', async () => {
  // The renderer reaches the host only through these (CHOO-2893); each must
  // reach the supervisor with the host and name it was given.
  await rpc.probe('vm-1');
  await rpc.register('vm-1');
  await rpc.connect({ sshHost: 'vm-1', name: 'Team server' });
  await rpc.start({ sshHost: 'vm-1', name: 'Team server' });
  await rpc.disconnect('vm-1');
  await rpc.stop('vm-1');
  await rpc.reset('vm-1');
  await rpc.detectDocker('vm-1');
  await rpc.cancelWait('vm-1');

  expect(service.probe).toHaveBeenCalledWith('vm-1');
  expect(service.register).toHaveBeenCalledWith('vm-1');
  expect(service.connect).toHaveBeenCalledWith('vm-1', 'Team server');
  expect(service.start).toHaveBeenCalledWith('vm-1', 'Team server');
  expect(service.disconnect).toHaveBeenCalledWith('vm-1');
  expect(service.stop).toHaveBeenCalledWith('vm-1');
  expect(service.reset).toHaveBeenCalledWith('vm-1');
  expect(service.detectDocker).toHaveBeenCalledWith('vm-1');
  expect(service.cancelWait).toHaveBeenCalledWith('vm-1');
  expect(await rpc.getStatuses()).toEqual([]);
});
