import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routeFetch } from "../../test/routeFetch";
import GuardrailsPage from "./GuardrailsPage";

const SET = {
  endpoint: "https://trust.example.com",
  policy_id: "policy-1",
  has_api_key: true,
  api_key_last4: "abcd",
  enabled: true,
};
const UNSET = {
  endpoint: "https://trust.example.com",
  policy_id: null,
  has_api_key: false,
  api_key_last4: null,
  enabled: false,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("GuardrailsPage", () => {
  it("keeps the stored key when saved with the key field blank", async () => {
    const calls = routeFetch({
      "GET /trust-settings": { body: SET },
      "PUT /trust-settings": (sent) => ({ body: { ...SET, ...(sent as object) } }),
    });
    render(<GuardrailsPage />);

    expect(await screen.findByText("A key ending abcd is set.")).toBeTruthy();
    expect(screen.getByText("Checking messages")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Guardrails policy ID"), {
      target: { value: "policy-2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByDisplayValue("policy-2");
    expect(calls.find((c) => c.route === "PUT /trust-settings")?.body).toEqual({
      endpoint: "https://trust.example.com",
      policy_id: "policy-2",
    });
  });

  it("sends a new key when one is typed", async () => {
    const calls = routeFetch({
      "GET /trust-settings": { body: UNSET },
      "PUT /trust-settings": { body: { ...SET, api_key_last4: "wxyz" } },
    });
    render(<GuardrailsPage />);

    fireEvent.change(await screen.findByLabelText("API key"), { target: { value: "sk-wxyz" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("A key ending wxyz is set.")).toBeTruthy();
    expect(calls.find((c) => c.route === "PUT /trust-settings")?.body).toEqual({
      endpoint: "https://trust.example.com",
      policy_id: null,
      api_key: "sk-wxyz",
    });
  });

  it("says when a stored key can no longer be read", async () => {
    routeFetch({ "GET /trust-settings": { body: { ...SET, api_key_last4: null } } });
    render(<GuardrailsPage />);

    expect(await screen.findByText(/can no longer be read/)).toBeTruthy();
  });

  it("turns the guardrails off after asking", async () => {
    const calls = routeFetch({
      "GET /trust-settings": { body: SET },
      "DELETE /trust-settings": { body: UNSET },
    });
    render(<GuardrailsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));
    expect(screen.getByText(/Messages stop being checked/)).toBeTruthy();
    const confirm = screen.getAllByRole("button", { name: "Turn off" }).at(-1)!;
    fireEvent.click(confirm);

    expect(await screen.findByText("Not checking messages")).toBeTruthy();
    expect(calls.some((c) => c.route === "DELETE /trust-settings")).toBe(true);
  });

  it("says the page is the platform operator's to anyone else", async () => {
    routeFetch({ "GET /trust-settings": { status: 403, body: { detail: "Admin access required" } } });
    render(<GuardrailsPage />);

    expect(
      await screen.findByText(
        "Only the platform operator can view or change the guardrails settings.",
      ),
    ).toBeTruthy();
  });
});
