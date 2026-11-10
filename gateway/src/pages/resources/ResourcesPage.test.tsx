import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ResourcesPage from "./ResourcesPage";

vi.mock("../../components/DataTable", () => ({
  default: () => <div data-testid="resource-table" />,
}));

type FetchMock = ReturnType<
  typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>
>;

function requestPath(input: RequestInfo | URL) {
  return String(input).replace(/^\/gateway/, "").split("?")[0];
}

function gets(fetchMock: FetchMock, path: string) {
  return fetchMock.mock.calls.filter(
    ([input, init]) => requestPath(input) === path && (init?.method ?? "GET") === "GET",
  ).length;
}

function renderTab(tab: string) {
  render(
    <MemoryRouter initialEntries={[`/resources?tab=${tab}`]}>
      <ResourcesPage withTemplates />
    </MemoryRouter>,
  );
}

describe("ResourcesPage", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ type: "runbook" }), { status: 201 });
      }
      return new Response("[]", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  // Each tab asks for each list once when it opens. Neither the tab's refresh
  // nor the closed create dialog adds a second request.
  it.each([
    ["references", { "/references": 1, "/references/reference-types": 1 }],
    [
      "types",
      { "/references/reference-types": 1, "/references/reference-types/owned": 1 },
    ],
    ["documents", { "/documents": 1 }],
    ["packages", { "/packages": 1 }],
    // The whole catalogue for the filter options, and the filtered list.
    ["templates", { "/templates": 2 }],
  ])("opens the %s tab with one GET per list", async (tab, expected) => {
    renderTab(tab);

    expect(await screen.findByTestId("resource-table")).toBeTruthy();
    await waitFor(() => {
      for (const [path, count] of Object.entries(expected)) {
        expect(gets(fetchMock, path), path).toBe(count);
      }
    });
    // Nothing else arrives once the tab has settled.
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const [path, count] of Object.entries(expected)) {
      expect(gets(fetchMock, path), path).toBe(count);
    }
  });

  it("fetches the reference types for the create dialog only once it opens", async () => {
    renderTab("references");
    await waitFor(() => expect(gets(fetchMock, "/references/reference-types")).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: /new reference/i }));

    await waitFor(() => expect(gets(fetchMock, "/references/reference-types")).toBe(2));
  });

  it("refetches the type lists after a reference type is created", async () => {
    renderTab("types");
    await waitFor(() => {
      expect(gets(fetchMock, "/references/reference-types")).toBe(1);
      expect(gets(fetchMock, "/references/reference-types/owned")).toBe(1);
    });

    fireEvent.click(screen.getByRole("button", { name: /new reference type/i }));
    // The open dialog lists the types to warn about a slug that is taken.
    await waitFor(() => expect(gets(fetchMock, "/references/reference-types")).toBe(2));

    fireEvent.change(screen.getByLabelText(/slug/i), { target: { value: "runbook" } });
    fireEvent.change(screen.getByLabelText(/display name/i), {
      target: { value: "Runbook" },
    });
    fireEvent.change(screen.getByLabelText(/instructions/i), {
      target: { value: "Follow the runbook." },
    });
    fireEvent.change(screen.getByLabelText(/value hint/i), {
      target: { value: "A link to the runbook." },
    });
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(
          ([input, init]) =>
            requestPath(input) === "/references/reference-types" && init?.method === "POST",
        ),
      ).toHaveLength(1);
      expect(gets(fetchMock, "/references/reference-types")).toBe(3);
      expect(gets(fetchMock, "/references/reference-types/owned")).toBe(2);
    });
  });
});
