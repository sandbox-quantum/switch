import { readFile } from 'node:fs/promises';

/**
 * What a bundle may hold of box mode's own code, read from esbuild's metafile.
 *
 * Box-only code lives under a `box/` folder (`agent-providers/src/host/box/`,
 * built as agent-providers' `./box` export, `dist/box.mjs`; and
 * `agent-controller/src/box/`) and is reached only through a dynamic `import()`
 * inside a box-mode branch. esbuild puts a dynamically imported module in the
 * same file when it bundles without splitting, but wraps it so its code runs
 * only when that `import()` runs. So:
 *
 * - **desktop** (Switch Console's own controller and shared host): every box
 *   module must be reached only through dynamic imports from outside `box/`.
 *   A static import would run box code in every desktop process.
 * - **box** (the box image's package): the box modules must be in the bundle,
 *   so an image is never built without them.
 */

/**
 * Whether `path`, an esbuild metafile input path (relative to where the build
 * ran), is a box-only module of agent-providers or agent-controller.
 */
export function isBoxModule(path) {
  if (path.includes('node_modules/')) return false;
  // The controller takes agent-providers from its build: the `./box` export is `dist/box.mjs`.
  if (/(^|\/)agent-providers\/dist\/box\.mjs$/.test(path)) return true;
  return /(^|\/)((agent-providers|agent-controller)\/)?src\/(host\/)?box\//.test(path);
}

/**
 * Where a desktop bundle reaches a box module other than through a dynamic
 * import: each as "importer -> box module (kind)". Empty when it never does.
 */
export function staticBoxImports(metafile) {
  const found = [];
  for (const [path, input] of Object.entries(metafile.inputs)) {
    if (isBoxModule(path)) continue;
    for (const edge of input.imports ?? []) {
      if (edge.external || !isBoxModule(edge.path)) continue;
      if (edge.kind !== 'dynamic-import') found.push(`${path} -> ${edge.path} (${edge.kind})`);
    }
  }
  return found;
}

/** The box modules in `metafile`'s inputs. */
export function boxModules(metafile) {
  return Object.keys(metafile.inputs).filter(isBoxModule);
}

/** Refuses a desktop bundle that reaches box code statically. `name` names it in the error. */
export function assertDesktopBundle(metafile, name) {
  const found = staticBoxImports(metafile);
  if (found.length)
    throw new Error(
      `${name} imports box-only code outside a dynamic import, so desktop would run it:\n  ${found.join('\n  ')}`
    );
}

/** Refuses a box bundle with no box code in it. `name` names it in the error. */
export function assertBoxBundle(metafile, name) {
  if (!boxModules(metafile).length)
    throw new Error(`${name} has no box-only code in it, so it wasn't built for a box.`);
}

/**
 * An esbuild plugin for tests only: every box module, once bundled, throws as
 * soon as its own code runs. A desktop run of a bundle built with it then
 * fails loudly if it ever evaluates a box module, which a real desktop bundle
 * would do silently.
 */
export const boxEvaluationGuard = {
  name: 'box-evaluation-guard',
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /[\\/]src[\\/](host[\\/])?box[\\/].*\.ts$/ }, async (args) => {
      if (!isBoxModule(args.path.replaceAll('\\', '/'))) return null;
      const source = await readFile(args.path, 'utf8');
      return {
        contents: `throw new Error(${JSON.stringify(`box module evaluated outside box mode: ${args.path}`)});\n${source}`,
        loader: 'ts',
      };
    });
  },
};
