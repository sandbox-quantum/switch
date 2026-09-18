import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';

export function legacyTmuxNames(sessionIds: string[], directory: string, slug: string): string[] {
  const panes = sessionIds.map(
    (id) => `switchdash-${Buffer.from(`session-${id}`).toString('base64url')}`
  );
  const hash = createHash('sha256').update(`${directory}\0${slug}`).digest('hex').slice(0, 16);
  return [...panes, ...panes.map((name) => `${name}-sidecar`), `switchdash-sidecar-${hash}`];
}

/** Runs on the execution host. Absence is safe; a failed inspection isn't. */
export const inspectLegacyTmux = `
const {spawnSync}=require('node:child_process');
if(process.platform==='win32'){console.log('[]');process.exit(0)}
const result=spawnSync('tmux',['list-sessions','-F','#{session_name}'],{encoding:'utf8',timeout:10000});
if(result.error?.code==='ENOENT'){console.log('[]');process.exit(0)}
if(result.error)throw result.error;
if(result.status!==0){
  if(/no server running|no sessions|error connecting to .*No such file or directory/.test(result.stderr)){console.log('[]');process.exit(0)}
  throw new Error('Cannot check previous terminal sessions: '+result.stderr);
}
const targets=new Set(JSON.parse(process.argv[1]));
console.log(JSON.stringify(result.stdout.trim().split('\\n').filter(name=>targets.has(name))));
`;

export async function assertLegacySessionsStopped(
  ctx: IExecutionContext,
  agentId: string,
  directory: string,
  slug: string
): Promise<void> {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.agentId, agentId));
  const { stdout } = await ctx.exec(
    'node',
    [
      '-e',
      inspectLegacyTmux,
      JSON.stringify(
        legacyTmuxNames(
          rows.map((row) => row.id),
          directory,
          slug
        )
      ),
    ],
    { timeout: 15_000 }
  );
  const active: unknown = JSON.parse(stdout);
  if (!Array.isArray(active))
    throw new Error('Could not verify whether previous terminal sessions have stopped.');
  if (active.length) {
    throw new Error(
      'This agent still has terminal sessions from the previous Switch Console. Stop those sessions and its old automatic-session sidecar on the execution computer, then retry. Your saved conversations have not been deleted.'
    );
  }
}
