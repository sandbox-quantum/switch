import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CloudFilesPage, { filterEntries } from "./CloudFilesPage";
import type { CloudFileEntry } from "./cloudFiles";
import { DOWNLOAD_REVOKE_MS } from "./cloudFiles";

// The preview modal is loaded on demand; load it once here so no test waits on the first import.
await import("./FilePreviewModal");

// Your cloud files in Switch web, with fetch mocked by address: hidden with no
// request unless both flags are on and there's a cloud agent, View files by
// the agent key, large folders ask first, a resting box offers Wake it, image
// previews are Blobs typed by the safe-image rule, and downloads never open a page.

const flags = vi.hoisted(() => ({ value: { hosted_v2: true, hosted_cloud_files: true } as Record<string, boolean> }));
vi.mock("../../data/hooks", () => ({
  useFeatureFlags: () => ({ data: flags.value, loading: false, error: null, refetch: () => {} }),
}));

const folder = (name: string, over: object = {}) => ({ name, kind: "folder", size: 0, mtime: 1_700_000_000_000, ...over });
const file = (name: string, size = 4) => ({ name, kind: "file", size, mtime: 1_700_000_000_000 });
const TOP = [
  folder("web-frontend", { label: "Web Frontend", agent: "web-frontend" }),
  folder("shared", { label: "Shared" }),
];

