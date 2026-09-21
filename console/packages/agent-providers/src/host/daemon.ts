import { resolve } from 'node:path';
import { startHostServer } from './server';

const root = process.argv[2];
if (!root) throw new Error('SDK host requires its private state directory.');
const host = await startHostServer(resolve(root));
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void host.close().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(String(error));
      process.exit(1);
    }
  );
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
