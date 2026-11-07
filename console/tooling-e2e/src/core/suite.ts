import { ConsoleChatClient } from '../clients/console-chat-client.ts';
import { SwitchClient } from '../clients/switch-client.ts';
import {
  laneFrom,
  loadEnv,
  readDotEnvFile,
  strictFrom,
  type HarnessEnv,
  type Lane,
} from './env.ts';
import { IssuedSecrets } from './secrets.ts';

/**
 * Whether this process runs a lane's suite at all, and the clients it runs with.
 */
export interface LaneTarget {
  env: HarnessEnv;
  switchClient: SwitchClient;
  /** The human side: the in-Console chat, as the gateway admin. */
  chat: ConsoleChatClient;
}

export type LaneResolution = { target: LaneTarget; skip: null } | { target: null; skip: string };

/**
 * Resolve a lane: configuration, then reachability.
 *
 * Not asked for this lane (`SWITCH_E2E_LANE` unset or naming the other one) is
 * always a skip — that is `pnpm -r test` on a developer machine. Asked for it
 * but unable to run (configuration missing, a server unreachable) skips with the
 * reason printed, or **throws** under `SWITCH_E2E_STRICT=1`, so CI cannot pass a
 * suite that never ran.
 */
export async function resolveLane(lane: Lane): Promise<LaneResolution> {
  const file = readDotEnvFile();
  const asked = laneFrom(process.env, file);
  if (asked !== lane) {
    return {
      target: null,
      skip: asked === null ? 'SWITCH_E2E_LANE is not set' : `SWITCH_E2E_LANE is '${asked}'`,
    };
  }
  const strict = strictFrom(process.env, file);
  const unable = (reason: string): LaneResolution => {
    if (strict) throw new Error(`The ${lane} lane cannot run (SWITCH_E2E_STRICT=1): ${reason}`);
    return { target: null, skip: reason };
  };

  let env: HarnessEnv;
  try {
    env = loadEnv(lane, process.env, file);
  } catch (error) {
    return unable(message(error));
  }

  const switchClient = new SwitchClient(
    env.switch,
    env.environment,
    new IssuedSecrets(env.secretsFile)
  );
  try {
    await switchClient.health();
  } catch (error) {
    return unable(`Switch server at ${env.switch.apiUrl} is unreachable: ${message(error)}`);
  }
  try {
    await switchClient.ready();
  } catch (error) {
    return unable(`Switch server at ${env.switch.apiUrl} is not ready: ${message(error)}`);
  }

  return { target: { env, switchClient, chat: new ConsoleChatClient(switchClient) }, skip: null };
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
