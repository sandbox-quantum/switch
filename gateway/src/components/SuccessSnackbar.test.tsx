import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SuccessSnackbar from "./SuccessSnackbar";

afterEach(cleanup);

describe("SuccessSnackbar", () => {
  it("says what worked, and can be put away", () => {
    const onClose = vi.fn();
    render(<SuccessSnackbar message="Saved laptop." onClose={onClose} />);
    expect(screen.getByText("Saved laptop.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("goes away on its own", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<SuccessSnackbar message="Saved laptop." onClose={onClose} />);
    act(() => vi.advanceTimersByTime(5000));
    expect(onClose).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
