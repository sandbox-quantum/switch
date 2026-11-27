import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GiveMachineLogin, type OperationOutcome } from './give-machine-login';
import {
  type MachineProviderRow,
  type MachineProvidersHost,
  MachineProvidersTable,
} from './machine-providers';

const KEY = ['machines-of', 'server-1'] as const;

afterEach(cleanup);

function row(extra: Partial<MachineProviderRow> = {}): MachineProviderRow {
  return {
    provider: 'claude',
    name: 'Claude',
    icon: null,
    installed: true,
    version: '2.1.0',
    signIn: { tone: 'warning', label: 'Not signed in', detail: 'no credentials' },
    source: null,
    checked: { label: '5 min ago', title: 'yesterday' },
    canGive: true,
    canRecheck: true,
    ...extra,
  };
}

/** Counts reads of the app's machines, kept under `[...KEY, 'machines']` as the table expects. */
function Machines({ read }: { read: () => string }) {
  const machines = useQuery({ queryKey: [...KEY, 'machines'], queryFn: read });
  return <p>machines: {machines.data}</p>;
}

function renderWith(node: React.ReactNode, read = vi.fn(() => 'read')) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Machines read={read} />
      {node}
    </QueryClientProvider>
  );
  return read;
}

function host(extra: Partial<MachineProvidersHost> = {}): MachineProvidersHost {
  return {
    queryKey: KEY,
    recheck: vi.fn(async () => 'op-1'),
    recheckOutcome: vi.fn(async (): Promise<OperationOutcome> => ({ state: 'succeeded' })),
    giveLogin: (_provider, onClose) => (
      <button type="button" onClick={onClose}>
        the login form
      </button>
    ),
    failureText: (error, fallback) => `${fallback} ${(error as Error).message}`,
    ...extra,
  };
}

describe('MachineProvidersTable', () => {
  it('lists installed providers first, each with its sign-in, where it comes from and when it was checked', () => {
    renderWith(
      <MachineProvidersTable
        machineName="laptop"
        rows={[
          row({
            provider: 'cursor',
            name: 'Cursor',
            installed: false,
            version: null,
            canGive: false,
            canRecheck: false,
          }),
          row({
            signIn: { tone: 'ok', label: 'Signed in', detail: null },
            source: 'On the device',
            canGive: false,
          }),
        ]}
        host={host()}
      />
    );
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows.map((each) => each.textContent)).toEqual([
      'ClaudeInstalled · v2.1.0Signed inOn the device5 min agoRecheck',
      'CursorNot installed——5 min ago',
    ]);
  });

  it('says so when the machine has reported nothing', () => {
    renderWith(<MachineProvidersTable machineName="laptop" rows={[]} host={host()} />);
    expect(screen.getByText('Not reported yet.')).toBeInTheDocument();
  });

  it('rechecks a provider, shows it checking, and reads the machines again once it is done', async () => {
    let finish: (outcome: OperationOutcome) => void = () => {};
    const app = host({
      recheckOutcome: vi.fn(
        () =>
          new Promise<OperationOutcome>((resolve) => {
            finish = resolve;
          })
      ),
    });
    const read = renderWith(
      <MachineProvidersTable machineName="laptop" rows={[row()]} host={app} />
    );
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole('button', { name: 'Recheck Claude on laptop' }));
    expect(app.recheck).toHaveBeenCalledWith('claude');
    await waitFor(() => expect(app.recheckOutcome).toHaveBeenCalledWith('op-1'));
    expect(screen.getByText('Checking…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Recheck Claude on laptop' })).toBeDisabled();

    finish({ state: 'succeeded' });
    await waitFor(() => expect(screen.getByText('Not signed in')).toBeInTheDocument());
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  });

  it('shows why a recheck failed, in the machine’s words or the app’s', async () => {
    renderWith(
      <MachineProvidersTable
        machineName="laptop"
        rows={[row()]}
        host={host({
          recheckOutcome: async () => ({ state: 'failed', message: 'laptop did not answer.' }),
        })}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Recheck Claude on laptop' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('laptop did not answer.');

    const refused = vi.fn(async () => {
      throw new Error('Refused.');
    });
    renderWith(
      <MachineProvidersTable machineName="desk" rows={[row()]} host={host({ recheck: refused })} />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Recheck Claude on desk' }));
    expect(
      await screen.findByText('Could not ask desk to check Claude. Refused.')
    ).toBeInTheDocument();
  });

  it('opens the app’s login form for a provider it can give one to, and closes it', async () => {
    renderWith(
      <MachineProvidersTable
        machineName="laptop"
        rows={[row(), row({ provider: 'codex', name: 'Codex', canGive: false, canRecheck: false })]}
        host={host()}
      />
    );
    const [claude, codex] = screen.getAllByRole('row').slice(1);
    expect(within(codex!).queryByRole('button', { name: /Give login/ })).toBeNull();
    expect(within(codex!).queryByRole('button', { name: /Recheck/ })).toBeNull();

    await userEvent.click(within(claude!).getByRole('button', { name: /Give login/ }));
    await userEvent.click(screen.getByRole('button', { name: 'the login form' }));
    expect(screen.queryByRole('button', { name: 'the login form' })).toBeNull();
  });
});

