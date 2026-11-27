export type BuddyProviderState = 'ready' | 'sign-in' | 'install' | 'checking';

export type BuddyProvider = {
  id: string;
  name: string;
  state: BuddyProviderState;
  detail: string | null;
  loginHelps: boolean;
};

type ProviderStatus = {
  provider: string;
  ready: boolean;
  problem: string | null;
  detail: string | null;
  loginHelps: boolean;
};

type ProviderDefinition = { id: string; name: string };
type MachineWithProviders = { providers: ProviderStatus[] };

export function buddyProviders(
  providers: readonly ProviderDefinition[],
  machine: MachineWithProviders | null
): BuddyProvider[] {
  return providers.map((provider) => {
    const reported = machine?.providers.find((entry) => entry.provider === provider.id);
    const state: BuddyProviderState = !reported
      ? 'checking'
      : reported.ready
        ? 'ready'
        : reported.problem === 'not installed'
          ? 'install'
          : reported.problem === 'login not checked yet'
            ? 'checking'
            : 'sign-in';
    return {
      id: provider.id,
      name: provider.name,
      state,
      detail: reported?.detail ?? null,
      loginHelps: reported?.loginHelps ?? true,
    };
  });
}

export const START_BUTTONS = 2;

const PREFERRED = ['claude', 'codex'];

function startOrder(providers: BuddyProvider[]): BuddyProvider[] {
  const rank = (id: string) => {
    const at = PREFERRED.indexOf(id);
    return at === -1 ? PREFERRED.length : at;
  };
  return [...providers].sort((a, b) => rank(a.id) - rank(b.id));
}

export function startButtons(
  providers: BuddyProvider[],
  outOfPatience: boolean
): BuddyProvider[] | null {
  const known = (provider: BuddyProvider) => provider.state !== 'checking';
  const preferred = providers.filter((provider) => PREFERRED.includes(provider.id));
  const decided =
    outOfPatience ||
    providers.every(known) ||
    (preferred.every(known) && preferred.some((provider) => provider.state === 'ready'));
  if (!decided) return null;
  return startOrder(providers.filter((provider) => provider.state === 'ready')).slice(
    0,
    START_BUTTONS
  );
}
