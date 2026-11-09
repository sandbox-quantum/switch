import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudFileEntry } from "./cloudFiles";
import { COPIED_MS } from "./CopyPathButton";
import FileRowActions, { ROW_ACTION_WORDS } from "./FileRowActions";
import * as save from "./saveCloudFile";

vi.mock("./saveCloudFile", () => ({ saveCloudFile: vi.fn(async () => {}) }));

const file: CloudFileEntry = { name: "app.ts", kind: "file", size: 12, mtime: 0 };
const folder: CloudFileEntry = { name: "src", kind: "folder", size: 0, mtime: 0 };
const writeText = vi.fn(async (_text: string) => {});

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function actions(entry = file, compact = false, onPreview = vi.fn()) {
  render(<FileRowActions entry={entry} path={`web-frontend/${entry.name}`} compact={compact} onPreview={onPreview} />);
  return onPreview;
}

describe("a row's quick actions", () => {
  it("copies only the path within Your cloud files, says so, then the note goes", async () => {
    vi.useFakeTimers();
    actions();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy path" }));
    });
    expect(writeText).toHaveBeenCalledWith("web-frontend/app.ts");
    expect(screen.getByRole("status").textContent).toBe(ROW_ACTION_WORDS.copied);
    act(() => vi.advanceTimersByTime(COPIED_MS));
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("says plainly when the browser refuses the copy", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    actions();
    fireEvent.click(screen.getByRole("button", { name: "Copy path" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(ROW_ACTION_WORDS.copyFailed));
  });

  it("downloads through the preview's safe download, and previews", async () => {
    const onPreview = actions();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(save.saveCloudFile).toHaveBeenCalledWith("web-frontend/app.ts", "app.ts"));
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(onPreview).toHaveBeenCalledOnce();
  });

  it("gives a folder Copy path alone", () => {
    actions(folder);
    expect(screen.getByRole("button", { name: "Copy path" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Download|Preview/ })).toBeNull();
  });

  it("puts the same actions behind a ⋯ menu on touch and narrow screens", async () => {
    const onPreview = actions(file, true);
    expect(screen.queryByRole("button", { name: "Copy path" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Preview",
      "Download",
      "Copy path",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy path" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(ROW_ACTION_WORDS.copied));
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Preview" }));
    expect(onPreview).toHaveBeenCalledOnce();
  });
});