describe('GiveMachineLogin', () => {
  function form(extra: Partial<React.ComponentProps<typeof GiveMachineLogin>> = {}) {
    const props: React.ComponentProps<typeof GiveMachineLogin> = {
      machineName: 'laptop',
      provider: 'claude',
      providerName: 'Claude',
      kinds: [
        { value: 'api-key', label: 'API key' },
        { value: 'vertex', label: 'Vertex AI' },
      ],
      thisComputer: false,
      queryKey: KEY,
      give: vi.fn(async () => 'op-9'),
      outcome: vi.fn(async (): Promise<OperationOutcome> => ({ state: 'succeeded' })),
      failureText: (_error, fallback) => fallback,
      onClose: vi.fn(),
      ...extra,
    };
    return props;
  }

  it('gives the key typed in, says the provider signs in, and reads the machines again', async () => {
    const props = form();
    const read = renderWith(<GiveMachineLogin {...props} />);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Give login' })).toBeDisabled();

    await userEvent.type(screen.getByLabelText('API key', { selector: 'input' }), 'sk-test');
    await userEvent.click(screen.getByRole('button', { name: 'Give login' }));

    expect(props.give).toHaveBeenCalledWith({
      source: 'typed',
      kind: 'api-key',
      credential: 'sk-test',
    });
    expect(await screen.findByText('Claude signs in on laptop.')).toBeInTheDocument();
    expect(props.outcome).toHaveBeenCalledWith('op-9');
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
  });

  it('offers a browser only a service account key for Vertex AI, and sends it with the project and region', async () => {
    const props = form();
    renderWith(<GiveMachineLogin {...props} />);
    await userEvent.click(screen.getByLabelText('Vertex AI'));
    expect(screen.queryByText("This computer's Google sign-in")).toBeNull();

    await userEvent.click(screen.getByLabelText('Service account key'));
    await userEvent.paste('{"type":"service_account"}');
    await userEvent.type(screen.getByLabelText('Google Cloud project'), 'acme-ai');
    await userEvent.click(screen.getByRole('button', { name: 'Give login' }));
    expect(props.give).toHaveBeenCalledWith({
      source: 'vertex',
      project: 'acme-ai',
      region: 'global',
      credentials: { from: 'key', json: '{"type":"service_account"}' },
    });
  });

  it('offers this computer’s Google sign-in where the app can send it', async () => {
    renderWith(<GiveMachineLogin {...form({ thisComputer: true })} />);
    await userEvent.click(screen.getByLabelText('Vertex AI'));
    expect(screen.getByLabelText("This computer's Google sign-in")).toBeInTheDocument();
  });

  it('shows a login the app refused, and one the machine could not sign in with', async () => {
    const props = form({
      give: vi
        .fn()
        .mockRejectedValueOnce(new Error('That is not a project id.'))
        .mockResolvedValueOnce('op-2'),
      outcome: async () => ({ state: 'failed', message: 'The key was refused.' }),
    });
    renderWith(<GiveMachineLogin {...props} />);
    await userEvent.type(screen.getByLabelText('API key', { selector: 'input' }), 'bad');
    await userEvent.click(screen.getByRole('button', { name: 'Give login' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That is not a project id.');

    await userEvent.type(screen.getByLabelText('API key', { selector: 'input' }), 'bad');
    await userEvent.click(screen.getByRole('button', { name: 'Give login' }));
    expect(await screen.findByText('The key was refused.')).toBeInTheDocument();
  });

  it('gives Codex the sign-in file picked, and refuses a file that is not one', async () => {
    const props = form({
      provider: 'codex',
      providerName: 'Codex',
      kinds: [
        { value: 'api-key', label: 'API key' },
        { value: 'auth-json', label: 'Sign-in file' },
      ],
    });
    renderWith(<GiveMachineLogin {...props} />);
    await userEvent.click(screen.getByLabelText('Sign-in file'));
    expect(screen.queryByLabelText('API key', { selector: 'input' })).toBeNull();
    expect(screen.getByText(/~\/\.codex\/auth\.json/)).toBeInTheDocument();

    const picker = screen.getByLabelText('Codex sign-in file');
    await userEvent.upload(
      picker,
      new File(['not json'], 'broken.json', { type: 'application/json' })
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('broken.json cannot be used.');
    expect(screen.getByRole('button', { name: 'Give login' })).toBeDisabled();

    const auth = '{"auth_mode":"chatgpt","tokens":{"refresh_token":"placeholder"}}';
    await userEvent.upload(picker, new File([auth], 'auth.json', { type: 'application/json' }));
    expect(await screen.findByText('Read auth.json')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Give login' }));
    expect(props.give).toHaveBeenCalledWith({
      source: 'typed',
      kind: 'auth-json',
      credential: auth,
    });
  });
});
