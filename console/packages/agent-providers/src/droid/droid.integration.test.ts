import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createDroidAdapter, hasFactoryAuth } from './droid-adapter';

describeConformance('droid', {
  createAdapter: async () => createDroidAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('droid', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return 'the droid binary is not on PATH';
    if (!process.env.FACTORY_API_KEY && !hasFactoryAuth(process.env)) {
      return 'no Factory credentials found; set FACTORY_API_KEY or run droid to sign in';
    }
    return null;
  },
  skip: {
    'user-input':
      'No interactive user input observed over headless ACP stdio (internal AskUser tool auto-cancels); capability left off (userInput: false).',
    'steer-mid-turn':
      'Concurrent prompts during an active turn are rejected with -32600 "A prompt is already running for this session"; capability left off (steering: false).',
    subagent:
      'Factory Droid executes tasks directly and does not expose subagent spawning over ACP.',
  },
  mcpServers: { echo: echoMcpServerSpec() },
  model: process.env.DROID_MODEL
    ? { id: process.env.DROID_MODEL }
    : { id: 'custom:gemini-flash-lite-latest-0' },
  env: {
    FACTORY_APPEND_SYSTEM_PROMPT:
      'When asked to run a shell command, always attempt to execute it using the Execute tool. Never decline or assume you lack permission without calling the Execute tool first.',
    ...(process.env.FACTORY_API_KEY ? { FACTORY_API_KEY: process.env.FACTORY_API_KEY } : {}),
    ...(process.env.FACTORY_HOME_OVERRIDE
      ? { FACTORY_HOME_OVERRIDE: process.env.FACTORY_HOME_OVERRIDE }
      : {}),
    ...(process.env.DBUS_SESSION_BUS_ADDRESS
      ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS }
      : {}),
    ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
  },
});
