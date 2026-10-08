import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentDetail, OWNER_ONLY_POLICY, type ServiceGrants } from "../../data/api";
import ServiceAccessSection from "./ServiceAccessSection";

const agent: AgentDetail = {
  id: "a1",
  name: "helper",
  description: "Helps",
  connector_type: "claude_code",
  connection_model: "auto_session",
  tool_count: 0,
  model_count: 0,
  owner_id: "u1",
  owner_name: "ada",
  oauth_client_id: null,
  created_at: "2026-10-01T00:00:00Z",
  parent_agent_id: null,
  known_agent_type: "claude-code",
  known_agent_options: null,
  agent_type: "auto_session",
  integration_profile: {},
  tools: [],
  models: [],
  rooms: [],
  sessions: [],
  children: [],
  addressing_policy: null,
  can_manage_agents: false,
};

const GITHUB = {
  status: "connected",
  login: "ada-gh",
  install_url: "https://github.com/apps/example/installations/new",
  installations: [
    {
      id: 7,
      account: "example-org",
      repositories: [
        { id: 70, name: "project" },
        { id: 71, name: "docs" },
      ],
    },
  ],
};

type Call = { path: string; method: string; body: unknown };

function mockServer(grants: ServiceGrants | null) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status });
      if (path === "/gateway/agents/a1/service-grants")
        return grants ? json(grants) : json({ detail: "Agent not found." }, 404);
      if (path === "/gateway/provider-connections/github") return json(GITHUB);
      if (path === "/gateway/agents/a1/service-grants/github" && method === "PUT")
        return json({ grant: {}, warning: null });
      if (path === "/gateway/agents/a1/service-grants/github" && method === "DELETE")
        return json({ warning: null });
      if (path === "/gateway/agents/a1/addressing-policy") return json(agent);
      return json({ detail: "Not Found" }, 404);
    }),
  );
  return calls;
}

const GRANTED: ServiceGrants = {
  grants: [
    {
      service: "github",
      name: "GitHub",
      access: "write",
      tool_mode: "deny",
      tools: [],
      effective_tools: [],
      resources: { installation_id: 7, repository_ids: [70] },
      summary: "helper can read and push to 1 repository, acting as the GitHub App.",
    },
  ],
  missing: [],
  addressing_open: true,
};

describe("ServiceAccessSection", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows each grant with its repositories, and offers owner-only when anyone can address the agent", async () => {
    const calls = mockServer(GRANTED);
    const updated = vi.fn();
    render(<ServiceAccessSection agent={agent} onAgentUpdated={updated} />);
    expect(await screen.findByText(GRANTED.grants[0]!.summary)).toBeTruthy();
    expect(await screen.findByText("example-org/project")).toBeTruthy();
    expect(screen.getByText(/show as the Switch GitHub App/)).toBeTruthy();
    expect(screen.getByText(/Not available on Windows yet/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Make owner-only" }));
    await waitFor(() => expect(updated).toHaveBeenCalled());
    expect(calls).toContainEqual({
      path: "/gateway/agents/a1/addressing-policy",
      method: "PUT",
      body: { policy: OWNER_ONLY_POLICY },
    });
  });

  it("says what removing a grant does, and does not, on the agent's own machine", async () => {
    const calls = mockServer(GRANTED);
    render(<ServiceAccessSection agent={agent} onAgentUpdated={vi.fn()} />);
    const remove = await screen.findByRole("button", { name: "Remove" });
    expect(remove.getAttribute("title")).toMatch(/may still use the machine's own sign-in/);

    fireEvent.click(remove);
    expect(await screen.findByText(/Removing a grant stops Switch giving this access/)).toBeTruthy();
    expect(calls).toContainEqual({
      path: "/gateway/agents/a1/service-grants/github",
      method: "DELETE",
      body: null,
    });
  });

  it("restores a cloud agent's missing repository grant in one click", async () => {
    const calls = mockServer({
      grants: [],
      missing: [
        {
          service: "github",
          reason: "This cloud agent works in example-org/project, but has no GitHub grant.",
          access: "write",
          resources: { installation_id: 7, repository_ids: [70] },
        },
      ],
      addressing_open: false,
    });
    render(<ServiceAccessSection agent={agent} onAgentUpdated={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Grant it" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "/gateway/agents/a1/service-grants/github",
        method: "PUT",
        body: { access: "write", resources: { installation_id: 7, repository_ids: [70] } },
      }),
    );
  });

  it("grants GitHub on the repositories picked, for reading unless asked", async () => {
    const calls = mockServer({ grants: [], missing: [], addressing_open: false });
    render(<ServiceAccessSection agent={agent} onAgentUpdated={vi.fn()} />);
    const account = await screen.findByLabelText("GitHub account");
    fireEvent.mouseDown(account);
    fireEvent.click(await screen.findByText("example-org"));
    fireEvent.mouseDown(screen.getByLabelText("Repositories"));
    fireEvent.click(await screen.findByText("docs"));
    fireEvent.click(screen.getByRole("button", { name: "Grant" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "/gateway/agents/a1/service-grants/github",
        method: "PUT",
        body: { access: "read", resources: { installation_id: 7, repository_ids: [71] } },
      }),
    );
  });

  it("shows nothing to someone who does not own the agent", async () => {
    mockServer(null);
    const { container } = render(
      <ServiceAccessSection agent={agent} onAgentUpdated={vi.fn()} />,
    );
    await waitFor(() => expect(container.textContent).toBe(""));
  });
});
