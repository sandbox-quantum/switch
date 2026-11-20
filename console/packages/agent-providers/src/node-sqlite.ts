import type * as Sqlite from 'node:sqlite';

/**
 * Node's built-in `node:sqlite`, loaded when first needed rather than when
 * this package is imported. Node 22 announces it as experimental on first
 * load; that one warning is dropped here and every other passes through.
 */
export function loadNodeSqlite(): typeof Sqlite {
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string })?.type;
    if (type === 'ExperimentalWarning' && text.startsWith('SQLite is an experimental feature'))
      return;
    (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return process.getBuiltinModule('node:sqlite') as typeof Sqlite;
  } finally {
    process.emitWarning = emitWarning;
  }
}
