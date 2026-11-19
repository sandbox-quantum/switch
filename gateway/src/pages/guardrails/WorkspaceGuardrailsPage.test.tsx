import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "../../data/AuthContext";
import { answer, signedInAs } from "../../test/signedIn";
import { TRUST_COVERAGE } from "./GuardrailPolicyCard";
import WorkspaceGuardrailsPage from "./WorkspaceGuardrailsPage";

vi.mock("../../data/AuthContext", () => ({ useAuth: vi.fn() }));

const POLICY = {
  checking: true,
  policy_id: "c117f173-policy",
  policy_name: "Baseline Monitoring (Alert)",
  policy_url: "https://app.switchagents.ai/settings/guardrail-policies/c117f173-policy",
};

/** Signed in as `role`, and, for `orgAdmin`, admin of the organization too. */
function as(role: "member" | "orgAdmin") {
  signedInAs(role === "member" ? "member" : "admin");
  if (role === "orgAdmin") {
    const auth = vi.mocked(useAuth)();
    vi.mocked(useAuth).mockReturnValue({
      ...auth,
      capabilities: { ...auth.capabilities, administersOrganization: true },
    });
  }
}

const show = () =>
  render(
    <MemoryRouter>
      <WorkspaceGuardrailsPage />
    </MemoryRouter>,
  );

describe("WorkspaceGuardrailsPage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows a member the policy, with no way to a page that would refuse them", async () => {
    as("member");
    answer({ "GET /workspace/guardrails": [200, POLICY] });
    show();

    expect(await screen.findByText("c117f173-policy")).toBeTruthy();
    // Its organization's policy, headed by the name Switch Trust gave it.
    expect(screen.getByRole("heading", { name: "Baseline Monitoring (Alert)" })).toBeTruthy();
    expect(screen.queryByText("Switch Trust policy")).toBeNull();
    expect(screen.getByText("Switch Trust checks every message in Acme.")).toBeTruthy();
    // What it never reads is said beside the policy, so no one assumes every file is checked.
    expect(screen.getByText(TRUST_COVERAGE)).toBeTruthy();
    expect(TRUST_COVERAGE).toMatch(/Images, audio, video, archives.*delivered unchecked/);
    expect(screen.getByRole("link", { name: /View on Switch Trust/ }).getAttribute("href")).toBe(POLICY.policy_url);
    expect(screen.queryByRole("link", { name: "organization settings" })).toBeNull();
  });

  it("offers the organization's admin the way to edit it", async () => {
    as("orgAdmin");
    answer({ "GET /workspace/guardrails": [200, POLICY] });
    show();

    const edit = await screen.findByRole("link", { name: "organization settings" });
    expect(edit.getAttribute("href")).toBe("/settings/org/guardrails");
    expect(edit.parentElement?.textContent).toBe("Switch Trust checks every message in Acme. Edit in organization settings.");
  });

  it("says when nothing checks the workspace's messages", async () => {
    as("member");
    answer({ "GET /workspace/guardrails": [200, { checking: false, policy_id: null, policy_name: null, policy_url: null }] });
    show();

    expect(
      await screen.findByText("No guardrails configured. Guardrails are configured at the organization level."),
    ).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("heads an unnamed policy as a Switch Trust policy", async () => {
    as("member");
    answer({ "GET /workspace/guardrails": [200, { ...POLICY, policy_name: null }] });
    show();

    expect(await screen.findByRole("heading", { name: "Switch Trust policy" })).toBeTruthy();
  });

  it("leaves out the link for a policy Switch can't link to", async () => {
    as("member");
    answer({ "GET /workspace/guardrails": [200, { ...POLICY, policy_url: null }] });
    show();

    expect(await screen.findByText("c117f173-policy")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /View on Switch Trust/ })).toBeNull();
  });

  it("copies the policy ID, and says when the browser refuses", async () => {
    as("member");
    answer({ "GET /workspace/guardrails": [200, POLICY] });
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    show();

    const copy = await screen.findByRole("button", { name: "Copy the policy ID" });
    fireEvent.click(copy);
    expect(await screen.findByText("Copied the policy ID.")).toBeTruthy();
    expect(within(screen.getByRole("status")).queryByText("Copied the policy ID.")).toBeNull();
    expect(writeText).toHaveBeenCalledWith("c117f173-policy");
    fireEvent.click(copy);
    expect(
      await within(screen.getByRole("status")).findByText("Your browser blocked the clipboard. Select the ID and copy it."),
    ).toBeTruthy();
  });

  it("says when the policy can't be read", async () => {
    as("member");
    answer({ "GET /workspace/guardrails": [500, { detail: "boom" }] });
    show();

    expect(await screen.findByText(/Couldn't load the guardrails: boom/)).toBeTruthy();
  });
});
