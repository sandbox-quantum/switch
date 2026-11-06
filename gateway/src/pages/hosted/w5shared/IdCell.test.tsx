import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import IdCell, { COPIED_MS, shortId } from "./IdCell";

const ID = "k1-6d2c91f03ab29999";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("IdCell", () => {
  it("shows a short id, with the full one for hover and screen readers", () => {
    expect(shortId(ID)).toBe("k1-6d2c…9999");
    expect(shortId("not an id")).toBe("not an id");
    render(<IdCell id={ID} label="box" />);
    expect(screen.getByText("k1-6d2c…9999")).toBeTruthy();
    expect(screen.getByLabelText("box k1-6d2c 91f0 3ab2")).toBeTruthy();
  });

  it("copies the exact id, without opening the row it sits in", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const onRow = vi.fn();
    render(
      <div onClick={onRow}>
        <IdCell id={ID} label="box" />
      </div>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy box" }));
    });
    expect(writeText).toHaveBeenCalledWith(ID);
    expect(onRow).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("says so when the browser refuses the clipboard, then resets", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("no")) } });
    render(<IdCell id={ID} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy id" }));
    });
    expect(screen.getByRole("button", { name: "Couldn't copy. Select the id instead." })).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(COPIED_MS + 10);
    });
    expect(screen.getByRole("button", { name: "Copy id" })).toBeTruthy();
  });

  it("renders an id as text, never markup", () => {
    const { container } = render(<IdCell id={"<img src=x onerror=alert(1)>"} />);
    expect(container.querySelector("img")).toBeNull();
  });
});
