import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PageErrorBoundary from "./PageErrorBoundary";

function Broken(): never {
  throw new Error("Cannot read properties of undefined (reading 'id')");
}

afterEach(cleanup);

describe("PageErrorBoundary", () => {
  it("says what broke instead of blanking the dashboard, and tries again on another page", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(
      <PageErrorBoundary resetKey="/a">
        <Broken />
      </PageErrorBoundary>,
    );
    expect(screen.getByText("This page could not be shown")).toBeTruthy();
    expect(screen.getByText(/reading 'id'/)).toBeTruthy();
    rerender(
      <PageErrorBoundary resetKey="/b">
        <span>fine</span>
      </PageErrorBoundary>,
    );
    expect(screen.getByText("fine")).toBeTruthy();
  });
});
