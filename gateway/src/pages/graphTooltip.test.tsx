import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { graphTooltip } from "./graphTooltip";

describe("graphTooltip", () => {
  it("renders each line as text, so markup in a name is shown, not run", () => {
    const { container } = render(graphTooltip('<img src=x onerror="alert(1)">', "a <b>room</b>"));
    expect(container.querySelector("img, b")).toBeNull();
    expect(container.textContent).toBe('<img src=x onerror="alert(1)">\na <b>room</b>');
  });

  it("leaves out empty lines", () => {
    const { container } = render(graphTooltip("Ops", "", null, undefined));
    expect(container.textContent).toBe("Ops");
  });
});
