import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CreateInvitationDialog from "./CreateInvitationDialog";
import { useInvitationCreated } from "./invitationEvents";

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

function sentBody(fetchMock: ReturnType<typeof answerCreateWith>) {
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function pick(label: string, option: string) {
  fireEvent.mouseDown(screen.getByRole("combobox", { name: label }));
  fireEvent.click(within(screen.getByRole("listbox")).getByText(option));
}

function renderDialog(emailEnabled: boolean) {
  render(
    <CreateInvitationDialog
      open
      tenantId="t1"
      workspaceName="Acme"
      emailEnabled={emailEnabled}
      onClose={() => {}}
    />,
  );
}

function fillIn() {
  pick("Role", "Member");
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
    fillIn();

    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));

    expect(await screen.findByText(/e-mailed to bo@example.com/)).toBeTruthy();
    expect(screen.getByDisplayValue(/\/invite#token=tok123$/)).toBeTruthy();
    expect(sentBody(fetchMock).email).toBe("bo@example.com");
  });

  it("says nothing was sent when the server has no mail, and shows the link", async () => {
    answerCreateWith({ ...created, email_delivery: "not_configured" });
    renderDialog(false);
    fillIn();

    fireEvent.click(screen.getByRole("button", { name: "Create link" }));

    expect(await screen.findByText(/No e-mail was sent/)).toBeTruthy();
    expect(screen.getByDisplayValue(/\/invite#token=tok123$/)).toBeTruthy();
  });

  it("offers the two workspace roles and waits for one to be picked", () => {
    renderDialog(false);

    const create = screen.getByRole("button", { name: "Create link" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "Role" }));
    const offered = within(screen.getByRole("listbox"))
      .getAllByRole("option")
      .map((option) => option.querySelector(".MuiListItemText-primary")?.textContent);
    expect(offered).toEqual(["Workspace admin", "Member"]);
    fireEvent.click(within(screen.getByRole("listbox")).getByText("Workspace admin"));
    expect(create.disabled).toBe(false);
  });

  it("asks for the picked role and expiry, and tells the page a link was made", async () => {
    const fetchMock = answerCreateWith({ ...created, email: null, email_delivery: "not_requested" });
    const heard = vi.fn();
    function Listener() {
      useInvitationCreated(heard);
      return null;
    }
    render(<Listener />);
    renderDialog(false);
    pick("Role", "Workspace admin");
    pick("Expires after", "30 days");

    fireEvent.click(screen.getByRole("button", { name: "Create link" }));

    expect(await screen.findByText(/shown only once/)).toBeTruthy();
    expect(sentBody(fetchMock)).toMatchObject({
      role: "admin",
      email: null,
      expires_in_hours: 720,
      uses_remaining: 1,
    });
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("can't be closed while the link is being made, since it is shown only once", async () => {
    let answer: (response: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => (answer = resolve))));
    const onClose = vi.fn();
    render(
      <CreateInvitationDialog open tenantId="t1" workspaceName="Acme" emailEnabled={false} onClose={onClose} />,
    );
    pick("Role", "Member");

    fireEvent.click(screen.getByRole("button", { name: "Create link" }));

    const cancel = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    answer(new Response(JSON.stringify({ ...created, email: null, email_delivery: "not_requested" }), { status: 201 }));
    expect(await screen.findByDisplayValue(/\/invite#token=tok123$/)).toBeTruthy();
  });

  it("shows the server's refusal, such as the daily e-mail limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ detail: "This workspace has sent its daily limit of 20 invitation e-mails" }),
            { status: 429 },
          ),
      ),
    );
    renderDialog(true);
    fillIn();

    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));

    expect(await screen.findByText(/daily limit of 20 invitation e-mails/)).toBeTruthy();
  });
});
