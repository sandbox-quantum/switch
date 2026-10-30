import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routeFetch } from "../../test/routeFetch";
import ServicesSection from "./ServicesSection";

function service(slug: string, name: string, patch: Record<string, unknown> = {}) {
  return {
    slug,
    name,
    enabled: true,
    updated_by_name: null,
    updated_at: null,
    connected_members: 0,
    granted_agents: 0,
    ...patch,
  };
}

const USED = service("github", "GitHub", { connected_members: 2, granted_agents: 1 });
const UNUSED = service("airtable", "Airtable", { enabled: false });

const FLAGS_ON = { body: { flags: [{ key: "service_connections", enabled: true }] } };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function toggle(name: string) {
  fireEvent.click(screen.getByRole("switch", { name: `${name} for this workspace` }));
}

describe("ServicesSection", () => {
  it("lists each service with who it reaches and who last switched it", async () => {
    routeFetch({
      "GET /feature-flags": FLAGS_ON,
      "GET /workspace/services": {
        body: {
          services: [
            USED,
            service("airtable", "Airtable", {
              enabled: false,
              updated_by_name: "Ada",
              updated_at: "2026-10-01T12:00:00Z",
            }),
          ],
        },
      },
    });
    render(<ServicesSection />);

    expect(await screen.findByText(/2 members connected · 1 agent uses it/)).toBeTruthy();
    expect(screen.getByText(/Switched off by Ada/)).toBeTruthy();
    expect(screen.getByText(/On by default\./)).toBeTruthy();
  });

  it("switches an unused service without asking", async () => {
    const calls = routeFetch({
      "GET /feature-flags": FLAGS_ON,
      "GET /workspace/services": [
        { body: { services: [UNUSED] } },
        { body: { services: [{ ...UNUSED, enabled: true }] } },
      ],
      "PUT /workspace/services/airtable": { body: { slug: "airtable", enabled: true, warning: null } },
    });
    render(<ServicesSection />);
    await screen.findByText("Airtable");

    toggle("Airtable");

    await screen.findByRole("switch", { name: "Airtable for this workspace", checked: true });
    expect(calls.find((c) => c.route === "PUT /workspace/services/airtable")?.body).toEqual({
      enabled: true,
    });
  });

  it("asks before switching off a service people use, then shows the server's warning", async () => {
    const calls = routeFetch({
      "GET /feature-flags": FLAGS_ON,
      "GET /workspace/services": [
        { body: { services: [USED] } },
        { body: { services: [{ ...USED, enabled: false }] } },
      ],
      "PUT /workspace/services/github": {
        body: { slug: "github", enabled: false, warning: "One token could not be revoked yet." },
      },
    });
    render(<ServicesSection />);
    await screen.findByText("GitHub");

    toggle("GitHub");
    expect(await screen.findByText("Switch GitHub off for this workspace?")).toBeTruthy();
    expect(calls.some((c) => c.route.startsWith("PUT"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Switch off" }));

    expect(await screen.findByText("One token could not be revoked yet.")).toBeTruthy();
    expect(calls.find((c) => c.route === "PUT /workspace/services/github")?.body).toEqual({
      enabled: false,
    });
  });

  it("leaves the switch as it was, with the reason, when the server refuses", async () => {
    routeFetch({
      "GET /feature-flags": FLAGS_ON,
      "GET /workspace/services": { body: { services: [UNUSED] } },
      "PUT /workspace/services/airtable": { status: 403, body: { detail: "Workspace admin access required" } },
    });
    render(<ServicesSection />);
    await screen.findByText("Airtable");

    toggle("Airtable");

    expect(await screen.findByText("Workspace admin access required")).toBeTruthy();
    expect(
      screen.getByRole("switch", { name: "Airtable for this workspace", checked: false }),
    ).toBeTruthy();
  });

  it("is left out, without asking for the services, on a server without service connections", async () => {
    const calls = routeFetch({
      "GET /feature-flags": { body: { flags: [{ key: "service_connections", enabled: false }] } },
    });
    const { container } = render(<ServicesSection />);

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await vi.waitFor(() => expect(container.textContent).toBe(""));
    expect(calls.map((c) => c.route)).toEqual(["GET /feature-flags"]);
  });
});
