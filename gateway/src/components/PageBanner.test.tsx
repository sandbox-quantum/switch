import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import PageBanner from "./PageBanner";

describe("PageBanner", () => {
  afterEach(() => cleanup());

  it("is a status rather than an alert, so it does not interrupt", () => {
    render(<PageBanner tone="warning">This workspace has 2 issues to fix.</PageBanner>);
    expect(screen.getByRole("status").textContent).toContain("This workspace has 2 issues to fix.");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
