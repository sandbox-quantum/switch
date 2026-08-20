import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { ClaudeTrustService } from './claude-trust-service';
import { CodexTrustService } from './codex-trust-service';
import { CursorTrustService } from './cursor-trust-service';
import type { TrustServiceDeps } from './trust-config-io';

export type DirTrustLocalArgs = {
  providerId: AgentProviderId;
  cwd?: string;
  homedir: string;
  force?: boolean;
};

type DirTrustProvider = {
  maybeAutoTrustLocal(args: DirTrustLocalArgs): Promise<void>;
};

export class DirTrustService {
  constructor(private readonly providers: readonly DirTrustProvider[]) {}

  async maybeAutoTrustLocal(args: DirTrustLocalArgs): Promise<void> {
    for (const provider of this.providers) {
      await provider.maybeAutoTrustLocal(args);
    }
  }
}

/**
 * Build the trust writers for one machine.
 *
 * Takes its settings and logger rather than reaching for the app's, because a
 * remote session's prompts have to be cleared on the VM it runs on: the sidecar
 * builds the same set with its own logger and the setting carried in its launch
 * spec. Writing them here would only clear the prompts on the wrong computer.
 *
 * Kept apart from the desktop's own instance so importing this does not drag
 * the Electron-bound settings service and file logger into the sidecar bundle.
 */
export function createDirTrustService(deps: TrustServiceDeps): DirTrustService {
  return new DirTrustService([
    new ClaudeTrustService(deps),
    new CodexTrustService(deps),
    new CursorTrustService(deps),
  ]);
}
