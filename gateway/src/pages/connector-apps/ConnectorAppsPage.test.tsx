import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECTORS_NOT_ENABLED, type ConnectorApp, type ConnectorApps } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import ConnectorAppsPage from "./ConnectorAppsPage";
import { audienceText, ONLY_THE_OPERATOR, PUBLIC_URL_BANNER } from "./connectorApps";
import { app } from "./testFixtures";

vi.mock("../../data/AuthContext", () => ({ useAuth: vi.fn() }));

const NONE_GOOGLE = app({
  source: "none",
  client_id: null,
  saved_client_id: null,
  secrets: { client_secret: { set: false, last4: null } },
  connected_members: 0,
  workspaces: 0,
  updated_by_name: null,
  updated_at: null,
});

const GITHUB = app({
  slug: "github",
  name: "GitHub",
  kind: "github_app",
  configuration_variables: ["GITHUB_APP_CONFIG_PATH", "GITHUB_APP_PRIVATE_KEY_PATH"],
  fields: { slug: "example-app" },
  secrets: {
    client_secret: { set: true, last4: "cd34" },
    private_key: { set: true, fingerprint: "SHA256:example" },
  },
  redirect_uri: "https://switch.example.test/gateway/provider-connections/github/callback",
  install_url: "https://github.com/apps/example-app/installations/new",
});

const PEM = "-----BEGIN PRIVATE KEY-----\nexample-not-a-real-key-material\n-----END PRIVATE KEY-----\n";

type Call = { path: string; method: string; body: unknown };
type Answer = [number, unknown];

function serve(list: ConnectorApps, answers: Record<string, Answer | (() => Answer)> = {}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      const key = `${method} ${path.split("?")[0]}`;
      const answer = answers[key] ?? (key === "GET /gateway/connector-apps" ? [200, list] : null);
      const [status, body] =
        answer === null ? [404, { detail: `unmocked ${key}` }] : typeof answer === "function" ? answer() : answer;
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return calls;
}

function listOf(...apps: ConnectorApp[]): ConnectorApps {
  return {
    public_url: "https://switch.example.test",
    apps,
  };
}

function operator(isOperator = true) {
  vi.mocked(useAuth).mockReturnValue({ isOperator } as ReturnType<typeof useAuth>);
}

function card(slug: string) {
  return within(screen.getByTestId(`connector-app-${slug}`));
}

