import type { SharedHostConfig } from '@switch-console/agent-providers';
import { describe, expect, it } from 'vitest';
import {
  type AgentObservation,
  type AgentRunner,
  emptyObservation,
  type InProcessRuntime,
  type LaunchOptions,
} from './runtime';
import { AgentRuntimes } from './runtimes';

/** A runner that keeps one agent's liveness in memory and records what it was asked. */
class FakeRunner implements AgentRunner {
  readonly calls: string[] = [];
  alive = false;

  constructor(readonly name: string) {}

  async observe(): Promise<AgentObservation> {
    return { ...emptyObservation(), alive: this.alive };
  }

  async launch(_agentId: string, _template: SharedHostConfig, options: LaunchOptions) {
    this.calls.push(`launch ${options.isolation}`);
    this.alive = true;
  }

  async stop(_agentId: string, options: { wait: boolean }) {
    this.calls.push(`stop wait=${options.wait}`);
    this.alive = false;
  }

  async close() {
    this.calls.push('close');
  }
}

const TEMPLATE = {} as SharedHostConfig;
const options = (isolation: 'shared' | 'isolated'): LaunchOptions => ({
  isolation,
  restart: false,
  replaceIdentity: false,
  clearTakenOver: false,
});

function runtimes() {
  const shared = new FakeRunner('shared');
  const isolated = new FakeRunner('isolated');
  return {
    shared,
    isolated,
    runtimes: new AgentRuntimes(shared as unknown as InProcessRuntime, isolated),
  };
}

describe('AgentRuntimes', () => {
  it('runs each agent the way its definition asks', async () => {
    const { shared, isolated, runtimes: both } = runtimes();
    await both.launch('agent-1', TEMPLATE, options('isolated'));
    expect(isolated.calls).toEqual(['launch isolated']);
    expect(shared.calls).toEqual([]);
    expect((await both.observe('agent-1')).alive).toBe(true);
  });

  it('stops the one running an agent before the other starts it', async () => {
    const { shared, isolated, runtimes: both } = runtimes();
    await both.launch('agent-1', TEMPLATE, options('shared'));
    await both.launch('agent-1', TEMPLATE, options('isolated'));
    expect(shared.calls).toEqual(['launch shared', 'stop wait=true']);
    expect(isolated.calls).toEqual(['launch isolated']);
    await both.launch('agent-1', TEMPLATE, options('shared'));
    expect(isolated.calls).toEqual(['launch isolated', 'stop wait=true']);
    expect(shared.alive).toBe(true);
  });

  it('stops an agent wherever it runs, and closes both', async () => {
    const { shared, isolated, runtimes: both } = runtimes();
    await both.stop('agent-1', { wait: false });
    await both.close();
    expect(shared.calls).toEqual(['stop wait=false', 'close']);
    expect(isolated.calls).toEqual(['stop wait=false', 'close']);
  });
});
