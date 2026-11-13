import {
  AREAS,
  PAGES,
  RAIL,
  REDIRECTS,
  SETTINGS_MENUS,
  type MatrixLayout,
  type MatrixSettingsArea,
  type Persona,
} from '../../../../../gateway/src/routes/roleMatrix.ts';
import type { GatewayUi, PageState } from '../gateway-ui.ts';
import type { PageObjects } from './world.ts';

/**
 * The role matrix (`gateway/src/routes/roleMatrix.ts`) checked against the
 * dashboard a signed-in person is shown. Each check returns every place the
 * dashboard and the matrix disagree, rather than stopping at the first, so one
 * run lists everything a change broke.
 */

/** A catalogue slug for the connector detail page, which is not built yet. */
const CONNECTOR = 'github';

/** The object an `:id` parameter names, by what the path starts with. */
const ID_BY_PREFIX: readonly [string, Exclude<keyof PageObjects, 'names'>][] = [
  ['/resources/references/', 'referenceId'],
  ['/resources/documents/', 'documentId'],
  ['/resources/packages/', 'packageId'],
  ['/resources/templates/', 'templateId'],
  ['/templates/', 'templateId'],
];

/** A route's path with its parameters filled in from `objects`. */
export function fill(path: string, objects: PageObjects): string {
  let filled = path
    .replace(':roomId', objects.roomId)
    .replace(':documentId', objects.documentId)
    .replace(':agentId', objects.agentId)
    .replace(':connectorId', CONNECTOR);
  if (filled.includes(':id')) {
    const entry = ID_BY_PREFIX.find(([prefix]) => path.startsWith(prefix));
    if (entry === undefined) {
      throw new Error(
        `Nothing fills :id in ${path}; add the object it names to RoleWorld.objects.`
      );
    }
    filled = filled.replace(':id', objects[entry[1]]);
  }
  if (/:[A-Za-z]/.test(filled)) {
    throw new Error(`${path} has a parameter the role matrix cannot fill; add it to fill().`);
  }
  return filled;
}

/** Where the app should end up when `persona` opens a URL, and what it should show there. */
export interface Landing {
  path: string;
  /** A query the landing carries, as `key=value`, when it must. */
  query: string | null;
  state: PageState;
}

/**
 * Where opening `path` lands `persona` in `layout`: following redirects, then
 * into a settings area's first page, then onto the page or its refusal.
 */
export function landingOf(layout: MatrixLayout, persona: Persona, path: string): Landing {
  let target = path;
  let query: string | null = null;
  for (let hops = 0; ; hops += 1) {
    if (hops > 10) throw new Error(`The matrix's redirects from ${path} go round in a circle.`);
    const redirect = REDIRECTS[layout].find((row) => row.from === target);
    if (redirect === undefined) break;
    const [to, search] = redirect.to.split('?', 2) as [string, string | undefined];
    target = to;
    if (search !== undefined) query = search;
  }
  const area = AREAS[layout].find((row) => row.path === target);
  if (area !== undefined) {
    if (!area.open.includes(persona)) return { path: target, query, state: 'refused' };
    target = area.first;
  }
  const page = PAGES[layout].find((row) => row.path === target);
  if (page === undefined) {
    throw new Error(`The matrix sends ${path} to ${target}, which it has no row for.`);
  }
  if (!page.open.includes(persona)) return { path: target, query, state: 'refused' };
  return { path: target, query, state: page.status === 'planned' ? 'planned' : 'page' };
}

/** `landing` with its path's parameters filled in from `objects`. */
export function filled(landing: Landing, objects: PageObjects): Landing {
  return { ...landing, path: fill(landing.path, objects) };
}

/**
 * Open `url` and say how where it landed differs from `expected` (its path
 * filled in), if it does.
 */
export async function openAndCompare(
  ui: GatewayUi,
  url: string,
  expected: Landing
): Promise<string | null> {
  // A settings area opens the page it last showed; the matrix says where it
  // opens the first time.
  await ui.forgetRemembered();
  await ui.open(url);
  const at = new URL(ui.page.url());
  const state = await ui.pageState();
  const wrongPath = at.pathname !== expected.path;
  const wrongQuery = expected.query !== null && !at.search.includes(expected.query);
  if (!wrongPath && !wrongQuery && state === expected.state) return null;
  const query = expected.query === null ? '' : `?${expected.query}`;
  return `${url}: wanted ${expected.path}${query} (${expected.state}), got ${at.pathname}${at.search} (${state})`;
}

