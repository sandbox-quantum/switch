export interface SessionEnvContext {
  sessionId: string;
  sessionName: string;
  sessionPath: string;
  rootPath: string;
  portSeed?: string;
}

export function getSessionEnvVars(ctx: SessionEnvContext): Record<string, string> {
  const sessionName = slugify(ctx.sessionName) || 'session';
  const portSeed = ctx.portSeed || ctx.sessionPath || ctx.sessionId;
  return {
    SWITCHDASH_SESSION_ID: ctx.sessionId,
    SWITCHDASH_SESSION_NAME: sessionName,
    SWITCHDASH_SESSION_PATH: ctx.sessionPath,
    SWITCHDASH_ROOT_PATH: ctx.rootPath,
    SWITCHDASH_PORT: String(getBasePort(portSeed)),
  };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function getBasePort(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  return 50000 + (Math.abs(hash) % 1000) * 10;
}
