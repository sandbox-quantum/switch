import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FILES_ELSEWHERE_BACKOFF_MS,
  fetchBoxAgentIds,
  listCloudFiles,
  readCloudFile,
  readCloudFileRange,
  withFilesElsewhereRetry,
  zipUrl,
} from "./cloudFiles";
import { CloudFilesError } from "../pages/files/cloudFiles";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refused = (status: number, code: string) => json({ detail: { code } }, status);
const chunk = (bytes: Uint8Array, start: number, total: number) =>
  new Response(new Uint8Array(bytes), {
    status: 206,
    headers: { "content-range": `bytes ${start}-${start + bytes.byteLength - 1}/${total}` },
  });
const pastEnd = (total: number) => new Response(null, { status: 416, headers: { "content-range": `bytes */${total}` } });
const noSleep = async () => {};

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const urlOf = (call: number) => new URL(fetchMock.mock.calls[call]![0], "https://switch.example");

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("listCloudFiles", () => {
  it("builds the query with URLSearchParams and sends the session cookie", async () => {
    fetchMock.mockResolvedValueOnce(json({ entries: [], cursor: null }));
    await listCloudFiles("shared/a b&c=d", "c2");
    const url = urlOf(0);
    expect(url.pathname).toBe("/gateway/cloud-files/list");
    expect(url.searchParams.get("path")).toBe("shared/a b&c=d");
    expect(url.searchParams.get("cursor")).toBe("c2");
    expect(fetchMock.mock.calls[0]![1]?.credentials).toBe("include");
  });

  it("drops entries that break the shape, and reads a null cursor as the last page", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ entries: [{ name: "ok", kind: "file", size: 1, mtime: 1 }, { name: "bad", kind: "link" }], cursor: null }),
    );
    expect(await listCloudFiles("")).toEqual({ entries: [{ name: "ok", kind: "file", size: 1, mtime: 1 }] });
  });

  it.each([
    [409, "box_resting"],
    [403, "denied"],
    [404, "not_found"],
    [400, "bad_request"],
    [500, "failed"],
  ])("maps %i %s to its code, with no path in the message", async (status, code) => {
    fetchMock.mockResolvedValueOnce(refused(status, code));
    const error = await listCloudFiles("secret/place").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudFilesError);
    expect((error as CloudFilesError).code).toBe(code);
    expect((error as Error).message).not.toContain("secret");
  });
});

describe("withFilesElsewhereRetry", () => {
  it("retries 503 files_elsewhere three times, then says it couldn't reach the cloud", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const call = vi.fn(async () => {
      throw new CloudFilesError("files_elsewhere", 503);
    });
    await expect(withFilesElsewhereRetry(call, sleep)).rejects.toMatchObject({ code: "unreachable" });
    expect(call).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([...FILES_ELSEWHERE_BACKOFF_MS]);
  });
});

describe("reading a file", () => {
  it("joins 128 KiB ranges by Content-Range, and an HTML file comes back as bytes", async () => {
    const page = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");
    fetchMock.mockResolvedValueOnce(chunk(page.slice(0, 10), 0, page.byteLength));
    fetchMock.mockResolvedValueOnce(chunk(page.slice(10), 10, page.byteLength));
    expect(new TextDecoder().decode(await readCloudFile("a/page.html", 1024, noSleep))).toBe(new TextDecoder().decode(page));
    expect(urlOf(1).searchParams.get("offset")).toBe("10");
  });

  it("ends on 416, and reads an empty 200 as an empty file", async () => {
    fetchMock.mockResolvedValueOnce(pastEnd(5));
    expect(await readCloudFileRange("a.txt", 5, noSleep)).toEqual({ done: true, total: 5 });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    expect((await readCloudFile("empty.txt", 1024, noSleep)).byteLength).toBe(0);
  });

  it("refuses a 26 MB file on the first range", async () => {
    fetchMock.mockResolvedValueOnce(chunk(new Uint8Array(16), 0, 26 * 1024 * 1024));
    await expect(readCloudFile("big.bin", undefined, noSleep)).rejects.toMatchObject({ code: "too_large" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("zipUrl", () => {
  it("builds the zip address with URLSearchParams", () => {
    const url = new URL(zipUrl("shared/a&b", true), "https://switch.example");
    expect(url.pathname).toBe("/gateway/cloud-files/zip");
    expect(url.searchParams.get("path")).toBe("shared/a&b");
    expect(url.searchParams.get("caches")).toBe("1");
  });
});

describe("fetchBoxAgentIds", () => {
  it("lists agent ids on a v2 box only", async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        available: true,
        machines: [
          { backend: "box", state: "ready", agents: ["a1", "a2"] },
          { backend: "vm", state: "ready", agents: ["v1"] },
        ],
      }),
    );
    expect(await fetchBoxAgentIds()).toEqual(["a1", "a2"]);
  });

  it("is empty with no box, a box with no agents, or a failed read", async () => {
    fetchMock.mockResolvedValueOnce(json({ available: true, machines: [{ backend: "box", state: "ready", agents: [] }] }));
    expect(await fetchBoxAgentIds()).toEqual([]);
    fetchMock.mockResolvedValueOnce(json({}, 500));
    expect(await fetchBoxAgentIds()).toEqual([]);
  });
});
