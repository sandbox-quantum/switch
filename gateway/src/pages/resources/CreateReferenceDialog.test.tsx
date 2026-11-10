import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { answerFetch } from "../../test/answerFetch";
import CreateReferenceDialog from "./CreateReferenceDialog";

const GITHUB = {
  type: "github",
  display_name: "GitHub",
  instructions: "",
  value_schema: {},
  value_hint: "Links to repositories",
  is_builtin: true,
  owner_id: null,
  owner_name: null,
};

describe("CreateReferenceDialog", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("creates nothing until there is a URL to point at", async () => {
    answerFetch({ "GET /references/reference-types": [200, [GITHUB]] });
    render(<CreateReferenceDialog open onClose={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.mouseDown(await screen.findByRole("combobox", { name: "Type" }));
    fireEvent.click(await screen.findByRole("option", { name: "GitHub" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Monorepo" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "All of it" } });
    const create = screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("URLs (one per line)"), {
      target: { value: "https://github.com/example/repo" },
    });
    expect(create.disabled).toBe(false);
  });

  it("says why the types could not be loaded", async () => {
    answerFetch({ "GET /references/reference-types": [503, { detail: "The database is unavailable." }] });
    render(<CreateReferenceDialog open onClose={vi.fn()} onCreated={vi.fn()} />);

    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Couldn't load the reference types: The database is unavailable.")).toBeTruthy();
  });
});
