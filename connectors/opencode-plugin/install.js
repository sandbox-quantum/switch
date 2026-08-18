#!/usr/bin/env node
/**
 * Installs this connector into an OpenCode installation.
 *
 * OpenCode has no marketplace, and installing the package from npm is not by
 * itself an install: npm puts the module in a cache, and OpenCode discovers a
 * skill only as a file in one of a few directories it reads. So the package
 * ships this command, and it is the one thing both consumers run — a user
 * setting OpenCode up by hand, and Switch Console installing on their behalf.
 *
 * Everything it writes comes from the files beside it, so there is no second
 * copy of the connector to keep in step: the MCP entry is `opencode.json`'s own
 * `mcp` block, and the skills are the directories under `skills/`.
 *
 *   npx -y <package> install     write the connector into ~/.config/opencode
 *   npx -y <package> uninstall   take it back out, leaving the rest alone
 *   npx -y <package> status      report what is installed, and exit 1 if not
 *
 * `--config-dir <path>` overrides the OpenCode config directory.
 */

import { realpathSync } from 'node:fs';
import { readFile, mkdir, writeFile, rename, rm, readdir, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** The key the Switch MCP server is registered under. */
const SERVER_NAME = 'switch';

/**
 * Records what was installed, beside the config rather than inside it.
 * OpenCode validates its config against a published schema that rejects
 * unknown keys, so bookkeeping cannot ride along in `opencode.json` without
 * risking a config the agent refuses to start with.
 */
const MARKER_FILE = 'switch-connector.json';

function defaultConfigDir() {
  return path.join(homedir(), '.config', 'opencode');
}

async function readIfPresent(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Write via a temporary file in the same directory, then rename.
 *
 * `opencode.json` is read by every OpenCode session on the machine. Writing it
 * in place leaves a window in which it is truncated or half-written, and a
 * process killed inside that window breaks every session until someone repairs
 * the file by hand. A rename within a directory is atomic, so a reader sees
 * either the old file or the new one.
 */
async function writeFileEnsuringDir(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, content, 'utf8');
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function packageVersion() {
  const manifest = JSON.parse(await readFile(path.join(PACKAGE_DIR, 'package.json'), 'utf8'));
  return manifest.version;
}

/**
 * The MCP entry this connector registers, read from the `opencode.json` it
 * ships. That file is what a reviewer reads to see what the connector does to
 * a user's config, so it is also what gets written — the alternative is a
 * second declaration in code that can disagree with it silently.
 */
async function declaredServerEntry() {
  const declared = JSON.parse(await readFile(path.join(PACKAGE_DIR, 'opencode.json'), 'utf8'));
  const entry = declared.mcp?.[SERVER_NAME];
  if (!entry) {
    throw new Error(`opencode.json declares no '${SERVER_NAME}' MCP server; the package is broken.`);
  }
  return entry;
}

/**
 * The skills this connector ships, by directory name. OpenCode derives a
 * skill's name from its folder and rejects one whose frontmatter disagrees, so
 * the directory name is carried through to the install unchanged.
 */
async function declaredSkills() {
  const skillsDir = path.join(PACKAGE_DIR, 'skills');
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const source = path.join(skillsDir, entry.name, 'SKILL.md');
    skills.push({ name: entry.name, content: await readFile(source, 'utf8') });
  }
  if (skills.length === 0) {
    throw new Error('The package ships no skills; the install would give a session tools and no instructions.');
  }
  return skills;
}

/**
 * The user's config, or an empty one — and never anything this cannot safely
 * put an MCP server into.
 *
 * A config we cannot use is not ours to rewrite: replacing it would discard
 * whatever the user has in there. Both shape checks matter as much as the
 * parse. A JSON document whose root is an array parses cleanly, takes the
 * assignments below without complaint, and then serialises back with them
 * dropped — so without this the install would report success having changed
 * nothing. A non-object `mcp` is worse: spreading it reshapes whatever was
 * there into a numeric-keyed object.
 */
function parseConfig(raw, configFile) {
  if (!raw?.trim()) return {};

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${configFile} is not valid JSON. Fix or move it, then install again.`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error(
      `${configFile} is not a JSON object — its root is ${Array.isArray(parsed) ? 'an array' : `a ${parsed === null ? 'null' : typeof parsed}`}. Fix or move it, then install again.`
    );
  }
  if ('mcp' in parsed && !isPlainObject(parsed.mcp)) {
    throw new Error(
      `${configFile} has an "mcp" value that is not an object. Fix or move it, then install again.`
    );
  }
  return parsed;
}

/**
 * The record of a previous install: which skills it wrote, so an uninstall can
 * remove those and nothing else.
 *
 * `switch` and `configure` are ordinary words, and the skill directory is
 * shared with whatever the user writes themselves. Without a record of what
 * this tool put there, uninstall is `rm -r` on a directory that may be mostly
 * someone else's work.
 */
async function readMarker(configDir) {
  const raw = await readIfPresent(path.join(configDir, MARKER_FILE));
  if (raw === null) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${path.join(configDir, MARKER_FILE)} is not valid JSON, so there is no record of what was installed. Remove it by hand, along with any Switch skills you recognise, and install again.`
    );
  }
  if (!isPlainObject(parsed)) return null;
  const listed = Array.isArray(parsed.skills)
    ? parsed.skills.filter((s) => typeof s === 'string')
    : null;
  return {
    version: typeof parsed.version === 'string' ? parsed.version : null,
    skills: listed ?? [],
    // Switch Console writes this file too, and so did earlier versions of this
    // command — neither records a skill list. A marker with no list still means
    // a Switch install is here, so what it left behind is ours to replace.
    listsSkills: listed !== null,
  };
}

