import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Person } from "../../data/api";
import EraseDialog, { relatedIdentities } from "./EraseDialog";
import { describeErasure } from "./PeopleSection";

function person(id: string, username: string, claimants: string[], messages = 0): Person {
  return {
    id,
    kind: "identity",
    username,
    platform: "slack",
    bridge_name: `Bridge ${id}`,
    message_count: messages,
    claimed_by: claimants.map((c) => ({ user_id: c, name: `Member ${c}` })),
  };
}

const ana = person("a", "ana", ["m1"], 10);
const anaElsewhere = person("b", "ana.b", ["m1"], 5);
const bo = person("c", "bo", [], 3);

describe("relatedIdentities", () => {
  it("finds identities sharing a claimant, and none for an unclaimed person", () => {
    expect(relatedIdentities(ana, [ana, anaElsewhere, bo])).toEqual([anaElsewhere]);
    expect(relatedIdentities(bo, [ana, anaElsewhere, bo])).toEqual([]);
  });
});

describe("describeErasure", () => {
  it("reads as progress, then as an outcome", () => {
    const base = {
      id: "e",
      identities: 1,
      identities_erased: 0,
      files_deleted: 0,
      error: null,
      requested_by_user_id: null,
      created_at: "2026-10-06T00:00:00Z",
      completed_at: null,
    };
    expect(describeErasure({ ...base, state: "running", messages_deleted: 1200 })).toBe(
      "In progress: 1,200 messages deleted so far",
    );
    expect(
      describeErasure({ ...base, state: "done", messages_deleted: 1, files_deleted: 2 }),
    ).toBe("Erased: 1 message and 2 files deleted");
  });
});

describe("EraseDialog", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("erases only once the name is typed, and only the person unless more are ticked", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: "e1", state: "queued" }), { status: 202 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onQueued = vi.fn();
    render(
      <EraseDialog
        tenantId="t1"
        person={ana}
        people={[ana, anaElsewhere, bo]}
        onClose={() => {}}
        onQueued={onQueued}
      />,
    );

    expect(screen.getByText(/10 messages they sent/)).toBeTruthy();
    const erase = screen.getByRole("button", { name: "Erase" });
    expect(erase.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Type ana to confirm"), { target: { value: "Ana" } });
    expect(erase.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Type ana to confirm"), { target: { value: "ana" } });
    fireEvent.click(erase);

    await waitFor(() => expect(onQueued).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ external_user_ids: ["a"], former_sender_ids: [] });
  });

  it("keeps what was ticked and typed when the people list refreshes", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const props = { tenantId: "t1", person: ana, onClose: () => {}, onQueued: () => {} };
    const { rerender } = render(<EraseDialog {...props} people={[ana, anaElsewhere]} />);

    fireEvent.click(screen.getByLabelText(/ana.b on Bridge b/));
    fireEvent.change(screen.getByLabelText("Type ana to confirm"), { target: { value: "ana" } });
    rerender(<EraseDialog {...props} people={[{ ...ana }, { ...anaElsewhere }]} />);

    expect(screen.getByText(/15 messages they sent/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Erase" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ external_user_ids: ["a", "b"], former_sender_ids: [] });
  });

  it("erases a former participant by the sender id their messages carry", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const former: Person = {
      id: "@switch-slack-x-dee:example.org",
      kind: "former",
      username: "dee",
      platform: "slack",
      bridge_name: null,
      message_count: 4,
      claimed_by: [],
    };
    render(
      <EraseDialog
        tenantId="t1"
        person={former}
        people={[former, ana]}
        onClose={() => {}}
        onQueued={() => {}}
      />,
    );

    expect(screen.getByText(/the disconnected app/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Type dee to confirm"), { target: { value: "dee" } });
    fireEvent.click(screen.getByRole("button", { name: "Erase" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      external_user_ids: [],
      former_sender_ids: ["@switch-slack-x-dee:example.org"],
    });
  });
});
