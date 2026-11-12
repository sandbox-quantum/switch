import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import InfoTip from "./InfoTip";

describe("InfoTip", () => {
  afterEach(() => cleanup());

  it("opens on hover and describes its button with the text", async () => {
    render(<InfoTip>Connectors are off by default for new workspaces.</InfoTip>);
    const button = screen.getByRole("button", { name: "More information" });
    await act(async () => {
      fireEvent.mouseOver(button);
    });

    const tip = await screen.findByRole("tooltip");
    expect(tip.textContent).toContain("Connectors are off by default for new workspaces.");
    expect(button.getAttribute("aria-describedby")).toBeTruthy();
  });
});
