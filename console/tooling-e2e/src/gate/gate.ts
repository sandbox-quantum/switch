/**
 * The coverage gate: every agent operation and gateway route the server has is
 * accounted for, by a scenario that covers it or an exemption that says why not.
 *
 * It reads the server's surface from a committed snapshot
 * (`surface/server-surface.json`, written by `scripts/e2e_surface.py`, kept
 * current by that script's `--check` in CI), so it needs no server and runs as
 * an ordinary unit test on every PR. A new operation or route therefore fails
 * the build until a scenario covers it or an exemption names it, with a reason.
 *
 * `surface/exemptions.json` holds three lists:
 *
 * - `exempt`: deliberately not covered end to end, each with its reason;
 * - `unauthenticated`: routes that take no credential at all, each with the
 *   reason that is right. A route that loses its session check fails here
 *   until someone says why that is fine;
 * - `backlog`: what was uncovered when the gate landed. It only shrinks: an
 *   entry a scenario now covers fails until it is removed.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ScenarioHeader } from '../core/scenario.ts';

export type RouteAuth = 'session' | 'operator-token' | 'none';

export interface ServerSurface {
  operations: string[];
  gatewayRoutes: {
    route: string;
    auth: RouteAuth;
    /** The feature flags the route is mounted behind; it exists only with all of them on. */
    flags: string[];
  }[];
}

export interface Exemptions {
  exempt: Record<string, string>;
  unauthenticated: Record<string, string>;
  backlog: string[];
}

const SURFACE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'surface'
);

export function readSurface(): ServerSurface {
  return JSON.parse(
    readFileSync(path.join(SURFACE_DIR, 'server-surface.json'), 'utf8')
  ) as ServerSurface;
}

export function readExemptions(): Exemptions {
  const raw = JSON.parse(readFileSync(path.join(SURFACE_DIR, 'exemptions.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  return {
    exempt: raw.exempt as Record<string, string>,
    unauthenticated: raw.unauthenticated as Record<string, string>,
    backlog: raw.backlog as string[],
  };
}

/**
 * Route prefixes the snapshot does not hold yet, so a `covers` entry under one
 * is taken on trust. Any other route has to be one the snapshot has: a typo
 * would otherwise read as coverage while the real route stays uncovered.
 */
const UNCHECKED_ROUTE_PREFIXES = ['/agents/'];

function unchecked(entry: string): boolean {
  const [, path] = entry.split(' ', 2);
  return path !== undefined && UNCHECKED_ROUTE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** Every problem, so one pass fixes them all. Empty when the gate passes. */
export function coverageProblems(
  surface: ServerSurface,
  exemptions: Exemptions,
  headers: readonly ScenarioHeader[]
): string[] {
  const problems: string[] = [];
  const known = new Set([...surface.operations, ...surface.gatewayRoutes.map((r) => r.route)]);

  const coveredBy = new Map<string, string[]>();
  for (const header of headers) {
    for (const entry of header.covers) {
      if (unchecked(entry)) continue;
      if (!known.has(entry)) {
        problems.push(
          `${header.id} covers '${entry}', which the server does not have ` +
            `(renamed, removed, or a typo? the snapshot is surface/server-surface.json)`
        );
        continue;
      }
      coveredBy.set(entry, [...(coveredBy.get(entry) ?? []), header.id]);
    }
  }

  const backlog = new Set(exemptions.backlog);
  for (const entry of exemptions.backlog) {
    if (!known.has(entry))
      problems.push(`backlog lists '${entry}', which the server does not have`);
    else if (coveredBy.has(entry)) {
      problems.push(
        `backlog lists '${entry}', which ${coveredBy.get(entry)!.join(', ')} now covers — remove it`
      );
    }
  }
  if (backlog.size !== exemptions.backlog.length) problems.push('backlog lists an entry twice');

  for (const [entry, reason] of Object.entries(exemptions.exempt)) {
    if (!known.has(entry)) problems.push(`exempt lists '${entry}', which the server does not have`);
    else if (coveredBy.has(entry)) {
      problems.push(
        `exempt lists '${entry}', which ${coveredBy.get(entry)!.join(', ')} covers — remove it`
      );
    }
    if (reason.trim() === '') problems.push(`exempt lists '${entry}' without a reason`);
    if (backlog.has(entry)) problems.push(`'${entry}' is both exempt and in the backlog`);
  }

  for (const entry of known) {
    if (!coveredBy.has(entry) && !(entry in exemptions.exempt) && !backlog.has(entry)) {
      problems.push(
        `'${entry}' is covered by no scenario: add one whose header covers it, or ` +
          `exempt it in surface/exemptions.json with the reason`
      );
    }
  }

  const unauthenticated = new Set(
    surface.gatewayRoutes.filter((r) => r.auth === 'none').map((r) => r.route)
  );
  for (const route of unauthenticated) {
    if (!(route in exemptions.unauthenticated)) {
      problems.push(
        `'${route}' takes no credential: if that is right, list it under ` +
          `unauthenticated in surface/exemptions.json with the reason`
      );
    }
  }
  for (const [route, reason] of Object.entries(exemptions.unauthenticated)) {
    if (!unauthenticated.has(route)) {
      problems.push(`unauthenticated lists '${route}', which is not a route taking no credential`);
    }
    if (reason.trim() === '') problems.push(`unauthenticated lists '${route}' without a reason`);
  }

  return problems;
}
