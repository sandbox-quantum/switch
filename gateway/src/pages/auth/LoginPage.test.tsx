import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import LoginPage, { suggestedWorkspaceName } from "./LoginPage";

const api = vi.hoisted(() => ({ fetchAuthConfig: vi.fn(), signUp: vi.fn(), createTenant: vi.fn() }));
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

describe("LoginPage", () => {
  it("creates an account where the server offers sign-up on the web", async () => {
    api.fetchAuthConfig.mockResolvedValue(config(true));
    auth.signUp.mockResolvedValue(undefined);
    render(<LoginPage />);
    fireEvent.click(
      await screen.findByRole("button", { name: "New to Switch? Create an account" }),
    );
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Ada Lovelace" } });
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText(/Password/), { target: { value: "a long password" } });
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

  it("only signs in where it does not", async () => {
    api.fetchAuthConfig.mockResolvedValue(config(false));
    render(<LoginPage />);
    await waitFor(() => expect(api.fetchAuthConfig).toHaveBeenCalled());
    await screen.findByRole("button", { name: "Sign in" });
    expect(screen.queryByRole("button", { name: /Create an account/ })).toBeNull();
  });

  it("offers one button per sign-in option, each starting that option's sign-in", async () => {
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
    fireEvent.click(await screen.findByRole("button", { name: "Continue with GitHub" }));
    expect(location.href).toBe("/gateway/auth/oidc/login?provider=github");
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect(location.href).toBe("/gateway/auth/oidc/login?provider=google");
    expect(screen.queryByRole("button", { name: "Continue with Okta" })).toBeNull();
  });

  it("offers one button for the identity provider when the server lists no options", async () => {
    api.fetchAuthConfig.mockResolvedValue(
      config(false, { oidc_enabled: true, oidc_provider_label: "Okta" }),
    );
    const location = captureNavigation();
    render(<LoginPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue with Okta" }));
    expect(location.href).toBe("/gateway/auth/oidc/login");
    expect(screen.getAllByRole("button", { name: /^Continue with/ })).toHaveLength(1);
  });

  it("invites new people where signing in with SSO creates their account", async () => {
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
  });

  it("invites new people where they can create an account", async () => {
    api.fetchAuthConfig.mockResolvedValue(config(true));
    render(<LoginPage />);
    expect(await screen.findByText(/create an account if you're new to Switch/)).toBeTruthy();
  });

  describe("under open sign-up, where each new account makes its own workspace", () => {
    async function fillAccount() {
      api.fetchAuthConfig.mockResolvedValue(config(true, { signup_mode: "open" }));
      render(<LoginPage />);
      fireEvent.click(
        await screen.findByRole("button", { name: "New to Switch? Create an account" }),
      );
      fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Ada Lovelace" } });
      fireEvent.change(screen.getByLabelText(/Email/), { target: { value: "ada@example.com" } });
      fireEvent.change(screen.getByLabelText(/Password/), { target: { value: "a long password" } });
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      return (await screen.findByLabelText(/Workspace name/)) as HTMLInputElement;
    }

    it("asks for the workspace's name next, suggested from the person's", async () => {
      const field = await fillAccount();
      expect(field.value).toBe("Ada's workspace");
      expect(api.signUp).not.toHaveBeenCalled();
      expect(screen.getByText("Your account")).toBeTruthy();
      expect(screen.getByText("Your workspace")).toBeTruthy();
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

    it("goes back to the account with what was typed kept", async () => {
      await fillAccount();
      fireEvent.click(screen.getByRole("button", { name: "Back" }));
      expect((screen.getByLabelText("Your name") as HTMLInputElement).value).toBe("Ada Lovelace");
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
