import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sessionSchema } from '@switch-console/shared/session-v1';
import { z } from 'zod';
import { adapterFor, startSchema } from './server';
import { runSharedHost } from './shared-host';

const [root, configPath] = process.argv.slice(2);
const agentApiUrl = process.env.SWITCH_API_ENDPOINT;
const token = process.env.SWITCH_API_TOKEN;
if (!root || !configPath || !agentApiUrl || !token)
  throw new Error(
    'Shared SDK host requires a new state directory, a configuration file, SWITCH_API_ENDPOINT and SWITCH_API_TOKEN.'
  );
const config = z
  .strictObject({ session: sessionSchema, start: startSchema })
  .parse(JSON.parse(await readFile(configPath, 'utf8')));
if (config.session.provider !== config.start.provider)
  throw new Error('Shared SDK host provider mismatch.');
const stop = new AbortController();
process.on('SIGTERM', () => stop.abort());
process.on('SIGINT', () => stop.abort());
await runSharedHost(
  { root: resolve(root), agentApiUrl, token, session: config.session, input: config.start.input },
  adapterFor(config.start.provider),
  stop.signal
);
