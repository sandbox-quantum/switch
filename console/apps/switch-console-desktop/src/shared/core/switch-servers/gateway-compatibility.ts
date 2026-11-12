import { artifactVersion, type ContractRange, contractRange } from '@switch-console/shared';
import type { SwitchServerDeclaration } from './switch-servers';

/** What this build of Switch Console is, for the gateway API. */
export type ConsoleGatewaySide = {
  version: string;
  range: ContractRange;
};

export const THIS_CONSOLE: ConsoleGatewaySide = {
  version: artifactVersion('switch-console'),
  range: contractRange('gateway-api', 'switch-console'),
};

/**
 * Whether a server and this Console can use the gateway API together, read
 * from the `gateway-api` range the server declares on every session response.
 *
 * `undeclared` is a server that said nothing usable: one from before version
 * disclosure, or a malformed declaration. Nothing is known either way, so it is
 * reported as unknown rather than read as compatible or as too old.
 */
export type GatewayCompatibility =
  | { kind: 'compatible'; revision: number }
  | { kind: 'undeclared'; message: string }
  | { kind: 'server-too-old'; message: string }
  | { kind: 'console-too-old'; message: string };

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function serverRange(declaration: SwitchServerDeclaration | null): ContractRange | null {
  const contracts: unknown = declaration?.contracts;
  if (contracts === null || typeof contracts !== 'object') return null;
  const declared: unknown = (contracts as Record<string, unknown>)['gateway-api'];
  if (declared === null || typeof declared !== 'object') return null;
  const { speaks, accepts } = declared as Partial<ContractRange>;
  if (!isRevision(speaks) || !isRevision(accepts) || accepts > speaks) return null;
  return { speaks, accepts };
}

export function gatewayCompatibility(
  serverName: string,
  declaration: SwitchServerDeclaration | null,
  ours: ConsoleGatewaySide
): GatewayCompatibility {
  const server = serverRange(declaration);
  const core = declaration?.version
    ? `switch-core ${declaration.version}`
    : 'switch-core of an unknown version';
  const app = `Switch Console ${ours.version}`;
  if (server === null) {
    return {
      kind: 'undeclared',
      message: `${serverName} (${core}) does not say which gateway API revision it speaks, so ${app} cannot tell whether they work together.`,
    };
  }
  if (server.speaks < ours.range.accepts) {
    return {
      kind: 'server-too-old',
      message: `${serverName} runs ${core}, which is too old for ${app}: it speaks gateway API revision ${server.speaks}, and this Console needs ${ours.range.accepts} or newer. Update the server.`,
    };
  }
  if (server.accepts > ours.range.speaks) {
    return {
      kind: 'console-too-old',
      message: `${app} is too old for ${serverName}, which runs ${core}: it needs gateway API revision ${server.accepts} or newer, and this Console speaks up to ${ours.range.speaks}. Update Switch Console.`,
    };
  }
  return { kind: 'compatible', revision: Math.min(server.speaks, ours.range.speaks) };
}