type Route = (url: URL) => Response | undefined;
let routes: Route[] = [];
const fetchMock = vi.fn(async (input: string) => {
  const url = new URL(input, "https://switch.example");
  for (const route of routes) {
    const answer = route(url);
    if (answer) return answer;
  }
  return new Response("{}", { status: 404 });
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const boxWithAgent: Route = (url) =>
  url.pathname === "/gateway/hosted-machines"
    ? json({ available: true, machines: [{ backend: "box", state: "ready", agents: ["a1"] }] })
    : undefined;
const listing =
  (byPath: Record<string, unknown[]>): Route =>
  (url) =>
    url.pathname === "/gateway/cloud-files/list" ? json({ entries: byPath[url.searchParams.get("path") ?? ""] ?? [] }) : undefined;
const listedPaths = () =>
  fetchMock.mock.calls
    .map(([input]) => new URL(input, "https://switch.example"))
    .filter((url) => url.pathname === "/gateway/cloud-files/list")
    .map((url) => url.searchParams.get("path"));

const createObjectURL = vi.fn((_blob: Blob) => "blob:preview");

beforeEach(() => {
  routes = [];
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  URL.createObjectURL = createObjectURL as never;
  URL.revokeObjectURL = vi.fn();
  createObjectURL.mockClear();
  flags.value = { hosted_v2: true, hosted_cloud_files: true };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function open(search = "") {
  render(
    <MemoryRouter initialEntries={[`/files${search}`]}>
      <CloudFilesPage />
    </MemoryRouter>,
  );
}

describe("Your cloud files (Switch web)", () => {
  it.each([
    ["hosted_cloud_files off", { hosted_v2: true, hosted_cloud_files: false }],
    ["hosted_v2 off", { hosted_v2: false, hosted_cloud_files: true }],
  ])("with %s, nothing is asked and it points to Agents", async (_label, value) => {
    flags.value = value;
    open();
    expect(await screen.findByText(/once you have an agent in your cloud/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("with no agent in the cloud, no file route is called", async () => {
    routes = [(url) => (url.pathname === "/gateway/hosted-machines" ? json({ available: true, machines: [] }) : undefined)];
    open();
    expect(await screen.findByText(/once you have an agent in your cloud/)).toBeTruthy();
    expect(listedPaths()).toEqual([]);
  });

  it("View files opens the agent's folder, matched on its name, not its label", async () => {
    routes = [boxWithAgent, listing({ "": TOP, "web-frontend": [file("README.md")] })];
    open("?agent=web-frontend");
    expect(await screen.findByText("README.md")).toBeTruthy();
    expect(listedPaths()).toContain("web-frontend");
  });

  it("Changed sorts the open folder newest first with no extra reads, and Name puts it back", async () => {
    const at = (name: string, mtime: number) => ({ name, kind: "file", size: 4, mtime });
    routes = [
      boxWithAgent,
      listing({ "": TOP, "web-frontend": [at("a-old.md", 1_000), at("b-new.md", 3_000), at("c-mid.md", 2_000)] }),
    ];
    open("?agent=web-frontend");
    await screen.findByText("a-old.md");
    const names = () => [...document.querySelectorAll("[data-cloud-file]")].map((node) => node.getAttribute("data-cloud-file"));
    expect(names()).toEqual(["a-old.md", "b-new.md", "c-mid.md"]);
    const reads = listedPaths().length;
    fireEvent.click(screen.getByRole("button", { name: "Changed, newest first" }));
    expect(names()).toEqual(["b-new.md", "c-mid.md", "a-old.md"]);
    expect(screen.getByRole("button", { name: "Changed, newest first" }).closest("th")?.getAttribute("aria-sort")).toBe(
      "descending",
    );
    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(names()).toEqual(["a-old.md", "b-new.md", "c-mid.md"]);
    expect(listedPaths().length).toBe(reads);
  });

  it("shows grey skeleton rows, not a spinner, while a folder loads", async () => {
    // Every read of the agent's folder waits until the test lets them through,
    // and any read after that answers straight away.
    const waiting: (() => void)[] = [];
    let released = false;
    const release = () => {
      released = true;
      waiting.splice(0).forEach((go) => go());
    };
    routes = [
      boxWithAgent,
      (url) =>
        url.pathname === "/gateway/cloud-files/list" && url.searchParams.get("path") === ""
          ? json({ entries: TOP })
          : undefined,
      (url) =>
        url.pathname !== "/gateway/cloud-files/list"
          ? undefined
          : released
            ? json({ entries: [file("README.md")] })
            : (new Promise<Response>((resolve) => waiting.push(() => resolve(json({ entries: [file("README.md")] })))) as never),
    ];
    open("?agent=web-frontend");
    // The top level is in (its side list shows), and the agent's folder is still loading.
    await screen.findByRole("navigation", { name: "Folders" });
    await waitFor(() => expect(waiting.length).toBeGreaterThan(0));
    const skeleton = screen.getByTestId("folder-skeleton");
    expect(skeleton.getAttribute("aria-busy")).toBe("true");
    expect(within(skeleton).getByText("Loading files…")).toBeTruthy();
    expect(document.querySelector(".MuiCircularProgress-root")).toBeNull();
    act(() => release());
    expect(await screen.findByText("README.md")).toBeTruthy();
    expect(screen.queryByTestId("folder-skeleton")).toBeNull();
  });

  it("an empty agent folder and an empty folder each say so in their own words", async () => {
    routes = [boxWithAgent, listing({ "": TOP, "web-frontend": [], shared: [] })];
    open("?agent=web-frontend");
    expect(await screen.findByText("Nothing here yet. Files your agent makes appear here.")).toBeTruthy();
    cleanup();
    open("?path=shared");
    expect(await screen.findByText("This folder is empty.")).toBeTruthy();
  });

  it("each row shows its kind's icon and says the kind after its name", async () => {
    routes = [
      boxWithAgent,
      listing({ "": TOP, "web-frontend": [folder("src"), file("README.md"), file("data.csv"), file("notes.txt")] }),
    ];
    open("?agent=web-frontend");
    await screen.findByText("README.md");
    const kinds = [...document.querySelectorAll("tbody [data-file-kind]")].map((icon) => icon.getAttribute("data-file-kind"));
    expect(kinds).toEqual(["folder", "data", "other", "markdown"]);
    expect(screen.getByRole("button", { name: "README.md, Markdown file" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "src, Folder" })).toBeTruthy();
    // Icons come from the name only: nothing was read to choose them.
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/cloud-files/content"))).toBe(false);
  });

  it("the preview has Copy path, which copies the in-cloud path", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    routes = [
      boxWithAgent,
      listing({ "": TOP, "web-frontend": [file("README.md")] }),
      (url) =>
        url.pathname === "/gateway/cloud-files/content"
          ? new Response(new TextEncoder().encode("# hi"), { status: 206, headers: { "content-range": "bytes 0-3/4" } })
          : undefined,
    ];
    open("?agent=web-frontend");
    fireEvent.click(await screen.findByRole("button", { name: /README\.md/ }));
    const dialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Copy path" }));
    });
    expect(writeText).toHaveBeenCalledWith("web-frontend/README.md");
    expect(within(dialog).getByRole("button", { name: "Path copied" })).toBeTruthy();
  });

  describe("filter, sort and keyboard (part 2)", () => {
    const FILES = [folder("src"), file("menu.md"), file("menu-old.md"), file("notes.txt")];
    const filterBox = () => screen.getByRole("textbox", { name: "Filter this folder" }) as HTMLInputElement;
    const names = () =>
      [...document.querySelectorAll("tbody [data-file-kind]")].map(
        (icon) => icon.closest("button")!.textContent!.replace(/,.*$/, ""),
      );

    it("narrows the open folder by name, says when nothing matches, and Clear filter brings it back", async () => {
      routes = [boxWithAgent, listing({ "": TOP, "web-frontend": FILES })];
      open("?agent=web-frontend");
      await screen.findByText("notes.txt");
      const reads = listedPaths().length;
      fireEvent.change(filterBox(), { target: { value: "MENU" } });
      expect(names().sort()).toEqual(["menu-old.md", "menu.md"]);
      fireEvent.change(filterBox(), { target: { value: "zzz" } });
      expect(screen.getByText("No files match ‘zzz’.")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
      expect(filterBox().value).toBe("");
      expect(names()).toHaveLength(4);
      expect(names()[0]).toBe("src");
      // Typing reads nothing: it only narrows what's loaded.
      expect(listedPaths().length).toBe(reads);
    });

    it("keeps the filter and sort while moving into a folder and back", async () => {
      routes = [boxWithAgent, listing({ "": TOP, "web-frontend": FILES, "web-frontend/src": [file("menu.ts"), file("app.ts")] })];
      open("?agent=web-frontend");
      await screen.findByText("notes.txt");
      fireEvent.click(screen.getByRole("button", { name: "Changed, newest first" }));
      fireEvent.change(filterBox(), { target: { value: "menu" } });
      fireEvent.change(filterBox(), { target: { value: "" } });
      fireEvent.click(screen.getByRole("button", { name: "src, Folder" }));
      await screen.findByText("app.ts");
      fireEvent.change(filterBox(), { target: { value: "menu" } });
      expect(names()).toEqual(["menu.ts"]);
      fireEvent.keyDown(screen.getByRole("button", { name: "menu.ts, Code file" }), { key: "Backspace" });
      await screen.findByText("menu.md");
      expect(filterBox().value).toBe("menu");
      expect(names().sort()).toEqual(["menu-old.md", "menu.md"]);
      expect(screen.getByRole("button", { name: "Changed, newest first" }).closest("th")?.getAttribute("aria-sort")).toBe(
        "descending",
      );
    });

    it("while filtering a folder with more pages, says it only looked at what's loaded", async () => {
      routes = [
        boxWithAgent,
        (url) =>
          url.pathname === "/gateway/cloud-files/list"
            ? url.searchParams.get("path") === ""
              ? json({ entries: TOP })
              : json({ entries: FILES, cursor: "next-page" })
            : undefined,
      ];
      open("?agent=web-frontend");
      expect(await screen.findByRole("button", { name: "Show more" })).toBeTruthy();
      expect(screen.queryByText(/Filtering the first/)).toBeNull();
      fireEvent.change(filterBox(), { target: { value: "menu" } });
      expect(screen.getByText("Filtering the first 4 loaded. Show more to include the rest.")).toBeTruthy();
    });

    it("is one grid with a single Tab stop: arrows move, Enter opens, Backspace goes up", async () => {
      routes = [boxWithAgent, listing({ "": TOP, "web-frontend": FILES, "web-frontend/src": [file("app.ts")] })];
      open("?agent=web-frontend");
      await screen.findByText("notes.txt");
      expect(screen.getByRole("grid", { name: "Files in web-frontend" })).toBeTruthy();
      const rowButtons = () => [...document.querySelectorAll<HTMLButtonElement>("tbody button[tabindex]")].filter((b) => b.querySelector("[data-file-kind]"));
      expect(rowButtons().map((b) => b.tabIndex)).toEqual([0, -1, -1, -1]);
      const order = names();
      rowButtons()[0]!.focus();
      fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
      expect(document.activeElement?.textContent?.startsWith(order[1]!)).toBe(true);
      fireEvent.keyDown(document.activeElement!, { key: "End" });
      expect(document.activeElement?.textContent?.startsWith(order[3]!)).toBe(true);
      expect(rowButtons().map((b) => b.tabIndex)).toEqual([-1, -1, -1, 0]);
      fireEvent.keyDown(document.activeElement!, { key: "Home" });
      // Enter on a folder is the button's own click, with no mouse clicks behind it.
      fireEvent.click(document.activeElement!, { detail: 0 });
      await screen.findByText("app.ts");
      // Opened from the keyboard: focus is on the new folder's first row.
      await waitFor(() => expect(document.activeElement?.textContent?.startsWith("app.ts")).toBe(true));
      fireEvent.keyDown(document.activeElement!, { key: "Backspace" });
      expect(await screen.findByText("notes.txt")).toBeTruthy();
      await waitFor(() => expect(document.activeElement?.textContent?.startsWith("src")).toBe(true));
    });

    it("/ jumps to the filter, but not while typing in it or with the preview open", async () => {
      routes = [boxWithAgent, listing({ "": TOP, "web-frontend": FILES })];
      open("?agent=web-frontend");
      await screen.findByText("notes.txt");
      fireEvent.keyDown(document.body, { key: "/" });
      expect(document.activeElement).toBe(filterBox());
      const typed = new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true });
      filterBox().dispatchEvent(typed);
      expect(typed.defaultPrevented).toBe(false);
      // Esc in the filter clears it first.
      fireEvent.change(filterBox(), { target: { value: "menu" } });
      fireEvent.keyDown(filterBox(), { key: "Escape" });
      expect(filterBox().value).toBe("");
    });

    it("each row has its quick actions, and Preview opens the file", async () => {
      routes = [boxWithAgent, listing({ "": TOP, "web-frontend": [file("README.md")] })];
      open("?agent=web-frontend");
      await screen.findByText("README.md");
      const row = screen.getByText("README.md").closest("tr")!;
      expect(within(row).getByRole("button", { name: "Copy path" })).toBeTruthy();
      expect(within(row).getByRole("button", { name: "Download" })).toBeTruthy();
      fireEvent.click(within(row).getByRole("button", { name: "Preview" }));
      expect(await screen.findByRole("dialog")).toBeTruthy();
    });
  });

  it("filterEntries matches name or label, ignoring case and spaces around", () => {
    const entries = [folder("web-frontend", { label: "Web Frontend" }), file("Menu.md"), file("notes.txt")] as CloudFileEntry[];
    expect(filterEntries(entries, "  web front ").map((e) => e.name)).toEqual(["web-frontend"]);
    expect(filterEntries(entries, "MENU").map((e) => e.name)).toEqual(["Menu.md"]);
    expect(filterEntries(entries, "")).toHaveLength(3);
  });

  it("an empty top level says files appear once agents make something", async () => {
    routes = [boxWithAgent, listing({ "": [] })];
    open();
    expect(await screen.findByText("Your agents' files appear here once they make something")).toBeTruthy();
  });

  it("an unknown agent from the address bar builds no request, and shows the top level with a note", async () => {
    routes = [boxWithAgent, listing({ "": TOP })];
    open("?agent=..%2Fsecrets");
    expect(await screen.findByText(/That agent’s folder isn’t there/)).toBeTruthy();
    expect(listedPaths()).toEqual([""]);
  });

  it("a large folder asks before it's listed", async () => {
    routes = [boxWithAgent, listing({ "": [folder("node_modules", { collapsed: true })], node_modules: [] })];
    open();
    fireEvent.click(await screen.findByRole("button", { name: /node_modules/ }));
    expect(screen.getByText("Large folder. Open anyway?")).toBeTruthy();
    expect(listedPaths()).not.toContain("node_modules");
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(listedPaths()).toContain("node_modules"));
  });

  it("the zip link says all at the top level and folder inside one", async () => {
    routes = [boxWithAgent, listing({ "": TOP, shared: [] })];
    open();
    expect(await screen.findByRole("link", { name: /Download all as zip/ })).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /^Shared$/ })[0]!);
    expect(await screen.findByRole("link", { name: /Download folder as zip/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Download all as zip/ })).toBeNull();
  });

  it("a preview keeps the path, ending in the file, and a folder in it goes back there", async () => {
    routes = [
      boxWithAgent,
      listing({ "": TOP, "shared/sample-bakery": [file("menu.csv")] }),
      (url) =>
        url.pathname === "/gateway/cloud-files/content"
          ? new Response(new TextEncoder().encode("item,price\n"), { status: 206, headers: { "content-range": "bytes 0-10/11" } })
          : undefined,
    ];
    open("?path=shared%2Fsample-bakery");
    fireEvent.click(await screen.findByRole("button", { name: /menu\.csv/ }));
    const dialog = await screen.findByRole("dialog");
    const crumbs = within(dialog).getByRole("navigation", { name: "Folder path" });
    await waitFor(() => expect(crumbs.textContent).toBe("All filesSharedsample-bakerymenu.csv"));
    expect(crumbs.querySelector('[aria-current="page"]')?.textContent).toBe("menu.csv");
    expect(within(dialog).getByText(/ago|Just now|\d{4}-\d{2}-\d{2}/, { selector: "span[title]" }).getAttribute("title")).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{1,2}:\d{2} [AP]M$/,
    );
    fireEvent.click(within(crumbs).getByRole("button", { name: "sample-bakery" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Close preview" })).toBeNull());
    expect(screen.getByRole("button", { name: /menu\.csv/ })).toBeTruthy();
  });

  it("a resting box offers Wake it and asks nothing more until clicked", async () => {
    routes = [boxWithAgent, (url) => (url.pathname === "/gateway/cloud-files/list" ? json({ detail: { code: "box_resting" } }, 409) : undefined)];
    open();
    expect(await screen.findByText("Your cloud is resting")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Wake it" })).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/ensure"))).toBe(false);
  });

  it("leaving the page while it wakes stops the retries, so no listing adds awake time", async () => {
    routes = [
      boxWithAgent,
      (url) => (url.pathname === "/gateway/hosted-machines/ensure" ? json({}) : undefined),
      (url) => (url.pathname === "/gateway/cloud-files/list" ? json({ detail: { code: "box_resting" } }, 409) : undefined),
    ];
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      open();
      fireEvent.click(await screen.findByRole("button", { name: "Wake it" }));
      await waitFor(() =>
        expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/ensure"))).toBe(true),
      );
      await vi.advanceTimersByTimeAsync(3_500);
      const before = listedPaths().length;
      cleanup();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(listedPaths().length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("after Wake it, a gently pulsing cloud says it's waking, in the spec's words", async () => {
    routes = [
      boxWithAgent,
      (url) => (url.pathname === "/gateway/hosted-machines/ensure" ? json({}) : undefined),
      (url) => (url.pathname === "/gateway/cloud-files/list" ? json({ detail: { code: "box_resting" } }, 409) : undefined),
    ];
    open();
    expect(screen.queryByTestId("waking-cloud")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Wake it" }));
    expect(await screen.findByText("Waking your cloud…")).toBeTruthy();
    expect(screen.getByText("This takes about a minute")).toBeTruthy();
    const cloud = screen.getByTestId("waking-cloud");
    expect(cloud.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelector(".MuiCircularProgress-root")).toBeNull();
  });

  it("an image preview is a Blob typed by the safe-image rule", async () => {
    routes = [
      boxWithAgent,
      listing({ "": [file("logo.png")] }),
      (url) =>
        url.pathname === "/gateway/cloud-files/content"
          ? new Response(new Uint8Array([1, 2, 3, 4]), { status: 206, headers: { "content-range": "bytes 0-3/4" } })
          : undefined,
    ];
    open();
    fireEvent.click(await screen.findByRole("button", { name: /logo\.png/ }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    expect(createObjectURL.mock.calls[0]![0].type).toBe("image/png");
    expect((await screen.findByRole("img", { name: "logo.png" })).getAttribute("src")).toBe("blob:preview");
  });

  it("SVG and HTML are download only: nothing is fetched for a preview", async () => {
    routes = [boxWithAgent, listing({ "": [file("art.svg"), file("page.html")] })];
    open();
    for (const name of ["art.svg", "page.html"]) {
      fireEvent.click(await screen.findByRole("button", { name: new RegExp(name.replace(".", "\\.")) }));
      expect(await screen.findByText(/can’t be previewed here/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/content"))).toBe(false);
    expect(document.querySelector("img, iframe, object, embed, video")).toBeNull();
  });

  const content =
    (byPath: Record<string, Uint8Array>): Route =>
    (url) => {
      if (url.pathname !== "/gateway/cloud-files/content") return undefined;
      const bytes = byPath[url.searchParams.get("path") ?? ""];
      if (!bytes) return json({ detail: { code: "not_found" } }, 404);
      return new Response(new Uint8Array(bytes), {
        status: 206,
        headers: { "content-range": `bytes 0-${bytes.length - 1}/${bytes.length}` },
      });
    };
  const text = (value: string) => new TextEncoder().encode(value);

  it("a file opens in a modal over the list; Esc closes it and the list is unchanged", async () => {
    routes = [boxWithAgent, listing({ "": [folder("src"), file("a.txt", 5)] }), content({ "a.txt": text("hello") })];
    open();
    fireEvent.click(await screen.findByRole("button", { name: /a\.txt/ }));
    const dialog = await screen.findByRole("dialog", { name: "a.txt" });
    expect(await within(dialog).findByText("hello")).toBeTruthy();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getAllByRole("button", { name: /^src$/ }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /a\.txt/ })).toBeTruthy();
  });

  it("previous and next step through files only, stop at the ends, and fetch only the file shown", async () => {
    routes = [
      boxWithAgent,
      listing({ "": [file("a.txt", 1), folder("src"), file("b.txt", 1), file("c.txt", 1)] }),
      content({ "a.txt": text("A"), "b.txt": text("B"), "c.txt": text("C") }),
    ];
    open();
    fireEvent.click(await screen.findByRole("button", { name: /a\.txt/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Previous file" })).toHaveProperty("disabled", true);
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    await within(dialog).findByText("B");
    fireEvent.click(within(dialog).getByRole("button", { name: "Next file" }));
    await within(dialog).findByText("C");
    expect(within(dialog).getByRole("button", { name: "Next file" })).toHaveProperty("disabled", true);
    fireEvent.keyDown(dialog, { key: "ArrowLeft" });
    await within(dialog).findByText("B");
    const read = fetchMock.mock.calls
      .map(([input]) => new URL(input, "https://switch.example"))
      .filter((url) => url.pathname === "/gateway/cloud-files/content")
      .map((url) => url.searchParams.get("path"));
    expect(read).toEqual(["a.txt", "b.txt", "c.txt", "b.txt"]);
  });

  it("closing gives focus back to the last file shown in the list", async () => {
    routes = [boxWithAgent, listing({ "": [file("a.txt", 1), file("b.txt", 1)] }), content({ "a.txt": text("A"), "b.txt": text("B") })];
    open();
    fireEvent.click(await screen.findByRole("button", { name: /a\.txt/ }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("A");
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    await within(dialog).findByText("B");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement?.getAttribute("data-cloud-file")).toBe("b.txt"));
  });

  it("an mp4 whose bytes are mp4 plays from a video/mp4 Blob, muted and not autoplaying", async () => {
    const mp4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    routes = [boxWithAgent, listing({ "": [file("clip.mp4", mp4.length)] }), content({ "clip.mp4": mp4 })];
    open();
    fireEvent.click(await screen.findByRole("button", { name: /clip\.mp4/ }));
    await waitFor(() => expect(document.querySelector("video")).not.toBeNull());
    expect(createObjectURL.mock.calls.at(-1)![0].type).toBe("video/mp4");
    const video = document.querySelector("video")!;
    expect(video.getAttribute("src")).toBe("blob:preview");
    expect(video.hasAttribute("controls")).toBe(true);
    expect(video.muted).toBe(true);
    expect(video.autoplay).toBe(false);
    expect(video.getAttribute("preload")).toBe("metadata");
    expect(video.querySelector("track")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview"));
  });

  it("arrow keys belong to a focused video, not to previous and next", async () => {
    const mp4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    routes = [
      boxWithAgent,
      listing({ "": [file("clip.mp4", mp4.length), file("notes.txt", 1)] }),
      content({ "clip.mp4": mp4, "notes.txt": text("N") }),
    ];
    open();
    fireEvent.click(await screen.findByRole("button", { name: /clip\.mp4/ }));
    await waitFor(() => expect(document.querySelector("video")).not.toBeNull());
    fireEvent.keyDown(document.querySelector("video")!, { key: "ArrowRight" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.querySelector("video")).not.toBeNull();
    const read = fetchMock.mock.calls.filter(([input]) => String(input).includes("/content"));
    expect(read).toHaveLength(1);
  });

  it("closing partway through a video load stops the reads and never makes a Blob", async () => {
    const half = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const reads: string[] = [];
    routes = [
      boxWithAgent,
      listing({ "": [file("clip.mp4", 24)] }),
      ((url: URL) => {
        if (url.pathname !== "/gateway/cloud-files/content") return undefined;
        reads.push(url.searchParams.get("offset") ?? "");
        return gate.then(() => new Response(new Uint8Array(half), { status: 206, headers: { "content-range": "bytes 0-11/24" } }));
      }) as unknown as Route,
    ];
    open();
    fireEvent.click(await screen.findByRole("button", { name: /clip\.mp4/ }));
    await waitFor(() => expect(reads).toEqual(["0"]));
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reads).toEqual(["0"]); // the second half is never asked for
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(document.querySelector("video")).toBeNull();
  });

  it("a file deleted while open, or a box gone to rest, gives fixed words, not a spinner", async () => {
    routes = [
      boxWithAgent,
      listing({ "": [file("gone.txt", 3), file("sleep.txt", 3)] }),
      (url) =>
        url.pathname === "/gateway/cloud-files/content"
          ? url.searchParams.get("path") === "gone.txt"
            ? json({ detail: { code: "not_found" } }, 404)
            : json({ detail: { code: "box_resting" } }, 409)
          : undefined,
    ];
    open();
    fireEvent.click(await screen.findByRole("button", { name: /gone\.txt/ }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("This file isn’t there any more.")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Download" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Next file" })).toHaveProperty("disabled", false);
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(await within(dialog).findByText("Your cloud is resting.")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Wake it" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Download" })).toBeTruthy();
    expect(dialog.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("Wake it wakes the box once and reads the same file again until it's up", async () => {
    let up = false;
    const reads: string[] = [];
    routes = [
      boxWithAgent,
      listing({ "": [file("menu.txt", 5)] }),
      (url) => (url.pathname === "/gateway/hosted-machines/ensure" ? json({}) : undefined),
      (url) => {
        if (url.pathname !== "/gateway/cloud-files/content") return undefined;
        reads.push(url.searchParams.get("path") ?? "");
        return up
          ? new Response(new TextEncoder().encode("rye 3"), { status: 206, headers: { "content-range": "bytes 0-4/5" } })
          : json({ detail: { code: "box_resting" } }, 409);
      },
    ];
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      open();
      fireEvent.click(await screen.findByRole("button", { name: /menu\.txt/ }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(await within(dialog).findByRole("button", { name: "Wake it" }));
      expect(await within(dialog).findByText(/Waking your cloud/)).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_500);
      });
      expect(within(dialog).getByText(/Waking your cloud/)).toBeTruthy();
      up = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_500);
      });
      expect(await within(dialog).findByText("rye 3")).toBeTruthy();
      const ensures = fetchMock.mock.calls.filter(([input]) => String(input).includes("/ensure"));
      expect(ensures).toHaveLength(1);
      expect(new Set(reads)).toEqual(new Set(["menu.txt"]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("a binary file named .txt can't be previewed", async () => {
    routes = [boxWithAgent, listing({ "": [file("data.txt", 4)] }), content({ "data.txt": new Uint8Array([1, 0, 2, 0]) })];
    open();
    fireEvent.click(await screen.findByRole("button", { name: /data\.txt/ }));
    expect(await screen.findByText(/can’t be previewed here/)).toBeTruthy();
  });

  it("a .webm that is really HTML is never played", async () => {
    const html = text("<html><script>alert(1)</script></html>");
    routes = [boxWithAgent, listing({ "": [file("clip.webm", html.length)] }), content({ "clip.webm": html })];
    open();
    fireEvent.click(await screen.findByRole("button", { name: /clip\.webm/ }));
    expect(await screen.findByText(/can’t be previewed here/)).toBeTruthy();
    expect(document.querySelector("video")).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("Markdown is rendered with no raw HTML and no remote image, and Show source shows the text", async () => {
    const md = "# Menu\n\n<script>window.ran = 1</script>\n\n![tracker](https://evil.example/p.png)\n\n[ok](https://example.com) [no](javascript:alert(1))";
    routes = [boxWithAgent, listing({ "": [file("README.md", md.length)] }), content({ "README.md": text(md) })];
    open();
    fireEvent.click(await screen.findByRole("button", { name: /README\.md/ }));
    const dialog = await screen.findByRole("dialog");
    expect((await within(dialog).findByRole("heading", { name: "Menu" })).tagName).toBe("H1");
    expect(dialog.querySelectorAll("script, img, iframe").length).toBe(0);
    expect(dialog.innerHTML).not.toContain("evil.example");
    const links = within(dialog).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://example.com"]);
    expect(links[0]!.getAttribute("rel")).toContain("noopener");
    fireEvent.click(within(dialog).getByRole("button", { name: "Show source" }));
    expect(within(dialog).getByText(/<script>window.ran = 1<\/script>/)).toBeTruthy();
    // The toggle says what it will do next.
    fireEvent.click(within(dialog).getByRole("button", { name: "Show formatted" }));
    expect(within(dialog).getByRole("heading", { name: "Menu" })).toBeTruthy();
    expect((window as { ran?: number }).ran).toBeUndefined();
  });

  it("Wrap lines shows its state, and is on by default at phone width", async () => {
    const py = "x = 1";
    routes = [boxWithAgent, listing({ "": [file("a.py", py.length)] }), content({ "a.py": text(py) })];
    const phone = (query: string) => ({
      matches: query.includes("max-width"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
    vi.stubGlobal("matchMedia", phone);
    open();
    fireEvent.click(await screen.findByRole("button", { name: /a\.py/ }));
    const dialog = await screen.findByRole("dialog");
    const wrap = await within(dialog).findByRole("button", { name: "Wrap lines" });
    expect(wrap.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(wrap);
    expect(within(dialog).getByRole("button", { name: "Wrap lines" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("code is highlighted as text only, bad JSON says so, and CSV is a table", async () => {
    const py = 'x = "<img src=x onerror=alert(1)>"';
    routes = [
      boxWithAgent,
      listing({ "": [file("a.py", py.length), file("bad.json", 5), file("menu.csv", 20)] }),
      content({ "a.py": text(py), "bad.json": text("{nope"), "menu.csv": text("item,price\nrye,3.20") }),
    ];
    open();
    fireEvent.click(await screen.findByRole("button", { name: /a\.py/ }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.querySelector('[data-code-view][data-language="python"]')).not.toBeNull());
    expect(dialog.querySelector("img")).toBeNull();
    expect(dialog.textContent).toContain("<img src=x onerror=alert(1)>");
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(await within(dialog).findByText("This isn’t valid JSON.")).toBeTruthy();
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    await waitFor(() => expect([...dialog.querySelectorAll("th")].map((th) => th.textContent)).toEqual(["item", "price"]));
  });

  it("a download goes through <a download> as bytes only, never window.open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const opened = vi.spyOn(window, "open").mockImplementation(() => null);
    const clicked: HTMLAnchorElement[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this);
    });
    routes = [
      boxWithAgent,
      listing({ "": [file("page.html")] }),
      (url) =>
        url.pathname === "/gateway/cloud-files/content"
          ? new Response(new Uint8Array([60, 104, 62, 0]), { status: 206, headers: { "content-range": "bytes 0-3/4" } })
          : undefined,
    ];
    open();
    fireEvent.click(await screen.findByRole("button", { name: /page\.html/ }));
    await act(async () => {
      fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Download" }));
    });
    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(clicked[0]!.download).toBe("page.html");
    expect(createObjectURL.mock.calls.at(-1)![0].type).toBe("application/octet-stream");
    // Kept a moment after the click (Safari), then released.
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOWNLOAD_REVOKE_MS);
    });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
    expect(opened).not.toHaveBeenCalled();
    click.mockRestore();
    opened.mockRestore();
    vi.useRealTimers();
  });
});
