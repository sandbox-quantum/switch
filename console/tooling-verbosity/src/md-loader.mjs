// Lets Node import `.md` files as text, as the bundler's `loader: { '.md': 'text' }`
// does for the shipped build (`packages/plugins/tsdown.config.ts`), so the skill
// module is imported as it is rather than re-read by hand.
import { register } from 'node:module';

register(
  'data:text/javascript,' +
    encodeURIComponent(`
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
export async function load(url, context, next) {
  if (!url.endsWith('.md')) return next(url, context);
  const text = await readFile(fileURLToPath(url), 'utf8');
  return { format: 'module', source: 'export default ' + JSON.stringify(text) + ';', shortCircuit: true };
}
`)
);
