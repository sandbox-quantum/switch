/* What tells a build apart from one that carries the dev-only tools in
 * `src/dev/`, for `check-no-dev-tools.mjs` and its tests.
 */

/** Strings each dev tool cannot work without, so minifying keeps them. */
export const DEV_MARKERS = ["/__dev/role-accounts", "dev-role-switcher"];

/** Every `[path, marker]` where a built file names a marker. Throws when
 * there are no files, rather than passing a build with nothing in it. */
export function devToolsIn(files) {
  if (files.length === 0) throw new Error("the build holds no files to check");
  return files.flatMap(([path, text]) =>
    DEV_MARKERS.filter((marker) => text.includes(marker)).map((marker) => [path, marker]),
  );
}
