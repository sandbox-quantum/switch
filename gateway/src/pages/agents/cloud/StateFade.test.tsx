import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import StateFade, { FADE_SX } from "./StateFade";

afterEach(cleanup);

describe("StateFade", () => {
  it("is a short opacity fade that reduce motion switches off", () => {
    expect(FADE_SX.animation).toMatch(/ 0\.4s ease-out both$/);
    expect(FADE_SX["@media (prefers-reduced-motion: reduce)"]).toEqual({ animation: "none" });
  });

  it("fades after a change, even back to the first state, but not on first show", () => {
    const { rerender, container } = render(<StateFade state="Idle">Idle</StateFade>);
    expect(container.querySelector("[data-state-fade]")).toBeNull();
    rerender(<StateFade state="Working">Working</StateFade>);
    expect(container.querySelector("[data-state-fade='on']")?.textContent).toBe("Working");
    rerender(<StateFade state="Idle">Idle</StateFade>);
    expect(container.querySelector("[data-state-fade='on']")?.textContent).toBe("Idle");
  });
});
