/**
 * `readJson(path)` for scripts run with `node -e` on an execution host.
 *
 * Every writer of these files writes a temporary file and renames it into
 * place, yet a status check has been seen reading a watcher's config cut off
 * mid-way. A read that does not parse is tried again a few times over about
 * 200 ms; one that still does not parse raises, naming the file. A missing
 * file raises the usual ENOENT for the caller to handle.
 */
export const READ_JSON = String.raw`
const readJson = (p) => {
  for (let attempt = 0; ; attempt++) {
    const text = require('node:fs').readFileSync(p, 'utf8');
    try { return JSON.parse(text); }
    catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
      if (attempt >= 4) throw new Error(p + ' is not readable JSON (' + text.length + ' bytes): ' + e.message);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
};
`;
