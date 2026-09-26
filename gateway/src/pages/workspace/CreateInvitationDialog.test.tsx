import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CreateInvitationDialog from "./CreateInvitationDialog";

function answerCreateWith(body: Record<string, unknown>) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const created = {
  id: "i1",
  role: "member",
  email: "bo@example.com",
  expires_at: "2030-01-01",
  uses_remaining: 1,
  revoked_at: null,
  created_by: "u1",
  created_at: "2029-12-25",
  token: "tok123",
};

function renderDialog(emailEnabled: boolean) {
  render(
    <CreateInvitationDialog
      open
      tenantId="t1"
      isOwner={false}
      emailEnabled={emailEnabled}
      onClose={() => {}}
      onCreated={() => {}}
    />,
  );
  fireEvent.change(screen.getByLabelText("Email (optional)"), {
    target: { value: "bo@example.com" },
  });
}

describe("CreateInvitationDialog", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("sends the invitation when mail is set up, and says it went", async () => {
    const fetchMock = answerCreateWith({ ...created, email_delivery: "sent" });
    renderDialog(true);

    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));

    expect(await screen.findByText(/e-mailed to bo@example.com/)).toBeTruthy();
    expect(screen.getByDisplayValue(/\/invite#token=tok123$/)).toBeTruthy();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).email).toBe("bo@example.com");
  });

  it("says nothing was sent when the server has no mail, and shows the link", async () => {
    answerCreateWith({ ...created, email_delivery: "not_configured" });
    renderDialog(false);

    fireEvent.click(screen.getByRole("button", { name: "Create link" }));

    expect(await screen.findByText(/No e-mail was sent/)).toBeTruthy();
    expect(screen.getByDisplayValue(/\/invite#token=tok123$/)).toBeTruthy();
  });
});
