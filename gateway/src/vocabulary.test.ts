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

/** Words the dashboard no longer uses, each with what to write instead.
 * `alone` says whether a literal holding only the word counts: "server" on
 * its own is a value the server sends (a connector app's scope), and
 * Discord's name for a guild. */
const RETIRED: { word: RegExp; instead: string; alone: boolean }[] = [
  { word: /\bmachines?\b/i, instead: "device", alone: true },
  { word: /\bregistration keys?\b/i, instead: "API key", alone: true },
  { word: /\bregister agents?\b/i, instead: "Add agent", alone: true },
  {
    word: /(?<!\b(?:Discord|Mattermost) )\bservers?\b/i,
    instead: '"here", "Switch" or "Switch\'s configuration"',
    alone: false,
  },
  {
    word: /\bconnections?\b/i,
    instead: '"connector", or "messaging app" for a chat app',
    alone: true,
  },
  { word: /\bMatrix\b/, instead: "nothing: Switch no longer runs on Matrix", alone: true },
];

/** Hosted agents v2's own files, shown only with Core's `hosted_v2` flag on.
 * The operator pages name real cloud machines and the server. Their wording
 * is reviewed against this list before v2 is turned on for anyone; until
 * then they are listed one by one, so every other file stays checked. */
const V2_ONLY = new Set([
  "./pages/agents/CloudAgentDialog.tsx",
  "./pages/agents/cloud/yourCloud.ts",
  "./pages/agents/cloudAgent.ts",
  "./pages/hosted/HostedPage.tsx",
  "./pages/hosted/audit/auditWords.ts",
  "./pages/hosted/boxes/BoxesTab.tsx",
  "./pages/hosted/detail/BoxDetailPage.tsx",
  "./pages/hosted/detail/MachineDetailPage.tsx",
  "./pages/hosted/detail/detail.ts",
  "./pages/hosted/hostedActions.ts",
  "./pages/hosted/hostedTabs.ts",
  "./pages/hosted/machines/MachinesTab.tsx",
  "./pages/hosted/operators/OperatorsTab.tsx",
  "./pages/hosted/overview/OverviewTab.tsx",
  "./pages/hosted/overview/testing.ts",
]);

/** Uses of a retired word that mean something else, removed before checking. */
const ALLOWED = [
  // A network connection, not a connector.
  "secure connection",
  "lost its connection",
  "its connection stopped responding",
  // The controller's own command-line flag.
  "--server",
];

/** Text a person could read: JSX text, and string and template literals.
 * A literal holding one lowercase word is `alone`: often a key or a value
 * the server sends rather than copy, so only some words count there. One
 * lowercase token that is not a plain word is a path or a key, not copy. */
function copyIn(
  source: string,
  fileName: string,
): { line: number; text: string; alone: boolean }[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: { line: number; text: string; alone: boolean }[] = [];
  const add = (node: ts.Node, text: string, isJsxText: boolean) => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    const alone = !isJsxText && !/\s/.test(trimmed) && !/^[A-Z]/.test(trimmed);
    if (alone && !/^[a-z]+$/.test(trimmed)) return;
    found.push({ line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: trimmed, alone });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isJsxText(node)) add(node, node.text, true);
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node, node.text, false);
    else if (ts.isTemplateExpression(node)) {
      add(node, [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("…"), false);
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
      if (V2_ONLY.has(path)) continue;
      for (const { line, text, alone } of copyIn(source, path)) {
        const checked = ALLOWED.reduce((rest, allowed) => rest.split(allowed).join(" "), text);
        for (const { word, instead, alone: countsAlone } of RETIRED) {
          if (alone && !countsAlone) continue;
          const match = checked.match(word);
          if (match) problems.push(`${path}:${line} "${match[0]}" → ${instead}: ${text}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("lists only v2 files that still exist", () => {
    expect([...V2_ONLY].filter((path) => !(path in SOURCES))).toEqual([]);
  });
});
