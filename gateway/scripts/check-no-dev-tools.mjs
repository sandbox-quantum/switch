/* Fails a production build that still carries the dev-only tools in `src/dev/`.
 *
 * They are left out because a build reads `import.meta.env.DEV` as false,
 * which drops the only import of them (`src/layout/DevRoleSlot.tsx`). That
 * holds only while nothing imports them another way, so every build checks it:
 * `npm run build` runs this after `vite build`, and so does everything that
 * builds the dashboard through it (the images, Switch Console's bundled copy,
 * CI). A role switcher that shipped would let whoever opens the page pick who
 * they are.
 *
 * Run: npm run build (or node scripts/check-no-dev-tools.mjs after one)
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { devToolsIn } from "./dev-tools.mjs";

const dist = fileURLToPath(new URL("../dist", import.meta.url));
const files = [];
for (const name of await readdir(dist, { recursive: true })) {
  const path = join(dist, name);
  if (!(await stat(path)).isFile()) continue;
  files.push([relative(process.cwd(), path), await readFile(path, "utf8")]);
}
const found = devToolsIn(files);
for (const [path, marker] of found) console.error(`${path} carries "${marker}"`);
if (found.length > 0) {
  console.error(
    "This build carries dev-only tools from src/dev/, which must never ship. " +
      "Import them only behind import.meta.env.DEV, as src/layout/DevRoleSlot.tsx does.",
  );
  process.exit(1);
}
console.log("no dev-only tools in the build");
