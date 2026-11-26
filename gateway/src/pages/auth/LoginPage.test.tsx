import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import LoginPage, { suggestedWorkspaceName } from "./LoginPage";

const api = vi.hoisted(() => ({
  fetchAuthConfig: vi.fn(),
  signUp: vi.fn(),
  createTenant: vi.fn(),
  fetchLicense: vi.fn(),
}));
vi.mock("../../data/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../data/api")>()),
  ...api,
}));

const auth = vi.hoisted(() => ({ login: vi.fn(), signUp: vi.fn(), refresh: vi.fn() }));
vi.mock("../../data/AuthContext", () => ({ useAuth: () => auth }));

function config(webSignup: boolean, overrides: Record<string, unknown> = {}) {
  return {
    password_login_enabled: true,
    web_signup_enabled: webSignup,
    oidc_enabled: false,
    oidc_provider_label: null,
    oidc_login_options: [],
    signup_mode: "default_tenant",
    ...overrides,
  };
}

const realLocation = window.location;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  Object.defineProperty(window, "location", { value: realLocation, configurable: true });
});

/** Where the page sends the browser, kept rather than followed. */
function captureNavigation(): { href: string } {
  const location = { href: "" };
  Object.defineProperty(window, "location", { value: location, configurable: true });
  return location;
}