/**
 * Whether a skill file at this path is one a Switch install put there.
 *
 * Three ways to be sure, because three things write these files. The marker's
 * list is the direct answer where there is one. A marker without a list is an
 * install by Switch Console or by an earlier version of this command, which
 * wrote exactly the skills their package shipped. And a file byte-identical to
 * the one about to replace it is ours whoever wrote it — overwriting it changes
 * nothing and deleting it loses nothing.
 *
 * Anything else is someone's own work, and is refused rather than replaced.
 */
async function isOursToReplace(target, name, content, marker) {
  const existing = await readIfPresent(target);
  if (existing === null) return true;
  if (existing === content) return true;
  if (marker === null) return false;
  return marker.listsSkills ? marker.skills.includes(name) : true;
}

/**
 * OpenCode loads `opencode.json` and `opencode.jsonc` and merges both, and on a
 * key they both define the `.jsonc` wins — measured, not assumed. So a user who
 * already has a `switch` server in their `.jsonc` would get an install that
 * writes to `.json`, reports success, and is then ignored by every session.
 *
 * Writing to the `.jsonc` instead is not the answer: it exists to hold comments,
 * and rewriting it through a JSON parser would strip them. Refuse and say where
 * the conflict is.
 */
async function assertNotShadowed(configDir) {
  const jsoncFile = path.join(configDir, 'opencode.jsonc');
  const raw = await readIfPresent(jsoncFile);
  if (raw === null || !raw.trim()) return;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Comments and trailing commas are the point of the format, so a file this
    // cannot read is expected rather than broken. Say it is there and move on.
    console.warn(
      `Note: ${jsoncFile} also exists and takes precedence over opencode.json. If the Switch tools do not appear, check it does not define its own "${SERVER_NAME}" MCP server.`
    );
    return;
  }

  if (isPlainObject(parsed) && isPlainObject(parsed.mcp) && SERVER_NAME in parsed.mcp) {
    throw new Error(
      `${jsoncFile} already defines an MCP server called "${SERVER_NAME}", and it takes precedence over opencode.json — installing there would have no effect. Remove that entry, then install again.`
    );
  }
}

async function install(configDir) {
  // Everything that can refuse does so before anything is written: a failure
  // half way through leaves a session with tools and no instructions, or
  // instructions and no tools.
  await assertNotShadowed(configDir);
  const configFile = path.join(configDir, 'opencode.json');
  const config = parseConfig(await readIfPresent(configFile), configFile);
  const entry = await declaredServerEntry();
  const skills = await declaredSkills();
  const marker = await readMarker(configDir);

  for (const skill of skills) {
    const target = path.join(configDir, 'skills', skill.name, 'SKILL.md');
    if (!(await isOursToReplace(target, skill.name, skill.content, marker))) {
      throw new Error(
        `${target} already exists and was not written by this connector. Move it aside, then install again.`
      );
    }
  }

  // OpenCode rewrites its own config to add `$schema` when it is missing;
  // writing it ourselves keeps that from showing up as a spurious change.
  config.$schema ??= 'https://opencode.ai/config.json';
  config.mcp = { ...config.mcp, [SERVER_NAME]: entry };
  await writeFileEnsuringDir(configFile, serialize(config));

  const written = [configFile];
  for (const skill of skills) {
    const target = path.join(configDir, 'skills', skill.name, 'SKILL.md');
    await writeFileEnsuringDir(target, skill.content);
    written.push(target);
  }

  const markerFile = path.join(configDir, MARKER_FILE);
  await writeFileEnsuringDir(
    markerFile,
    serialize({ version: await packageVersion(), skills: skills.map((s) => s.name) })
  );
  written.push(markerFile);

  return written;
}

