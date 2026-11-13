import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrganizationGuardrails as Guardrails } from "../../../data/api";
import { answerFetch } from "../../../test/answerFetch";
import OrganizationGuardrails from "./OrganizationGuardrails";

const NONE: Guardrails = {
  connected: false,
  policy_id: null,
  policy_name: null,
  policy_url: null,
  api_key_last4: null,
  connected_by_name: null,
  connected_at: null,
};

const CONNECTED: Guardrails = {
  connected: true,
  policy_id: "pol_123",
  policy_name: "Baseline Monitoring (Alert)",
  policy_url: "https://app.switchagents.ai/settings/guardrail-policies/pol_123",
  api_key_last4: "6789",
  connected_by_name: "Olga",
  connected_at: "2026-11-12T10:00:00Z",
};

function renderIt() {
  render(<OrganizationGuardrails organizationName="Acme" heading="page" />);
}

describe("OrganizationGuardrails", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("says nothing is checked, and connects a policy once Switch Trust takes it", async () => {
    const calls = answerFetch({
      "GET /organizations/current/guardrails": [
        [200, NONE],
        [200, CONNECTED],
      ],
      "PUT /organizations/current/guardrails": [200, CONNECTED],
    });
    renderIt();

    expect(await screen.findByText("Nothing is checked until Switch Trust is connected.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Set up" }));
    const connect = screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText("Guardrail policy ID"), { target: { value: " pol_123 " } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "short" } });
    expect(connect.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "made-up-6789" } });
    fireEvent.click(connect);

    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
        policy_id: "pol_123",
        api_key: "made-up-6789",
      }),
    );
    expect(
      await screen.findByText(
        "Switch Trust checks every message in Acme against Baseline Monitoring (Alert).",
      ),
    ).toBeTruthy();
    expect(screen.getByText("pol_123")).toBeTruthy();
    expect(screen.getByText(/Connected by Olga/)).toBeTruthy();
  });

  it("shows Switch Trust's refusal and keeps the form", async () => {
    answerFetch({
      "GET /organizations/current/guardrails": [200, NONE],
      "PUT /organizations/current/guardrails": [
        400,
        { detail: "Switch Trust refused this policy ID and API key (HTTP 401)." },
      ],
    });
    renderIt();

    fireEvent.click(await screen.findByRole("button", { name: "Set up" }));
    fireEvent.change(screen.getByLabelText("Guardrail policy ID"), { target: { value: "pol_1" } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "wrong-key-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText(/refused this policy ID and API key/)).toBeTruthy();
    expect(screen.getByLabelText("Guardrail policy ID")).toBeTruthy();
  });

  it("disconnects once confirmed", async () => {
    const calls = answerFetch({
      "GET /organizations/current/guardrails": [
        [200, CONNECTED],
        [200, NONE],
      ],
      "DELETE /organizations/current/guardrails": [200, NONE],
    });
    renderIt();

    fireEvent.click(await screen.findByRole("button", { name: "Policy actions" }));
    fireEvent.click(within(screen.getByRole("menu")).getByText("Disconnect"));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(await screen.findByText(/Switch Trust is disconnected/)).toBeTruthy();
  });

  it("says when the kept key can no longer be read", async () => {
    answerFetch({ "GET /organizations/current/guardrails": [200, { ...CONNECTED, api_key_last4: null }] });
    renderIt();

    expect(await screen.findByText(/can't be read any more/)).toBeTruthy();
  });
});