describe("ConnectorAppsPage", () => {
  beforeEach(() => operator());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("tells anyone but the operator whose page it is, and asks nothing of the server", () => {
    operator(false);
    const calls = serve(listOf());
    render(<ConnectorAppsPage />);
    expect(screen.getByText(ONLY_THE_OPERATOR)).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it("says what to turn on where the server has no connectors at all", async () => {
    serve(listOf(), { "GET /gateway/connector-apps": [404, { detail: "Not Found" }] });
    render(<ConnectorAppsPage />);
    expect(await screen.findByText(CONNECTORS_NOT_ENABLED)).toBeTruthy();
    expect(screen.queryAllByTestId(/connector-app-/)).toEqual([]);
  });

  it("lists every app, what needs setting up first, and who sets themselves up", async () => {
    serve(listOf(GITHUB, NONE_GOOGLE));
    render(<ConnectorAppsPage />);
    expect(await screen.findByText("Not set up")).toBeTruthy();
    const cards = screen.getAllByTestId(/connector-app-/);
    expect(cards.map((c) => c.dataset.testid)).toEqual([
      "connector-app-google-workspace",
      "connector-app-github",
    ]);
    expect(card("github").getByText("Ready")).toBeTruthy();
    expect(card("github").getByText(/Secret ends in cd34 · Key SHA256:example/)).toBeTruthy();
    expect(card("github").getByText("Used by 12 people in 3 workspaces")).toBeTruthy();
    expect(card("google-workspace").getByRole("button", { name: "Set up Google Workspace" })).toBeTruthy();
    expect(screen.queryByText(PUBLIC_URL_BANNER)).toBeNull();
    expect(screen.getByText(/People are sent back to https:\/\/switch\.example\.test\./)).toBeTruthy();
  });

  it("holds GitHub's set-up when the public URL is not https, saying why", async () => {
    const blocked = "GitHub needs GATEWAY_PUBLIC_URL to be an https address, to send people back to Switch.";
    serve({
      ...listOf(
        {
          ...GITHUB,
          source: "none",
          client_id: null,
          saved_client_id: null,
          secrets: { client_secret: { set: false, last4: null }, private_key: { set: false, fingerprint: null } },
          redirect_uri: null,
          install_url: null,
          setup_blocked: blocked,
        },
        NONE_GOOGLE,
      ),
      public_url: "http://switch.example.test",
    });
    render(<ConnectorAppsPage />);
    expect(await screen.findByText(/People are sent back to http:\/\/switch\.example\.test\./)).toBeTruthy();
    expect(card("github").getByText(blocked)).toBeTruthy();
    expect(card("github").getByText("Needs attention")).toBeTruthy();
    const github = card("github").getByRole("button", { name: "Set up GitHub" });
    expect((github as HTMLButtonElement).disabled).toBe(true);
    const google = card("google-workspace").getByRole("button", { name: "Set up Google Workspace" });
    expect((google as HTMLButtonElement).disabled).toBe(false);
  });

  it("asks for GATEWAY_PUBLIC_URL first, and holds set-up until it is there", async () => {
    serve({ ...listOf(NONE_GOOGLE), public_url: null });
    render(<ConnectorAppsPage />);
    expect(await screen.findByText(PUBLIC_URL_BANNER)).toBeTruthy();
    const setUp = card("google-workspace").getByRole("button", { name: "Set up Google Workspace" });
    expect((setUp as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps a refused set-up open on the values, saying what the vendor said", async () => {
    const calls = serve(listOf(NONE_GOOGLE), {
      "PUT /gateway/connector-apps/google-workspace": [
        422,
        {
          detail: "Google Workspace doesn't recognise this client ID and secret together.",
          field: "client_secret",
          checks: [],
        },
      ],
    });
    render(<ConnectorAppsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Set up Google Workspace" }));
    expect(screen.getByText(audienceText("internal"))).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Anyone with a Google account"));
    expect(screen.getByText(audienceText("external"))).toBeTruthy();
    expect(screen.queryByText(audienceText("internal"))).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    const secret = screen.getByLabelText("Client secret") as HTMLInputElement;
    expect(secret.type).toBe("password");
    expect(secret.value).toBe("");
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "example-client-id" } });
    fireEvent.change(secret, { target: { value: "example-wrong-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Check and save" }));

    expect(await screen.findByText(/doesn't recognise this client ID and secret/)).toBeTruthy();
    expect(screen.getByText("Step 2 of 3 · Paste its values")).toBeTruthy();
    expect(secret.getAttribute("aria-invalid")).toBe("true");
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
      client_id: "example-client-id",
      client_secret: "example-wrong-secret",
      replace: false,
    });
  });

  it("reads GitHub's private key from its file and never shows it", async () => {
    const calls = serve(
      listOf({ ...GITHUB, ...NONE_GOOGLE, slug: "github", name: "GitHub", kind: "github_app" }),
      { "PUT /gateway/connector-apps/github": [200, GITHUB] },
    );
    render(<ConnectorAppsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Set up GitHub" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "example-client-id" } });
    fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: "example-secret" } });
    const file = new File([PEM], "example.pem", { type: "application/x-pem-file" });
    fireEvent.change(screen.getByLabelText("Private key"), { target: { files: [file] } });
    expect(await screen.findByText(/Private key: example.pem/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("example-not-a-real-key-material");
    fireEvent.click(screen.getByRole("button", { name: "Check and save" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
        client_id: "example-client-id",
        client_secret: "example-secret",
        private_key: PEM,
        replace: false,
      }),
    );
    expect(document.body.textContent).not.toContain("example-not-a-real-key-material");
  });

  it("updates a secret without disconnecting anyone", async () => {
    const calls = serve(listOf(app()), {
      "PUT /gateway/connector-apps/google-workspace": [200, app()],
    });
    render(<ConnectorAppsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "More for Google Workspace" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Update secret" }));
    expect(screen.getByText("Nobody is disconnected.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: "example-new-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Check and save" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
        client_id: "example-client-id",
        client_secret: "example-new-secret",
        replace: false,
      }),
    );
  });

  it("warns before switching apps, shows who reconnects, then switches on purpose", async () => {
    const calls = serve(listOf(app()), {
      "GET /gateway/connector-apps/google-workspace/impact": [200, { connected_members: 12, workspaces: 3 }],
      "PUT /gateway/connector-apps/google-workspace": [200, app({ client_id: "another-client-id" })],
    });
    render(<ConnectorAppsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "More for Google Workspace" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Use a different app" }));
    expect(screen.getByText(/Everyone connected through the current app \(12 people in 3 workspaces\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "another-client-id" } });
    fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: "example-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Check who reconnects" }));
    expect(await screen.findByText("12 people in 3 workspaces will need to reconnect.")).toBeTruthy();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Switch app" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
        client_id: "another-client-id",
        client_secret: "example-secret",
        replace: true,
      }),
    );
  });

  it("goes back a step, keeping what was entered, and never before the first", async () => {
    serve(listOf(NONE_GOOGLE));
    render(<ConnectorAppsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Set up Google Workspace" }));
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open Clients" }).getAttribute("href")).toBe(
      "https://console.cloud.google.com/auth/clients",
    );
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "example-client-id" } });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText(/Step 1 of 3/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect((screen.getByLabelText("Client ID") as HTMLInputElement).value).toBe("example-client-id");
  });

  it("goes back from creating the app to the warning when switching", async () => {
    serve(listOf(app()));
    render(<ConnectorAppsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "More for Google Workspace" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Use a different app" }));
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText(/Step 1 of 3/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText(/Everyone connected through the current app/)).toBeTruthy();
  });

  it("walks moving off configuration, ticking copying in once it is done", async () => {
    const configured = app({ source: "configuration", saved_client_id: null });
    let imported = false;
    const calls = serve(listOf(configured), {
      "GET /gateway/connector-apps": () => [
        200,
        listOf(imported ? app({ source: "configuration", saved_ignored: true }) : configured),
      ],
      "POST /gateway/connector-apps/google-workspace/import": () => {
        imported = true;
        return [200, app({ source: "configuration", saved_ignored: true })];
      },
    });
    render(<ConnectorAppsPage />);
    const chip = (await screen.findByText("Set on the server")).closest(".MuiChip-root")!;
    expect(chip.className).toContain("MuiChip-colorSuccess");
    expect(chip.className).toContain("MuiChip-filled");
    expect(
      screen.getByText(
        "From GOOGLE_WORKSPACE_CLIENT_CONFIG_PATH. Change it there, or remove it to manage it here.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Manage it here instead" }));
    expect(screen.getAllByLabelText("To do")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Copy into Switch" }));
    await waitFor(() => expect(screen.getAllByLabelText("Done")).toHaveLength(1));
    expect(screen.getAllByLabelText("To do")).toHaveLength(2);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(
      await screen.findByText(/A copy is saved here, same client\. Remove the variable and restart Switch to use the copy\./),
    ).toBeTruthy();
    expect(screen.queryByText(/waiting for restart/)).toBeNull();
  });
});
