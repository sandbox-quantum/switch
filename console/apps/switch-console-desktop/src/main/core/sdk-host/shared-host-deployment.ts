import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    const existing = await ctx.exec('node', [
      '-e',
      "const fs=require('node:fs');try{console.log(require('node:crypto').createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex')===process.argv[2])}catch(e){if(e.code!=='ENOENT')throw e;console.log(false)}",
      entrypoint,
      hash,
    ]);
    const temporary = `shared-host-${hash}.${randomUUID()}.tmp`;
    try {
      if (existing.stdout.trim() !== 'true') {
        await fs.copyLocalFile(bundle, temporary);
        await ctx.exec('node', [
          '-e',
          "require('node:fs').renameSync(process.argv[1],process.argv[2])",
          `${directory}/${temporary}`,
          entrypoint,
        ]);
      }
    } finally {
      fs.close();
      await ctx.exec('node', [
        '-e',
        "require('node:fs').rmSync(process.argv[1],{force:true})",
        `${directory}/${temporary}`,
      ]);
    }
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

export async function runSharedHostCommand(
  transport: LocationTransport,
  deployed: Awaited<ReturnType<typeof deploySharedHost>>,
  config: unknown,
  mode: '--ensure' | '--ensure-watch' | '--restart',
  resuming: boolean
) {
  const local = await mkdtemp(join(tmpdir(), 'switch-sdk-launch-'));
  const localFile = join(local, 'config.json');
  let remote: string | null = null;
  try {
    await writeFile(localFile, JSON.stringify(config), { mode: 0o600 });
    let configPath = localFile;
    if (transport.kind === 'ssh') {
      const proxy = await ensureSshConnected(transport.connectionId, transport.host);
      const result = await deployed.ctx.exec('node', [
        '-e',
        "const fs=require('node:fs'),path=require('node:path');const parent=path.dirname(process.argv[1]);fs.mkdirSync(parent,{recursive:true,mode:0o700});console.log(fs.mkdtempSync(path.join(parent,'.launch-')))",
        deployed.root,
      ]);
      remote = result.stdout.trim();
      const fs = new SshFileSystem(proxy, remote);
      try {
        await fs.copyLocalFile(localFile, 'config.json');
      } finally {
        fs.close();
      }
      configPath = `${remote}/config.json`;
      await deployed.ctx.exec('node', [
        '-e',
        "require('node:fs').chmodSync(process.argv[1],0o600)",
        configPath,
      ]);
    }
    return await deployed.ctx.exec('node', [
      deployed.entrypoint,
      deployed.root,
      configPath,
      mode,
      String(resuming),
    ]);
  } finally {
    try {
      if (remote)
        await deployed.ctx.exec('node', [
          '-e',
          "require('node:fs').rmSync(process.argv[1],{recursive:true,force:true})",
          remote,
        ]);
    } finally {
      await rm(local, { recursive: true, force: true });
    }
  }
}
