import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcError } from '@shared/lib/ipc/rpc-error';

const openGatewayPage = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock('@renderer/lib/ipc', () => ({ rpc: { switchServers: { openGatewayPage } } }));
vi.mock('sonner', () => ({ toast: { error: toastError } }));

const { openServerPage } = await import('./open-server-page');

describe('openServerPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('asks the main process to open the page on that server', async () => {
    openGatewayPage.mockResolvedValue(undefined);

    await openServerPage('srv', 'https://switch.example.com/rooms/1');

    expect(openGatewayPage).toHaveBeenCalledWith({
      serverId: 'srv',
      url: 'https://switch.example.com/rooms/1',
    });
    expect(toastError).not.toHaveBeenCalled();
  });

  it('says why when the server has no dashboard to open', async () => {
    const message = 'Team does not serve its dashboard at https://switch-api.example.com.';
    openGatewayPage.mockRejectedValue(
      new RpcError({
        __switchConsoleRpcError: true,
        code: 'NoDashboardError',
        message,
      } as unknown as ConstructorParameters<typeof RpcError>[0])
    );

    await openServerPage('srv', 'https://switch-api.example.com/');

    expect(toastError).toHaveBeenCalledWith(message, undefined);
  });

  it('falls back to a plain sentence for a failure it does not recognise', async () => {
    openGatewayPage.mockRejectedValue(new Error('boom'));

    await openServerPage('srv', 'https://switch.example.com/');

    expect(toastError).toHaveBeenCalledWith('Could not open the dashboard.', {
      description: 'boom',
    });
  });
});
