import { describe, expect, it } from "vitest";
import {
  agentFolder,
  blobType,
  CLOUD_FILES_CODES,
  cloudFilesMessage,
  hasHostedAgent,
  looksLikeText,
  openablePath,
  parentPath,
  previewKind,
  safeSuggestedName,
  sortEntries,
  zipLabel,
  type CloudFileEntry,
} from "./cloudFiles";

const folder = (name: string, over: Partial<CloudFileEntry> = {}): CloudFileEntry => ({
  name,
  kind: "folder",
  size: 0,
  mtime: 0,
  ...over,
});

describe("previewKind", () => {
  it("shows only PNG, JPEG, GIF and WebP as images", () => {
    expect(previewKind("a.png", 1)).toEqual({ kind: "image", mimeType: "image/png" });
    expect(previewKind("a.JPG", 1)).toEqual({ kind: "image", mimeType: "image/jpeg" });
    expect(previewKind("a.gif", 1)).toEqual({ kind: "image", mimeType: "image/gif" });
    expect(previewKind("a.webp", 1)).toEqual({ kind: "image", mimeType: "image/webp" });
  });

  it("never previews SVG, HTML, XHTML or PDF: download only", () => {
    for (const name of ["art.svg", "page.html", "page.htm", "x.xhtml", "doc.pdf"])
      expect(previewKind(name, 1)).toEqual({ kind: "download" });
  });

  it("shows text, code and Markdown as plain text, up to 1 MB", () => {
    expect(previewKind("notes.txt", 1)).toEqual({ kind: "text" });
    expect(previewKind("readme.md", 1)).toEqual({ kind: "text" });
    expect(previewKind("README", 1)).toEqual({ kind: "text" });
    expect(previewKind("big.txt", 1024 * 1024 + 1)).toEqual({ kind: "download" });
    expect(previewKind("big.png", 10 * 1024 * 1024 + 1)).toEqual({ kind: "download" });
  });
});

describe("blobType", () => {
  it("keeps the four image types, and makes anything else bytes only", () => {
    expect(blobType("image/png")).toBe("image/png");
    expect(blobType("IMAGE/WEBP; x=y")).toBe("image/webp");
    for (const type of ["text/html", "image/svg+xml", "application/xhtml+xml", ""])
      expect(blobType(type)).toBe("application/octet-stream");
  });
});

describe("looksLikeText", () => {
  it("is text only without NUL and as valid UTF-8", () => {
    expect(looksLikeText(new TextEncoder().encode("hello – world"))).toBe(true);
    expect(looksLikeText(new Uint8Array([104, 0, 105]))).toBe(false);
    expect(looksLikeText(new Uint8Array([0xff, 0xfe]))).toBe(false);
  });
});

describe("safeSuggestedName", () => {
  it("keeps the base name only, with nothing that could escape or hide it", () => {
    expect(safeSuggestedName("../x", "file")).toBe("x");
    expect(safeSuggestedName("a\\b.txt", "file")).toBe("b.txt");
    expect(safeSuggestedName(".bashrc", "file")).toBe("bashrc");
    expect(safeSuggestedName("bad\r\nname.txt", "file")).toBe("badname.txt");
    expect(safeSuggestedName("", "file")).toBe("file");
  });
});

describe("openablePath", () => {
  it("opens plain names only", () => {
    expect(openablePath("shared/sample-bakery")).toBe("shared/sample-bakery");
    for (const bad of ["", "/etc", "a/../b", "./a", "a//b", "a/", null, 7, "a\0b"]) expect(openablePath(bad)).toBeNull();
  });
});

describe("agentFolder", () => {
  const entries = [
    folder("web", { label: "Web Frontend", agent: "web-frontend" }),
    folder("shared", { label: "Shared" }),
  ];

  it("finds the folder by the agent key, never the label, and never Shared", () => {
    expect(agentFolder(entries, "web-frontend")?.name).toBe("web");
    expect(agentFolder(entries, "Web Frontend")).toBeNull();
    expect(agentFolder(entries, "Shared")).toBeNull();
  });
});

describe("sortEntries", () => {
  it("puts agent folders before Shared at the top level, then files", () => {
    const entries = [
      { name: "notes.txt", kind: "file", size: 1, mtime: 0 } as CloudFileEntry,
      folder("shared", { label: "Shared" }),
      folder("baker", { agent: "baker" }),
    ];
    expect(sortEntries(entries, true).map((e) => e.name)).toEqual(["baker", "shared", "notes.txt"]);
  });
});

describe("hasHostedAgent", () => {
  it("needs a v2 box with an agent", () => {
    expect(hasHostedAgent([{ backend: "box", agents: ["a1"], state: "ready" }])).toBe(true);
    expect(hasHostedAgent([{ backend: "box", agents: [], state: "ready" }])).toBe(false);
    expect(hasHostedAgent([{ backend: "vm", agents: ["a1"], state: "ready" }])).toBe(false);
    expect(hasHostedAgent([{ backend: "box", agents: ["a1"], state: "deleted" }])).toBe(false);
    expect(hasHostedAgent(null)).toBe(false);
  });
});

describe("cloudFilesMessage", () => {
  it("has a plain message for every code, with no path in it", () => {
    for (const code of [...CLOUD_FILES_CODES, "unreachable", "unknown"] as const) {
      expect(cloudFilesMessage(code).length).toBeGreaterThan(5);
      expect(cloudFilesMessage(code)).not.toMatch(/\/|workspaces/);
    }
  });
});

describe("parentPath and zipLabel", () => {
  it("climbs one folder, and names the zip by where you are", () => {
    expect(parentPath("shared/sample-bakery/menu.csv")).toBe("shared/sample-bakery");
    expect(parentPath("README.md")).toBe("");
    expect(zipLabel("")).toBe("Download all as zip");
    expect(zipLabel("shared")).toBe("Download folder as zip");
  });
});
