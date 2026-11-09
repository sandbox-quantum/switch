import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as logins from "../../../data/cloudLogins";
import * as hosted from "../../../data/hostedCloud";
import type { CloudMachine } from "../../../data/hostedCloud";
import * as seal from "../../../data/sealLogin";
import CloudLoginDialog, { ASLEEP_TEXT, OUTCOME_TEXT } from "./CloudLoginDialog";

vi.mock("../../../data/cloudLogins", async (original) => ({
  ...(await original<typeof import("../../../data/cloudLogins")>()),
  giveCloudLogin: vi.fn(),
  waitForOperation: vi.fn(),
}));

vi.mock("../../../data/hostedCloud", async (original) => ({
  ...(await original<typeof import("../../../data/hostedCloud")>()),
  ensureCloudMachine: vi.fn(),
  startCloudMachine: vi.fn(),
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

const box = (over: Partial<CloudMachine> = {}): CloudMachine => ({
  machine_id: "m-1",
  state: "ready",
  desired_state: "running",
  stop_reason: null,
  sleeping: false,
  revision: 4,
  error: null,
  error_code: null,
  agents: ["a-1"],
  controller_id: "box-ctl",
  backend: "box",
  room: null,
  awake: null,
  ai_calls_today: null,
  ...over,
});

function dialog(provider = "claude", label = "Claude", onClose = () => {}, machine = box(), onCloudChanged = () => {}) {
  return render(
    <CloudLoginDialog
      open
      provider={provider}
      providerLabel={label}
      machine={machine}
      onCloudChanged={onCloudChanged}
      onClose={onClose}
      onDone={() => {}}
    />,
  );
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

  it("once signed in, shows only the outcome and a single Done, with no key field to give again", async () => {
    const onClose = vi.fn();
    dialog("claude", "Claude", onClose);
    fireEvent.change(await screen.findByLabelText("Setup token", { selector: "input" }), { target: { value: MARKER } });
    fireEvent.click(screen.getByRole("button", { name: "Give login" }));
    await waitFor(() => expect(screen.getByText(OUTCOME_TEXT.succeeded)).toBeTruthy());
    expect(screen.queryByLabelText("Setup token", { selector: "input" })).toBeNull();
    expect(screen.queryByLabelText("Login")).toBeNull();
    expect(screen.queryByRole("button", { name: "Give login" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("says plainly when the box couldn't sign in with it, in Switch's own fixed words, and lets them try again", async () => {
    vi.mocked(logins.waitForOperation).mockResolvedValue("failed");
    dialog();
    fireEvent.change(await screen.findByLabelText("Setup token", { selector: "input" }), { target: { value: MARKER } });
    fireEvent.click(screen.getByRole("button", { name: "Give login" }));
    await waitFor(() => expect(screen.getByText(OUTCOME_TEXT.failed)).toBeTruthy());
    expect(screen.getByLabelText("Setup token", { selector: "input" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Give login" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
  });

  it("keeps the fields while the box is still checking, since it hasn't signed in yet", async () => {
    vi.mocked(logins.waitForOperation).mockResolvedValue(null);
    dialog();
    fireEvent.change(await screen.findByLabelText("Setup token", { selector: "input" }), { target: { value: MARKER } });
    fireEvent.click(screen.getByRole("button", { name: "Give login" }));
    await waitFor(() => expect(screen.getByText(OUTCOME_TEXT.waiting)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Give login" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
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

describe("a box that isn't up (PM rule 1)", () => {
  it.each([
    ["put away (retained)", box({ state: "retained", desired_state: "retained" })],
    ["resting", box({ sleeping: true })],
    ["resting with no agents", box({ sleeping: true, agents: [] })],
  ])("when %s, says it's asleep and offers Wake it, with no key field", async (_name, machine) => {
    const onCloudChanged = vi.fn();
    vi.mocked(hosted.ensureCloudMachine).mockResolvedValue(null);
    dialog("claude", "Claude", () => {}, machine, onCloudChanged);
    expect((await screen.findByTestId("cloud-asleep")).textContent).toBe(ASLEEP_TEXT.asleep);
    expect(screen.queryByLabelText("Setup token", { selector: "input" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Give login" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Wake it" }));
    await waitFor(() => expect(onCloudChanged).toHaveBeenCalled());
    expect(hosted.ensureCloudMachine).toHaveBeenCalled();
    expect(hosted.startCloudMachine).not.toHaveBeenCalled();
    expect(logins.giveCloudLogin).not.toHaveBeenCalled();
  });

  it("offers Start for a box its owner stopped, by lifecycle start", async () => {
    const machine = box({ state: "stopped", desired_state: "stopped", stop_reason: "owner" });
    vi.mocked(hosted.startCloudMachine).mockResolvedValue();
    dialog("claude", "Claude", () => {}, machine);
    expect((await screen.findByTestId("cloud-asleep")).textContent).toBe(ASLEEP_TEXT.stopped);
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(hosted.startCloudMachine).toHaveBeenCalledWith(machine));
    expect(hosted.ensureCloudMachine).not.toHaveBeenCalled();
  });

  it("says plainly when the wake fails, in fixed words", async () => {
    vi.mocked(hosted.ensureCloudMachine).mockRejectedValue(new Error("upstream said <b>no</b>"));
    dialog("claude", "Claude", () => {}, box({ sleeping: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Wake it" }));
    await waitFor(() => expect(screen.getByText(ASLEEP_TEXT.wakeFailed)).toBeTruthy());
    expect(document.body.textContent).not.toContain("upstream");
  });

  it("offers nothing to press while it starts, then carries on to the form once it's ready", async () => {
    const view = dialog("claude", "Claude", () => {}, box({ state: "provisioning" }));
    expect((await screen.findByTestId("cloud-asleep")).textContent).toBe(ASLEEP_TEXT.starting);
    expect(screen.queryByRole("button", { name: "Wake it" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    view.rerender(
      <CloudLoginDialog open provider="claude" providerLabel="Claude" machine={box()} onCloudChanged={() => {}} onClose={() => {}} onDone={() => {}} />,
    );
    expect(await screen.findByLabelText("Setup token", { selector: "input" })).toBeTruthy();
    expect(screen.queryByTestId("cloud-asleep")).toBeNull();
  });

  it("offers no wake for a box Switch paused, and shows the panel's own words", async () => {
    dialog("claude", "Claude", () => {}, box({ state: "stopped", desired_state: "stopped", stop_reason: "paused" }));
    expect((await screen.findByTestId("cloud-asleep")).textContent).toBe("Paused by Switch. Contact your admin");
    expect(screen.queryByRole("button", { name: "Wake it" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Give login" })).toBeNull();
  });
});

describe("Close is never disabled (PM rule 3)", () => {
  it("stays on while the box is being followed, and closing stops only the following", async () => {
    const onClose = vi.fn();
    vi.mocked(logins.waitForOperation).mockImplementation(
      (_id, _match, options) =>
        new Promise((resolve) => options?.signal?.addEventListener("abort", () => resolve(null))),
    );
    const view = dialog("claude", "Claude", onClose);
    fireEvent.change(await screen.findByLabelText("Setup token", { selector: "input" }), { target: { value: MARKER } });
    fireEvent.click(screen.getByRole("button", { name: "Give login" }));
    await waitFor(() => expect(logins.waitForOperation).toHaveBeenCalled());
    const close = screen.getByRole("button", { name: "Close" }) as HTMLButtonElement;
    expect(close.disabled).toBe(false);
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalled();
    // The parent closes it: the following stops, and the login stays sent.
    view.rerender(
      <CloudLoginDialog open={false} provider="claude" providerLabel="Claude" machine={box()} onCloudChanged={() => {}} onClose={onClose} onDone={() => {}} />,
    );
    await waitFor(() => expect(vi.mocked(logins.waitForOperation).mock.calls[0]![2]!.signal!.aborted).toBe(true));
    expect(logins.giveCloudLogin).toHaveBeenCalledTimes(1);
    noMarkerAnywhere(MARKER);
  });

  it("closed while the login is being sent: no outcome shows, and the panel is told to read again", async () => {
    let send!: (value: Awaited<ReturnType<typeof logins.giveCloudLogin>>) => void;
    vi.mocked(logins.giveCloudLogin).mockImplementation(() => new Promise((resolve) => (send = resolve)));
    const onDone = vi.fn();
    const props = { provider: "claude", providerLabel: "Claude", machine: box(), onCloudChanged: () => {}, onClose: () => {}, onDone };
    const view = render(<CloudLoginDialog open {...props} />);
    fireEvent.change(await screen.findByLabelText("Setup token", { selector: "input" }), { target: { value: MARKER } });
    fireEvent.click(screen.getByRole("button", { name: "Give login" }));
    await waitFor(() => expect(logins.giveCloudLogin).toHaveBeenCalled());
    view.rerender(<CloudLoginDialog open={false} {...props} />);
    await act(async () => send({ controllerId: "box-ctl", operation: { id: "op-1", state: "pending" } }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(logins.waitForOperation).not.toHaveBeenCalled();
    // Opened again: a fresh form, not a stale outcome or a stuck spinner.
    view.rerender(<CloudLoginDialog open {...props} />);
    expect(await screen.findByLabelText("Setup token", { selector: "input" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Give login" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(OUTCOME_TEXT.succeeded)).toBeNull();
  });
});

describe("reading the box faster while it waits", () => {
  const props = (machine: CloudMachine, onHurry: () => () => void, open = true) => (
    <CloudLoginDialog
      open={open}
      provider="claude"
      providerLabel="Claude"
      machine={machine}
      onCloudChanged={() => {}}
      onClose={() => {}}
      onDone={() => {}}
      onHurry={onHurry}
    />
  );

  it("asks for the waking rate in front of a resting box, and lets go once it's up or closed", () => {
    const release = vi.fn();
    const onHurry = vi.fn(() => release);
    const { rerender } = render(props(box({ sleeping: true, state: "stopped" }), onHurry));
    expect(onHurry).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    // The box came up: the key field shows, and the normal rate is back.
    rerender(props(box(), onHurry));
    expect(release).toHaveBeenCalledOnce();
    // Resting again, then closed.
    rerender(props(box({ sleeping: true, state: "stopped" }), onHurry));
    expect(onHurry).toHaveBeenCalledTimes(2);
    rerender(props(box({ sleeping: true, state: "stopped" }), onHurry, false));
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("doesn't ask while the box is up", () => {
    const onHurry = vi.fn(() => () => {});
    render(props(box(), onHurry));
    expect(onHurry).not.toHaveBeenCalled();
  });
});
