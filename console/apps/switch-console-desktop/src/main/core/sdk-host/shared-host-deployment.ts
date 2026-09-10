import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolveSharedHostBundlePath } from '@main/core/agent-runtime/impl/resolve-sidecar-bundle';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import { SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { SshFileSystem } from '@main/core/fs/impl/ssh-fs';
import type { LocationTransport } from '@main/core/locations/location-transport';
import { ensureSshConnected } from '@main/core/ssh/connect/connect-agent-ssh';

export async function deploySharedHost(
  transport: LocationTransport,
  sessionPath: string,
  identity: string,
  watcher: boolean
) {
  let ctx: IExecutionContext;
  const bundle = resolveSharedHostBundlePath();
  const hash = createHash('sha256')
    .update(await readFile(bundle))
    .digest('hex');
  const key = createHash('sha256').update(identity).digest('hex');
  let entrypoint = bundle;
  if (transport.kind === 'ssh') {
    const proxy = await ensureSshConnected(transport.connectionId, transport.host);
    ctx = new SshExecutionContext(proxy, { root: sessionPath });
    const { stdout } = await ctx.exec('node', [
      '-e',
      "console.log(require('node:path').join(require('node:os').homedir(),'.local','state','switch','sdk-host'))",
    ]);
    const directory = stdout.trim();
    await ctx.exec('node', [
      '-e',
      "require('node:fs').mkdirSync(process.argv[1],{recursive:true,mode:0o700})",
      directory,
    ]);
    const fs = new SshFileSystem(proxy, directory);
    entrypoint = `${directory}/shared-host-${hash}.mjs`;
    const temporary = `shared-host-${hash}.${randomUUID()}.tmp`;
    try {
      await fs.copyLocalFile(bundle, temporary);
    } finally {
      fs.close();
    }
    await ctx.exec('node', [
      '-e',
      "require('node:fs').renameSync(process.argv[1],process.argv[2])",
      `${directory}/${temporary}`,
      entrypoint,
    ]);
  } else ctx = new LocalExecutionContext();
  const { stdout } = await ctx.exec('node', [
    '-e',
    "const fs=require('node:fs'),path=require('node:path');const base=path.join(require('node:os').homedir(),'.local','state','switch',process.argv[2]);let root=path.join(base,process.argv[1]);if(process.argv[2]==='sdk-watchers'&&fs.existsSync(base)){const matches=fs.readdirSync(base).filter(name=>{try{return JSON.parse(fs.readFileSync(path.join(base,name,'config.json'),'utf8')).session.agentId===process.argv[3]}catch(e){if(e.code==='ENOENT')return false;throw e}});if(matches.length>1)throw new Error('Competing saved watchers require explicit cleanup.');if(matches.length)root=path.join(base,matches[0]);} console.log(root)",
    key,
    watcher ? 'sdk-watchers' : 'sdk-sessions',
    identity,
  ]);
  const root = stdout.trim();
  return { ctx, root, entrypoint };
}
