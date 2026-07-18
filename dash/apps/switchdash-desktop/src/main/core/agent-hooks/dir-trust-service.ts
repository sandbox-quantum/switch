import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { claudeTrustService } from './claude-trust-service';
import { cursorTrustService } from './cursor-trust-service';

type DirTrustLocalArgs = {
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

export const dirTrustService = new DirTrustService([
  claudeTrustService,
  cursorTrustService,
]);
