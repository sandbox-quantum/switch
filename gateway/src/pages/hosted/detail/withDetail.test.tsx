import { cleanup, render, screen } from "@testing-library/react";
import { lazy } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { withDetail } from "./withDetail";

function List() {
  return <p>the list</p>;
}

afterEach(cleanup);

function at(path: string, Tab: ReturnType<typeof withDetail>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/hosted/machines/*" element={<Tab />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("a tab with a detail page", () => {
  it("shows the tab's own page at its address", () => {
    at("/hosted/machines", withDetail(List, () => <p>detail</p>, "machineId"));
    expect(screen.getByText("the list")).toBeTruthy();
  });

  it("loads a lazy detail page only when one is opened, showing Loading meanwhile", async () => {
    let loaded = 0;
    const Detail = lazy(async () => {
      loaded += 1;
      return { default: () => <p>the detail</p> };
    });
    at("/hosted/machines", withDetail(List, Detail, "machineId"));
    expect(loaded).toBe(0);
    cleanup();
    at("/hosted/machines/k1-abc", withDetail(List, Detail, "machineId"));
    expect(screen.getByRole("progressbar", { name: "Loading" })).toBeTruthy();
    expect(await screen.findByText("the detail")).toBeTruthy();
    expect(loaded).toBe(1);
  });
});
