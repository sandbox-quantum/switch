import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  FILE_KIND_CODE_NAMES,
  FILE_KIND_EXTENSIONS,
  FILE_KIND_LOOK,
  FILE_KIND_WORDS,
  FileKindIcon,
  fileKind,
  spokenKind,
} from "./fileKind";

// Pinned to the shared explorer spec (motion and icons, 7 Nov), as Console's
// `file-kind.test.ts` is: the same eight kinds, extensions, colours and words.
// Change the spec first, then both apps.

afterEach(cleanup);
const file = (name: string) => ({ name, kind: "file" as const });

describe("file kinds, as in the shared explorer spec", () => {
  it("maps exactly the spec's extensions and names to each kind", () => {
    expect(FILE_KIND_EXTENSIONS).toEqual({
      markdown: ["md", "markdown"],
      code: [
        "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h",
        "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "sql", "css", "scss", "less", "html", "vue", "svelte",
      ],
      data: ["json", "csv", "tsv", "yaml", "yml", "toml", "xml", "ini", "env"],
      image: ["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp"],
      video: ["mp4", "webm", "mov", "mkv", "avi"],
      archive: ["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar"],
    });
    expect(FILE_KIND_CODE_NAMES).toEqual(["dockerfile", "makefile"]);
  });

  it("gives each kind the spec's soft colour, light and dark, and its words", () => {
    expect(
      Object.fromEntries(Object.entries(FILE_KIND_LOOK).map(([kind, look]) => [kind, [look.light, look.dark]])),
    ).toEqual({
      folder: ["#B7791F", "#F6C453"],
      markdown: ["#2B6CB0", "#7FB3F5"],
      code: ["#6B46C1", "#B794F4"],
      data: ["#2C7A7B", "#6FD3D0"],
      image: ["#2F855A", "#7AD39B"],
      video: ["#C53030", "#F28B8B"],
      archive: ["#C05621", "#F6AD6B"],
      other: [null, null],
    });
    expect(FILE_KIND_WORDS).toEqual({
      folder: "Folder",
      markdown: "Markdown file",
      code: "Code file",
      data: "Data file",
      image: "Image",
      video: "Video",
      archive: "Archive",
      other: "File",
    });
  });

  it("decides from the name alone, lower-cased, after the last dot", () => {
    expect(fileKind({ name: "src", kind: "folder" })).toBe("folder");
    expect(fileKind({ name: "notes.md", kind: "folder" })).toBe("folder");
    expect(fileKind(file("README.MD"))).toBe("markdown");
    expect(fileKind(file("app.test.tsx"))).toBe("code");
    expect(fileKind(file("Dockerfile"))).toBe("code");
    expect(fileKind(file("data.csv"))).toBe("data");
    expect(fileKind(file("logo.svg"))).toBe("image");
    expect(fileKind(file("demo.webm"))).toBe("video");
    expect(fileKind(file("build.tar.gz"))).toBe("archive");
    for (const name of ["notes.txt", "report.pdf", "server.log", "LICENSE", "trailing.", ".env.local"])
      expect(fileKind(file(name))).toBe("other");
    expect(fileKind(file(".env"))).toBe("data");
  });

  it("hides the icon from screen readers and says the kind in words instead", () => {
    const { container } = render(
      <>
        <FileKindIcon entry={file("a.md")} />
        <FileKindIcon entry={{ name: "f", kind: "folder" }} open />
      </>,
    );
    const icons = [...container.querySelectorAll("svg")];
    expect(icons.map((icon) => icon.getAttribute("data-file-kind"))).toEqual(["markdown", "folder"]);
    expect(icons.every((icon) => icon.getAttribute("aria-hidden") === "true")).toBe(true);
    expect(icons[1]!.getAttribute("data-testid")).toBe("FolderOpenIcon");
    expect(spokenKind(file("README.md"))).toBe("Markdown file");
  });
});
