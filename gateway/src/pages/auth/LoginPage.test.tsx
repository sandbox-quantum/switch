import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import LoginPage from "./LoginPage";

const api = vi.hoisted(() => ({
  fetchAuthConfig: vi.fn(),
  oidcLoginUrl: () => "/gateway/auth/oidc/login",
}));
vi.mock("../../data/api", () => api);

const auth = vi.hoisted(() => ({ login: vi.fn(), signUp: vi.fn() }));
vi.mock("../../data/AuthContext", () => ({ useAuth: () => auth }));

function config(webSignup: boolean) {
  return {
    password_login_enabled: true,
    web_signup_enabled: webSignup,
    oidc_enabled: false,
    oidc_provider_label: null,
    signup_mode: "default_tenant",
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

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
});
