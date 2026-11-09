/* Fails a production build that still carries the dev-only tools in `src/dev/`.
 *
 * They are left out because a build reads `import.meta.env.DEV` as false,
 * which drops the only import of them (`src/App.tsx`). That holds only while
 * nothing imports them another way, so every build checks it: `npm run build`
 * runs this after `vite build`, and so does everything that builds the
 * dashboard through it (the image, Switch Console's bundled copy, CI). A role
 * switcher that shipped would let whoever opens the page pick who they are.
 *
 * Run: npm run build (or node scripts/check-no-dev-tools.mjs after one)
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dist = fileURLToPath(new URL("../dist", import.meta.url));
  const entries = await readdir(dist, { recursive: true, withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const path = join(entry.parentPath, entry.name);
        return [relative(process.cwd(), path), await readFile(path, "utf8")];
      }),
  );
  const found = devToolsIn(files);
  for (const [path, marker] of found) console.error(`${path} carries "${marker}"`);
  if (found.length > 0) {
    console.error(
      "This build carries dev-only tools from src/dev/, which must never ship. " +
        "Import them only behind import.meta.env.DEV, as src/App.tsx does.",
    );
    process.exit(1);
  }
  console.log("no dev-only tools in the build");
}
