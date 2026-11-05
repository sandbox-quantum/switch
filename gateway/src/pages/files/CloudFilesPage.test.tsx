import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CloudFilesPage, { DOWNLOAD_REVOKE_MS } from "./CloudFilesPage";

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
    const crumbs = await screen.findByRole("navigation", { name: "Folder path" });
    await waitFor(() => expect(crumbs.textContent).toBe("All filesSharedsample-bakerymenu.csv"));
    expect(crumbs.querySelector('[aria-current="page"]')?.textContent).toBe("menu.csv");
    expect(screen.getByText(/ago|Just now|\d{4}-\d{2}-\d{2}/, { selector: "span[title]" }).getAttribute("title")).toMatch(
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
      expect(await screen.findByText(/no preview for this kind of file/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    }
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/content"))).toBe(false);
    expect(document.querySelector("img, iframe, object, embed")).toBeNull();
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
      fireEvent.click(await screen.findByRole("button", { name: "Download" }));
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
