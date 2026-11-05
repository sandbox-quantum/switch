import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as logins from "../../../data/cloudLogins";
import * as seal from "../../../data/sealLogin";
import CloudLoginDialog, { OUTCOME_TEXT } from "./CloudLoginDialog";

vi.mock("../../../data/cloudLogins", async (original) => ({
  ...(await original<typeof import("../../../data/cloudLogins")>()),
  giveCloudLogin: vi.fn(),
  waitForOperation: vi.fn(),
}));

vi.mock("../../../data/sealLogin", async (original) => ({
  ...(await original<typeof import("../../../data/sealLogin")>()),
  canSeal: vi.fn(async () => true),
}));

const MARKER = "sk-ant-MARKER-77aa";
const KEY_FILE = {
  type: "service_account",
  client_email: "agent@demo-project.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nKEYMARKER\n-----END PRIVATE KEY-----\n",
};

let logs: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  vi.mocked(logins.giveCloudLogin).mockResolvedValue({ controllerId: "box-ctl", operation: { id: "op-1", state: "pending" } });
  vi.mocked(logins.waitForOperation).mockResolvedValue("succeeded");
  vi.mocked(seal.canSeal).mockResolvedValue(true);
  logs = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  logs.forEach((spy) => spy.mockRestore());
  localStorage.clear();
  sessionStorage.clear();
});

function dialog(provider = "claude", label = "Claude") {
  return render(<CloudLoginDialog open provider={provider} providerLabel={label} onClose={() => {}} onDone={() => {}} />);
}

function noMarkerAnywhere(marker: string) {
  expect(document.body.innerHTML).not.toContain(marker);
  expect(JSON.stringify({ ...localStorage })).not.toContain(marker);
  expect(JSON.stringify({ ...sessionStorage })).not.toContain(marker);
  for (const spy of logs) expect(JSON.stringify(spy.mock.calls)).not.toContain(marker);
}

describe("a pasted API key or setup token", () => {
  it("is a password field the browser won't remember, read once, sealed and sent, then cleared", async () => {
    dialog();
    const field = (await screen.findByLabelText("Setup token", { selector: "input" })) as HTMLInputElement;
    expect(field.type).toBe("password");
    expect(field.getAttribute("autocomplete")).toBe("new-password");
    expect(field.getAttribute("spellcheck")).toBe("false");
    fireEvent.change(field, { target: { value: MARKER } });
    fireEvent.click(screen.getByRole("button", { name: "Give login" }));
    await waitFor(() => expect(screen.getByText(OUTCOME_TEXT.succeeded)).toBeTruthy());
    expect(logins.giveCloudLogin).toHaveBeenCalledWith("claude", { kind: "setup-token", credential: MARKER });
    expect(field.value).toBe("");
    noMarkerAnywhere(MARKER);
  });

  it("says plainly when the box couldn't sign in with it, in Switch's own fixed words", async () => {
    vi.mocked(logins.waitForOperation).mockResolvedValue("failed");
    dialog();
    fireEvent.change(await screen.findByLabelText("Setup token", { selector: "input" }), { target: { value: MARKER } });
    fireEvent.click(screen.getByRole("button", { name: "Give login" }));
    await waitFor(() => expect(screen.getByText(OUTCOME_TEXT.failed)).toBeTruthy());
  });

  it("offers Codex only an API key", async () => {
    dialog("codex", "Codex");
    fireEvent.mouseDown(await screen.findByLabelText("Login"));
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["API key"]);
  });

  it("clears the field when sealing is refused, and shows only fixed words", async () => {
    vi.mocked(logins.giveCloudLogin).mockRejectedValue(new seal.SealRefused("key_mismatch"));
    dialog();
    const field = (await screen.findByLabelText("Setup token", { selector: "input" })) as HTMLInputElement;
    fireEvent.change(field, { target: { value: MARKER } });
    fireEvent.click(screen.getByRole("button", { name: "Give login" }));
    await waitFor(() => expect(screen.getByText(/couldn't check your cloud's key/)).toBeTruthy());
    expect(field.value).toBe("");
    noMarkerAnywhere(MARKER);
  });
});

describe("a Vertex key file", () => {
  async function chooseVertex() {
    dialog();
    fireEvent.mouseDown(await screen.findByLabelText("Login"));
    fireEvent.click(await screen.findByRole("option", { name: /Vertex AI/ }));
    fireEvent.change(screen.getByLabelText(/Google Cloud project/), { target: { value: "demo-project" } });
  }

  function pick(content: unknown) {
    const input = screen.getByLabelText("Service account key file") as HTMLInputElement;
    const file = new File([JSON.stringify(content)], "key.json", { type: "application/json" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    return input;
  }

  it("is read from the file, built as Console builds it, and only the sealed form leaves", async () => {
    await chooseVertex();
    pick(KEY_FILE);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Give login" }));
    });
    await waitFor(() => expect(logins.giveCloudLogin).toHaveBeenCalled());
    const [, login] = vi.mocked(logins.giveCloudLogin).mock.calls[0]!;
    expect(login.kind).toBe("vertex");
    expect(JSON.parse(login.credential)).toEqual({ v: 1, project: "demo-project", region: "global", credentials: KEY_FILE });
    noMarkerAnywhere("KEYMARKER");
  });

  it("refuses a Google sign-in file and sends nothing", async () => {
    await chooseVertex();
    pick({ type: "authorized_user", client_id: "x", client_secret: "y", refresh_token: "REFRESHMARKER" });
    fireEvent.click(screen.getByRole("button", { name: "Give login" }));
    await waitFor(() => expect(screen.getByText(/isn't a service account key/)).toBeTruthy());
    expect(logins.giveCloudLogin).not.toHaveBeenCalled();
    noMarkerAnywhere("REFRESHMARKER");
  });
});

describe("a browser that can't seal", () => {
  it("says to use Console, and Give login stays off", async () => {
    vi.mocked(seal.canSeal).mockResolvedValue(false);
    dialog();
    await waitFor(() => expect(screen.getByText(/can't lock a login/)).toBeTruthy());
    expect((screen.getByRole("button", { name: "Give login" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

it("says Console is the stronger place to add a login", async () => {
  dialog();
  expect(await screen.findByText(/Switch Console is the stronger place/)).toBeTruthy();
});