/**
 * A page about one object, opened as itself, shows that object: its name is
 * on the page. The status checks alone would pass a page that loaded someone
 * else's thing, or nothing at all, without a word.
 */
async function missingObject(
  ui: GatewayUi,
  url: string,
  objects: PageObjects
): Promise<string | null> {
  const id = url.split('/').at(-1);
  const name = id === undefined ? undefined : objects.names[id];
  if (name === undefined) return null;
  const shown = await ui.page.getByText(name, { exact: true }).first().isVisible();
  return shown ? null : `${url}: the page does not show ${name}`;
}

/** Every page and settings area of the layout, opened by URL. */
export async function checkPages(
  ui: GatewayUi,
  persona: Persona,
  objects: PageObjects,
  log: (message: string) => void
): Promise<string[]> {
  const paths = [...AREAS[ui.layout], ...PAGES[ui.layout]].map((row) => row.path);
  const wrong: string[] = [];
  for (const path of paths) {
    const url = fill(path, objects);
    const expected = filled(landingOf(ui.layout, persona, path), objects);
    const problem = await openAndCompare(ui, url, expected);
    if (problem !== null) wrong.push(problem);
    else if (expected.state === 'page') {
      const missing = await missingObject(ui, url, objects);
      if (missing !== null) wrong.push(missing);
    }
  }
  log(`opened ${paths.length} pages and settings areas`);
  return wrong;
}

/** Every redirect of the layout, followed to where it lands. */
export async function checkRedirects(
  ui: GatewayUi,
  persona: Persona,
  objects: PageObjects,
  log: (message: string) => void
): Promise<string[]> {
  const wrong: string[] = [];
  for (const { from } of REDIRECTS[ui.layout]) {
    const problem = await openAndCompare(
      ui,
      fill(from, objects),
      filled(landingOf(ui.layout, persona, from), objects)
    );
    if (problem !== null) wrong.push(problem);
  }
  log(`followed ${REDIRECTS[ui.layout].length} redirects`);
  return wrong;
}

/** The rail's labels, in order. */
export async function checkRail(ui: GatewayUi, persona: Persona): Promise<string[]> {
  const rail = (await ui.navLinks()).map((link) => link.label);
  const expected = RAIL[ui.layout][persona];
  return sameList(rail, expected) ? [] : [`rail: wanted ${list(expected)}, got ${list(rail)}`];
}

/** Each settings area's landmark, by the title it is labelled with. */
const AREA_TITLE: Record<MatrixSettingsArea, string> = {
  workspace: 'Workspace settings',
  organization: 'Organization settings',
  platform: 'Platform',
};

const AREA_PATH: Record<MatrixSettingsArea, string> = {
  workspace: '/settings',
  organization: '/settings/org',
  platform: '/platform',
};

/**
 * Each settings area's menu in the new layout, and the link across from the
 * workspace's settings to the organization's. An area the role may not enter
 * is the page checks' business.
 */
export async function checkSettingsMenus(ui: GatewayUi, persona: Persona): Promise<string[]> {
  if (ui.layout !== 'v2') return [];
  const wrong: string[] = [];
  const areaPaths = new Set(Object.values(AREA_PATH));
  for (const area of ['workspace', 'organization', 'platform'] as const) {
    const expected = SETTINGS_MENUS[area][persona];
    if (expected === null) continue;
    await ui.open(AREA_PATH[area]);
    const links = await ui.linksIn(
      ui.page.getByRole('navigation', { name: AREA_TITLE[area], exact: true })
    );
    const menu = links.filter((link) => !areaPaths.has(link.path)).map((link) => link.label);
    if (!sameList(menu, expected)) {
      wrong.push(`${AREA_TITLE[area]} menu: wanted ${list(expected)}, got ${list(menu)}`);
    }
    if (area === 'workspace') {
      const across = links.some((link) => link.path === AREA_PATH.organization);
      const allowed = SETTINGS_MENUS.organization[persona] !== null;
      if (across !== allowed) {
        wrong.push(
          `Workspace settings menu: wanted ${allowed ? 'a' : 'no'} link to Organization settings`
        );
      }
    }
  }
  return wrong;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function list(values: readonly string[]): string {
  return values.length === 0 ? '(none)' : values.join(', ');
}
