import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CreateTemplateDialog, { type TemplateDraft } from "./CreateTemplateDialog";

const COPY: TemplateDraft = {
  name: "Standup (copy)",
  description: "A daily standup room",
  kind: "room",
  access: "private",
  content: "room:\n  name: standup\n",
};

/** The dialog, with every create recorded and the document check passing. */
function showWith(initial: TemplateDraft | null, onClose = vi.fn()) {
  const created: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/gateway/templates/validate") {
        return new Response(JSON.stringify({ ok: true, blocked: false, errors: [], warnings: [] }), {
          status: 200,
        });
      }
      if (path === "/gateway/templates" && init?.method === "POST") {
        created.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ id: "new-1" }), { status: 201 });
      }
      throw new Error(`unexpected ${path}`);
    }),
  );
  const onCreated = vi.fn();
  render(
    <CreateTemplateDialog
      open
      title={initial ? "Duplicate template" : "New template"}
      submitLabel={initial ? "Save copy" : "Create"}
      initial={initial}
      onClose={onClose}
      onCreated={onCreated}
    />,
  );
  return { created, onCreated };
}

const value = (label: string) => (screen.getByLabelText(label) as HTMLInputElement).value;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CreateTemplateDialog", () => {
  it("starts a duplicate from the copy it is given, and saves it as it stands", async () => {
    const { created, onCreated } = showWith(COPY);
    expect(screen.getByRole("heading", { name: "Duplicate template" })).toBeTruthy();
    expect(value("Name")).toBe("Standup (copy)");
    expect(value("Document")).toBe(COPY.content);

    const save = screen.getByRole("button", { name: "Save copy" });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 });
    fireEvent.click(save);

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("new-1"));
    expect(created).toEqual([
      {
        name: "Standup (copy)",
        description: "A daily standup room",
        kind: "room",
        content: COPY.content,
        read_visibility: "private",
        write_visibility: "private",
      },
    ]);
  });

  it("goes back to the copy, not to an empty form, when it is cancelled", () => {
    const onClose = vi.fn();
    showWith(COPY, onClose);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Changed" } });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalled();
    expect(value("Name")).toBe("Standup (copy)");
  });

  it("starts a new template empty, shared with the workspace", () => {
    showWith(null);
    expect(value("Name")).toBe("");
    expect(value("Kind")).toBe("room");
    expect(screen.getByLabelText("Access").textContent).toMatch(/read only/i);
  });
});
