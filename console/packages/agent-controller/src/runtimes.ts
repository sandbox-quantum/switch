import type { ProviderReadiness, SharedHostConfig } from '@switch-console/agent-providers';
import type {
  AgentObservation,
  AgentRunner,
  AgentRuntime,
  LaunchOptions,
  RelayCredentials,
} from './runtime';
import type { Provider } from './schemas';

/**
 * Runs each agent the way its definition asks: its host in this controller's
 * process (`shared`), or in a process of its own (`isolated`). The agent's
 * state root is the same either way, so moving it from one to the other is a
 * restart: whichever runs it now is stopped before the other starts it. One
 * runner may fill both slots, where every agent runs the same way.
 */
export class AgentRuntimes implements AgentRuntime {
  constructor(
    private readonly shared: AgentRuntime,
    private readonly isolated: AgentRunner
  ) {}

  private get single(): boolean {
    return this.shared === this.isolated;
  }

  async observe(agentId: string): Promise<AgentObservation> {
    if (this.single) return this.shared.observe(agentId);
    const inProcess = await this.shared.observe(agentId);
    if (inProcess.alive) return inProcess;
    const ownProcess = await this.isolated.observe(agentId);
    return ownProcess.alive
      ? ownProcess
      : { ...inProcess, health: inProcess.health ?? ownProcess.health };
  }

  async launch(agentId: string, template: SharedHostConfig, options: LaunchOptions): Promise<void> {
    const [chosen, other] =
      options.isolation === 'isolated'
        ? [this.isolated, this.shared]
        : [this.shared, this.isolated];
    if (!this.single && (await other.observe(agentId)).alive)
      await other.stop(agentId, { wait: true });
    await chosen.launch(agentId, template, options);
  }

  async stop(agentId: string, options: { wait: boolean }): Promise<void> {
    await this.shared.stop(agentId, options);
    if (!this.single) await this.isolated.stop(agentId, options);
  }

  async close(): Promise<void> {
    await this.shared.close();
    if (!this.single) await this.isolated.close();
  }

  watcherRoot(agentId: string): string {
    return this.shared.watcherRoot(agentId);
  }

  credentialsPath(agentId: string): string {
    return this.shared.credentialsPath(agentId);
  }

  readCredentials(agentId: string): Promise<RelayCredentials | null> {
    return this.shared.readCredentials(agentId);
  }

  writeCredentials(agentId: string, credentials: RelayCredentials): Promise<void> {
    return this.shared.writeCredentials(agentId, credentials);
  }

  deleteCredentials(agentId: string): Promise<void> {
    return this.shared.deleteCredentials(agentId);
  }

  workingDirectory(name: string, directory: string | null): Promise<string> {
    return this.shared.workingDirectory(name, directory);
  }

  probe(provider: Provider, binaryPath: string, cwd: string): Promise<ProviderReadiness> {
    return this.shared.probe(provider, binaryPath, cwd);
  }
}
