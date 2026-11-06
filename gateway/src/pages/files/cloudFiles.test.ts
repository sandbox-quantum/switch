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
  videoTypeFromBytes,
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
      expect(previewKind(name, 1)).toEqual({ kind: "download", reason: "type" });
  });

  it("plays mp4 and webm up to the 25 MB file cap, and nothing else", () => {
    expect(previewKind("clip.mp4", 1)).toEqual({ kind: "video", mimeType: "video/mp4" });
    expect(previewKind("clip.webm", 1)).toEqual({ kind: "video", mimeType: "video/webm" });
    expect(previewKind("clip.mp4", 25 * 1024 * 1024 + 1)).toEqual({ kind: "download", reason: "too_large" });
    expect(previewKind("clip.mov", 1)).toEqual({ kind: "download", reason: "type" });
  });

  it("tells Markdown, JSON, CSV, code and plain text apart, up to 1 MB", () => {
    expect(previewKind("notes.txt", 1)).toEqual({ kind: "text" });
    expect(previewKind("readme.md", 1)).toEqual({ kind: "markdown" });
    expect(previewKind("data.json", 1)).toEqual({ kind: "json" });
    expect(previewKind("menu.csv", 1)).toEqual({ kind: "csv", delimiter: "," });
    expect(previewKind("menu.tsv", 1)).toEqual({ kind: "csv", delimiter: "\t" });
    expect(previewKind("app.py", 1)).toEqual({ kind: "code", language: "python" });
    expect(previewKind("Makefile", 1)).toEqual({ kind: "code", language: "makefile" });
    expect(previewKind("README", 1)).toEqual({ kind: "text" });
    expect(previewKind("big.txt", 1024 * 1024 + 1)).toEqual({ kind: "download", reason: "too_large" });
    expect(previewKind("big.png", 10 * 1024 * 1024 + 1)).toEqual({ kind: "download", reason: "too_large" });
  });
});

describe("videoTypeFromBytes", () => {
  it("plays only bytes that match the extension's type", () => {
    const mp4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2]);
    expect(videoTypeFromBytes(mp4, "video/mp4")).toBe("video/mp4");
    expect(videoTypeFromBytes(webm, "video/webm")).toBe("video/webm");
    expect(videoTypeFromBytes(webm, "video/mp4")).toBeNull();
    expect(videoTypeFromBytes(new TextEncoder().encode("<html><script>"), "video/webm")).toBeNull();
    expect(videoTypeFromBytes(mp4, "text/html")).toBeNull();
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
