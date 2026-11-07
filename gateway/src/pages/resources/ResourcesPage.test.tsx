import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import ResourcesPage from "./ResourcesPage";

vi.mock("../../components/DataTable", () => ({
  default: () => <div data-testid="resource-table" />,
}));

function requestPath(input: RequestInfo | URL) {
  return String(input).replace(/^\/gateway/, "").split("?")[0];
}

describe("ResourcesPage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("loads references and reference types with one GET each", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response("[]", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <StrictMode>
        <MemoryRouter initialEntries={["/resources"]}>
          <ResourcesPage />
        </MemoryRouter>
      </StrictMode>,
    );

    expect(await screen.findByTestId("resource-table")).toBeTruthy();
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([input]) => requestPath(input) === "/references"),
      ).toHaveLength(1);
      expect(
        fetchMock.mock.calls.filter(
          ([input]) => requestPath(input) === "/references/reference-types",
        ),
      ).toHaveLength(1);
    });

    fireEvent.click(screen.getByRole("button", { name: /new reference/i }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(
          ([input]) => requestPath(input) === "/references/reference-types",
        ),
      ).toHaveLength(2);
    });
  });
});
