import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AddressingPolicy, type AgentDetail, OWNER_ONLY_POLICY } from "../../data/api";
import AddressingPolicySection from "./AddressingPolicySection";

const agent = {
  id: "a1",
  name: "helper",
  addressing_policy: null,
} as unknown as AgentDetail;

/** The section for an agent saved with `policy`. Reads answer empty; the
 * save answers `saveAnswer`, and what was sent is recorded. */
function show(policy: AddressingPolicy | null, saveAnswer: [number, unknown] = [200, agent]) {
  const sent: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        sent.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify(saveAnswer[1]), { status: saveAnswer[0] });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }),
  );
  const onUpdated = vi.fn();
  render(
    <AddressingPolicySection
      agent={{ ...agent, addressing_policy: policy }}
      canEdit
      onUpdated={onUpdated}
    />,
  );
  return { sent, onUpdated };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AddressingPolicySection", () => {
  it("does not take a rule that lets in the owner for one that lets in nobody", () => {
    show(OWNER_ONLY_POLICY);
    expect(screen.getByRole("checkbox", { name: "Its owner" })).toHaveProperty("checked", true);
    expect(screen.queryByText(/can never let anyone in/)).toBeNull();
  });

  it("does not take a field the server spells out for a change", () => {
    show({ rules: [{ ...OWNER_ONLY_POLICY.rules[0]!, platform: false }] });
    expect(screen.getByRole("button", { name: "Save policy" })).toHaveProperty("disabled", true);
  });

  it("names why a rule can never let anyone in, as the server would, and holds Save", () => {
    show(OWNER_ONLY_POLICY);
    fireEvent.click(screen.getByRole("checkbox", { name: "Its owner" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Its owner's other agents" }));
    expect(
      screen.getByText(
        /can never let anyone in: it lets in no people, no agents, not the owner and not the platform/,
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save policy" })).toHaveProperty("disabled", true);
  });

  it("starts a restricted policy with an owner-only rule, never with none", async () => {
    const { sent } = show(null);
    fireEvent.click(screen.getByRole("radio", { name: /Restricted/ }));
    expect(screen.getByText("Rule 1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ policy: OWNER_ONLY_POLICY });
  });

  it("keeps the last rule, saying how to let anyone in instead", () => {
    show(OWNER_ONLY_POLICY);
    expect(screen.getByRole("button", { name: "Remove rule" })).toHaveProperty("disabled", true);
    expect(
      screen.getByLabelText(
        "A restricted policy needs a rule. To let anyone address this agent, choose Open.",
      ),
    ).toBeTruthy();
  });

  it("shows a policy saved with no rules as Open, since anyone can address it, and records it so", async () => {
    const { sent } = show({ rules: [] });
    expect(screen.getByRole("radio", { name: /Open/ })).toHaveProperty("checked", true);
    expect(screen.getByText(/has no rules, so anyone can address it/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ policy: null });
  });

  it("shows the server's reason when it refuses a save", async () => {
    show(null, [422, { detail: "These rules can never let anyone in: rule 1: it names no rooms." }]);
    fireEvent.click(screen.getByRole("radio", { name: /Restricted/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    expect(
      await screen.findByText("These rules can never let anyone in: rule 1: it names no rooms."),
    ).toBeTruthy();
  });
});
