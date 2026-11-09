import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CopyPathButton, { COPIED_MS, COPY_WORDS } from "./CopyPathButton";

const writeText = vi.fn(async (_text: string) => {});
beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("Copy path", () => {
  it("copies only the path within Your cloud files, says Path copied for two seconds, then comes back", async () => {
    vi.useFakeTimers();
    render(<CopyPathButton path="web-frontend/src/app.ts" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: COPY_WORDS.copy }));
    });
    expect(writeText).toHaveBeenCalledWith("web-frontend/src/app.ts");
    expect(screen.getByRole("button", { name: COPY_WORDS.copied })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(COPY_WORDS.copied);
    act(() => vi.advanceTimersByTime(COPIED_MS - 1));
    expect(screen.getByRole("button", { name: COPY_WORDS.copied })).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("button", { name: COPY_WORDS.copy })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("never claims success when the browser refuses", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    render(<CopyPathButton path="web-frontend/a.md" />);
    fireEvent.click(screen.getByRole("button", { name: COPY_WORDS.copy }));
    await waitFor(() => expect(screen.getByRole("button", { name: COPY_WORDS.failed })).toBeTruthy());
    expect(screen.queryByText(COPY_WORDS.copied)).toBeNull();
  });
});