function type(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** Opens sign-up and fills in the first card: name and email. */
async function startSignUp() {
  fireEvent.click(await screen.findByRole("button", { name: "Sign up" }));
  expect(await screen.findByRole("heading", { name: "Sign up for Switch" })).toBeTruthy();
  type("First name", "Ada");
  type("Last name", "Lovelace");
  type("Email", "ada@example.com");
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  return screen.findByLabelText("Password");
}

describe("LoginPage", () => {
  it("signs in with the email first, then the password on the same card", async () => {
    api.fetchAuthConfig.mockResolvedValue(config(false));
    auth.login.mockResolvedValue(undefined);
    render(<LoginPage />);
    expect(screen.getByRole("heading", { name: "Sign in to Switch" })).toBeTruthy();
    type("Email", "ada@example.com");
    expect(screen.queryByLabelText("Password")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue with email" }));
    await screen.findByLabelText("Password");
    type("Password", "pw");
    expect(screen.getByText("ada@example.com")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(auth.login).toHaveBeenCalledWith("ada@example.com", "pw"));
  });

  it("goes back to the email from the password step", async () => {
    api.fetchAuthConfig.mockResolvedValue(config(false));
    render(<LoginPage />);
    type("Email", "ada@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Continue with email" }));
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("ada@example.com");
  });

  it("shows the server's refusal on the card", async () => {
    api.fetchAuthConfig.mockResolvedValue(config(false));
    auth.login.mockRejectedValue(new Error("Invalid email or password"));
    render(<LoginPage />);
    type("Email", "ada@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Continue with email" }));
    await screen.findByLabelText("Password");
    type("Password", "wrong");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Invalid email or password")).toBeTruthy();
  });

  it("creates an account where the server offers sign-up on the web", async () => {
    api.fetchAuthConfig.mockResolvedValue(config(true));
    auth.signUp.mockResolvedValue(undefined);
    render(<LoginPage />);
    await startSignUp();
    type("Password", "a long password");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() =>
      expect(auth.signUp).toHaveBeenCalledWith({
        email: "ada@example.com",
        password: "a long password",
        name: "Ada Lovelace",
      }),
    );
    expect(auth.login).not.toHaveBeenCalled();
  });

  it("sends no name when none was given", async () => {
    api.fetchAuthConfig.mockResolvedValue(config(true));
    auth.signUp.mockResolvedValue(undefined);
    render(<LoginPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign up" }));
    type("Email", "ada@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByLabelText("Password");
    type("Password", "a long password");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() =>
      expect(auth.signUp).toHaveBeenCalledWith({
        email: "ada@example.com",
        password: "a long password",
        name: null,
      }),
    );
  });

  it("only signs in where it does not", async () => {
    api.fetchAuthConfig.mockResolvedValue(config(false));
    render(<LoginPage />);
    await waitFor(() => expect(api.fetchAuthConfig).toHaveBeenCalled());
    await screen.findByRole("button", { name: "Continue with email" });
    expect(screen.queryByRole("button", { name: "Sign up" })).toBeNull();
    expect(screen.queryByText(/Don't have an account/)).toBeNull();
  });

  it("goes back from sign-up to sign-in", async () => {
    api.fetchAuthConfig.mockResolvedValue(config(true));
    render(<LoginPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign up" }));
    expect(screen.getByText(/Already have an account\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByRole("heading", { name: "Sign in to Switch" })).toBeTruthy();
    expect(screen.queryByLabelText("First name")).toBeNull();
  });

  it("offers one button per sign-in option, each starting that option's sign-in, with its mark", async () => {
    api.fetchAuthConfig.mockResolvedValue(
      config(false, {
        oidc_enabled: true,
        oidc_provider_label: "Okta",
        oidc_login_options: [
          { id: "google", label: "Google" },
          { id: "github", label: "GitHub" },
        ],
      }),
    );
    const location = captureNavigation();
    render(<LoginPage />);
    const github = await screen.findByRole("button", { name: "Continue with GitHub" });
    fireEvent.click(github);
    expect(location.href).toBe("/gateway/auth/oidc/login?provider=github");
    const google = screen.getByRole("button", { name: "Continue with Google" });
    fireEvent.click(google);
    expect(location.href).toBe("/gateway/auth/oidc/login?provider=google");
    expect(screen.queryByRole("button", { name: "Continue with Okta" })).toBeNull();
    // Google's mark is the multicoloured G; GitHub's draws in the text colour.
    expect(google.querySelector('path[fill="#4285F4"]')).not.toBeNull();
    expect(github.querySelector('svg[fill="currentColor"]')).not.toBeNull();
    expect(screen.getByText("or")).toBeTruthy();
  });

  it("offers one button for the identity provider when the server lists no options", async () => {
    api.fetchAuthConfig.mockResolvedValue(
      config(false, { oidc_enabled: true, oidc_provider_label: "Okta" }),
    );
    const location = captureNavigation();
    render(<LoginPage />);
    const okta = await screen.findByRole("button", { name: "Continue with Okta" });
    fireEvent.click(okta);
    expect(location.href).toBe("/gateway/auth/oidc/login");
    expect(screen.getAllByRole("button", { name: /^Continue with/ })).toHaveLength(2);
    expect(okta.querySelector("svg.lucide-key-round")).not.toBeNull();
  });

  it("offers only the sign-in providers where password sign-in is off", async () => {
    api.fetchAuthConfig.mockResolvedValue(
      config(false, {
        password_login_enabled: false,
        oidc_enabled: true,
        oidc_provider_label: "Okta",
        signup_mode: "open",
      }),
    );
    render(<LoginPage />);
    expect(await screen.findByText(/^New to Switch\? Signing in creates your account/)).toBeTruthy();
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(screen.queryByText("or")).toBeNull();
    expect(screen.getByRole("button", { name: "Continue with Okta" })).toBeTruthy();
  });

  it("says on sign-up that creating an account agrees to the license, and shows it", async () => {
    api.fetchAuthConfig.mockResolvedValue(config(true));
    api.fetchLicense.mockResolvedValue({ version: "v1", text: "Software: Agent Switch\nThe terms." });
    render(<LoginPage />);
    expect(screen.queryByText(/you agree to the/)).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Sign up" }));
    const footer = screen.getByText(/By creating an account, you agree to the/);
    fireEvent.click(within(footer).getByRole("button", { name: "license" }));
    expect(await screen.findByText(/The terms\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to sign up" }));
    expect(await screen.findByRole("heading", { name: "Sign up for Switch" })).toBeTruthy();
  });

  describe("under open sign-up, where each new account makes its own workspace", () => {
    async function fillAccount() {
      api.fetchAuthConfig.mockResolvedValue(config(true, { signup_mode: "open" }));
      render(<LoginPage />);
      await startSignUp();
      type("Password", "a long password");
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      return (await screen.findByLabelText(/Workspace name/)) as HTMLInputElement;
    }

    it("asks for the workspace's name next, suggested from the person's", async () => {
      const field = await fillAccount();
      expect(field.value).toBe("Ada's workspace");
      expect(api.signUp).not.toHaveBeenCalled();
      for (const step of ["Account", "Workspace", "Team", "License"])
        expect(screen.getByText(step)).toBeTruthy();
      expect(screen.getByText("Workspace").closest("li")?.getAttribute("aria-current")).toBe("step");
    });

    it("creates the account, then the workspace under the name given, then reads the session", async () => {
      api.signUp.mockResolvedValue({});
      api.createTenant.mockResolvedValue({});
      auth.refresh.mockResolvedValue(undefined);
      const field = await fillAccount();
      fireEvent.change(field, { target: { value: "Analytical Engines" } });
      fireEvent.click(screen.getByRole("button", { name: "Create account" }));
      await waitFor(() => expect(auth.refresh).toHaveBeenCalled());
      expect(api.signUp).toHaveBeenCalledWith({
        email: "ada@example.com",
        password: "a long password",
        display_name: "Ada Lovelace",
      });
      expect(api.createTenant).toHaveBeenCalledWith("Analytical Engines");
      expect(auth.signUp).not.toHaveBeenCalled();
    });

    it("goes back to the password with what was typed kept", async () => {
      await fillAccount();
      fireEvent.click(screen.getByRole("button", { name: "Back" }));
      expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("a long password");
      fireEvent.click(screen.getByRole("button", { name: "Change" }));
      expect((screen.getByLabelText("First name") as HTMLInputElement).value).toBe("Ada");
    });

    it("says the account exists when the workspace fails, and tries only the workspace again", async () => {
      api.signUp.mockResolvedValue({});
      api.createTenant.mockRejectedValueOnce(new Error("That name is taken")).mockResolvedValue({});
      auth.refresh.mockResolvedValue(undefined);
      await fillAccount();
      fireEvent.click(screen.getByRole("button", { name: "Create account" }));
      expect(
        await screen.findByText("Your account was created, but not your workspace: That name is taken"),
      ).toBeTruthy();
      expect(auth.refresh).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
      await waitFor(() => expect(auth.refresh).toHaveBeenCalled());
      expect(api.signUp).toHaveBeenCalledTimes(1);
      expect(api.createTenant).toHaveBeenCalledTimes(2);
    });
  });

  it("suggests a workspace name from the first name, or a plain one with none", () => {
    expect(suggestedWorkspaceName("  Raul Lopez ")).toBe("Raul's workspace");
    expect(suggestedWorkspaceName("")).toBe("My workspace");
  });
});
