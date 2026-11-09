import ts from "typescript";
import { describe, expect, it } from "vitest";

/** Every source file's text, tests left out: what the dashboard can show.
 * Vitest's module cache can keep an older list of files on a developer's
 * machine, so a file added since is checked once that cache clears; CI
 * always starts without one. */
const SOURCES = import.meta.glob<string>(["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Words the dashboard no longer uses, each with what to write instead. */
const RETIRED: { word: RegExp; instead: string }[] = [
  { word: /\bmachines?\b/i, instead: "device" },
  { word: /\bregistration keys?\b/i, instead: "API key" },
  { word: /\bregister agents?\b/i, instead: "Add agent" },
  {
    word: /(?<!\b(?:Discord|Mattermost|MCP) )\bservers?\b/i,
    instead: '"here", "Switch" or "Switch\'s configuration"',
  },
  { word: /\bconnections?\b/i, instead: '"connector", or "messaging app" for a chat app' },
  { word: /\bMatrix\b/, instead: "nothing: Switch no longer runs on Matrix" },
];

/** Uses of a retired word that mean something else, removed before checking. */
const ALLOWED = [
  // A network connection, not a connector.
  "secure connection",
  "lost its connection",
  "its connection stopped responding",
  // The controller's own command-line flag.
  "--server",
];

/** Text a person could read: JSX text, and string and template literals
 * that hold more than one word or start with a capital. A lone lowercase
 * word is a key or a value the server sends, not copy. */
function copyIn(source: string, fileName: string): { line: number; text: string }[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: { line: number; text: string }[] = [];
  const add = (node: ts.Node, text: string) => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    if (!/\s/.test(trimmed) && !/^[A-Z]/.test(trimmed)) return;
    found.push({ line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: trimmed });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isJsxText(node)) add(node, node.text);
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node, node.text);
    else if (ts.isTemplateExpression(node)) {
      add(node, [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("…"));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe("dashboard vocabulary", () => {
  it("reads every source file", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(100);
  });

  it("uses none of the retired words", () => {
    const problems: string[] = [];
    for (const [path, source] of Object.entries(SOURCES)) {
      for (const { line, text } of copyIn(source, path)) {
        const checked = ALLOWED.reduce((rest, allowed) => rest.split(allowed).join(" "), text);
        for (const { word, instead } of RETIRED) {
          const match = checked.match(word);
          if (match) problems.push(`${path}:${line} "${match[0]}" → ${instead}: ${text}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