async function uninstall(configDir) {
  const configFile = path.join(configDir, 'opencode.json');
  const marker = await readMarker(configDir);

  const raw = await readIfPresent(configFile);
  if (raw !== null) {
    const config = parseConfig(raw, configFile);
    if (config.mcp && SERVER_NAME in config.mcp) {
      // Only our own entry: the user's other MCP servers live in this file.
      const { [SERVER_NAME]: _removed, ...rest } = config.mcp;
      config.mcp = rest;
      if (Object.keys(rest).length === 0) delete config.mcp;
      await writeFileEnsuringDir(configFile, serialize(config));
    }
  }

  // Only skills a Switch install put there, and only the file it wrote — the
  // directory goes when it is empty, so anything the user keeps beside a skill
  // survives. Anything left is named rather than silently abandoned.
  const removed = [];
  const left = [];
  for (const skill of await declaredSkills()) {
    const directory = path.join(configDir, 'skills', skill.name);
    const target = path.join(directory, 'SKILL.md');
    if ((await readIfPresent(target)) === null) continue;

    if (await isOursToReplace(target, skill.name, skill.content, marker)) {
      await rm(target, { force: true });
      await rmdir(directory).catch(() => {});
      removed.push(skill.name);
    } else {
      left.push(target);
    }
  }
  await rm(path.join(configDir, MARKER_FILE), { force: true });

  return { removedSkills: removed, left };
}

/**
 * The version recorded at install, or null when the connector is not installed.
 *
 * The marker alone is not proof. Someone editing `opencode.json` by hand, or
 * `opencode mcp` rewriting it, can leave the marker behind with no server
 * registered — reporting that as installed hides the reason the session has no
 * Switch tools.
 */
async function installedVersion(configDir) {
  const marker = await readMarker(configDir);
  if (marker === null) return null;

  const configFile = path.join(configDir, 'opencode.json');
  const config = parseConfig(await readIfPresent(configFile), configFile);
  if (!config.mcp || !(SERVER_NAME in config.mcp)) return null;

  return marker.version;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  let configDir = defaultConfigDir();
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--config-dir') {
      const value = rest[i + 1];
      if (!value) throw new Error('--config-dir needs a path.');
      configDir = path.resolve(value);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${rest[i]}`);
  }
  return { command, configDir };
}

async function main(argv) {
  const { command, configDir } = parseArgs(argv);

  switch (command) {
    case 'install': {
      const written = await install(configDir);
      console.log(`Installed the Switch connector for OpenCode:\n${written.map((f) => `  ${f}`).join('\n')}`);
      console.log('\nStart an OpenCode session and run the `configure` skill to register an agent.');
      return 0;
    }
    case 'uninstall': {
      const { left } = await uninstall(configDir);
      console.log(`Removed the Switch connector from ${configDir}.`);
      if (left.length > 0) {
        console.log(
          `Left alone, because this connector did not write them:\n${left.map((f) => `  ${f}`).join('\n')}`
        );
      }
      return 0;
    }
    case 'status': {
      const version = await installedVersion(configDir);
      if (version === null) {
        console.log(`No Switch connector installed in ${configDir}.`);
        return 1;
      }
      console.log(`Switch connector ${version} installed in ${configDir}.`);
      return 0;
    }
    default:
      console.error('Usage: install | uninstall | status [--config-dir <path>]');
      return 2;
  }
}

export { install, uninstall, installedVersion };

/**
 * True when this file was run as a command rather than imported.
 *
 * Resolved through `realpath` because npm installs a `bin` as a symlink: run
 * the command and `argv[1]` is the link in `node_modules/.bin`, not this file.
 * Comparing the two directly is the common form of this check and it is wrong
 * in exactly the case that matters — every install anyone actually performs —
 * where it makes the command exit 0 having done nothing at all.
 */
function invokedAsCommand() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedAsCommand()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error.message);
      process.exit(1);
    }
  );
}
