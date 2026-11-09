import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APPEAR_SX,
  ARRIVALS,
  MOTION,
  PULSE_SX,
  REDUCED_MOTION,
  animatePaper,
  arriveSx,
  centreOf,
  travelBetween,
} from "./motion";

// Pinned to the shared explorer spec (motion, 7 Nov), as Console's motion is.

afterEach(() => vi.restoreAllMocks());

describe("the explorer's motion, as in the shared spec", () => {
  it("keeps the spec's numbers", () => {
    expect(MOTION).toEqual({
      inMs: 200,
      outMs: 150,
      easeOut: "cubic-bezier(0.2, 0, 0, 1)",
      easeIn: "cubic-bezier(0.4, 0, 1, 1)",
      slidePx: 12,
      previewScale: 0.96,
      pulseMs: 2000,
    });
  });

  it("turns every animation off under reduced motion", () => {
    const still = { [`@media ${REDUCED_MOTION}`]: { animation: "none" } };
    for (const sx of [APPEAR_SX, PULSE_SX, arriveSx("in"), arriveSx("up"), arriveSx("none")])
      expect(sx).toMatchObject(still);
    expect(APPEAR_SX.animation).toMatch(/ 200ms cubic-bezier\(0\.2, 0, 0, 1\) both$/);
    expect(PULSE_SX.animation).toMatch(/ 2000ms ease-in-out infinite$/);
  });

  it("slides from the right going into a folder and from the left going up, otherwise fades", () => {
    expect(travelBetween(null, "web-frontend")).toBe("none");
    expect(travelBetween("", "web-frontend")).toBe("in");
    expect(travelBetween("web-frontend", "web-frontend/src")).toBe("in");
    expect(travelBetween("web-frontend/src", "web-frontend")).toBe("up");
    expect(travelBetween("web-frontend", "")).toBe("up");
    expect(travelBetween("web-frontend", "shared")).toBe("none");
    expect(travelBetween("web", "web-frontend")).toBe("none");
    expect(travelBetween("shared", "shared")).toBe("none");
    // Going in starts 12 px to the right; going up, 12 px to the left.
    expect(ARRIVALS.in.styles).toContain("translateX(12px)");
    expect(ARRIVALS.up.styles).toContain("translateX(-12px)");
    expect(ARRIVALS.none.styles).not.toContain("translateX");
    expect(arriveSx("in").animation).toContain(ARRIVALS.in.name);
    expect(arriveSx("up").animation).toContain(ARRIVALS.up.name);
    expect(arriveSx("none").animation).toContain(ARRIVALS.none.name);
  });
});

describe("animatePaper", () => {
  function paper() {
    const element = document.createElement("div");
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({ left: 100, top: 50, width: 400, height: 300 } as DOMRect);
    const animate = vi.fn();
    Object.defineProperty(element, "animate", { value: animate });
    return { element, animate };
  }

  it("grows from the clicked row: 0.96 to 1 with a fade over 200 ms, and back over 150 ms", () => {
    const { element, animate } = paper();
    animatePaper(element, { x: 140, y: 80 }, true, false);
    expect(element.style.transformOrigin).toBe("40px 30px");
    expect(animate).toHaveBeenLastCalledWith(
      [
        { transform: "scale(0.96)", opacity: 0 },
        { transform: "scale(1)", opacity: 1 },
      ],
      { duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "both" },
    );
    animatePaper(element, { x: 140, y: 80 }, false, false);
    expect(animate).toHaveBeenLastCalledWith(
      [
        { transform: "scale(1)", opacity: 1 },
        { transform: "scale(0.96)", opacity: 0 },
      ],
      { duration: 150, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "both" },
    );
  });

  it("does nothing under reduced motion, or where the browser can't animate", () => {
    const { element, animate } = paper();
    animatePaper(element, { x: 1, y: 1 }, true, true);
    expect(animate).not.toHaveBeenCalled();
    expect(element.style.transformOrigin).toBe("");
    expect(() => animatePaper(document.createElement("div"), null, true, false)).not.toThrow();
    expect(() => animatePaper(null, null, true, false)).not.toThrow();
  });

  it("finds a row's centre on screen", () => {
    const { element } = paper();
    expect(centreOf(element)).toEqual({ x: 300, y: 200 });
    expect(centreOf(null)).toBeNull();
  });
});
