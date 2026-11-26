import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SetupGate from "./SetupGate";

const api = vi.hoisted(() => ({
  fetchTeamSurvey: vi.fn(),
  answerTeamSurvey: vi.fn(),
  fetchLicenseAcceptance: vi.fn(),
  fetchLicense: vi.fn(),
  acceptLicense: vi.fn(),
}));
vi.mock("../../data/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../data/api")>()),
  ...api,
}));

const auth = vi.hoisted(() => ({
  capabilities: { features: { gateway_onboarding: true } as Record<string, boolean> },
  user: { email: "ada@example.com" },
  logout: vi.fn(),
  linkNotice: null,
  dismissLinkNotice: vi.fn(),
}));
vi.mock("../../data/AuthContext", () => ({ useAuth: () => auth }));

const choices = {
  company_size: ["1-10", "11-50", "51-200", "201-1,000", "1,000+"],
  role: ["AI / ML Engineer", "Platform / DevOps", "Other"],
  agent_count: ["1-5", "6-20", "100+"],
  use_cases: ["Coding agents for my team", "Agents in Slack or Teams", "Internal tools"],
};
const answers = {
  company_size: "51-200",
  role: "AI / ML Engineer",
  agent_count: "6-20",
  use_cases: ["Agents in Slack or Teams", "Internal tools"],
};

function server({ answered, accepted }: { answered: boolean; accepted: string | null }) {
  api.fetchTeamSurvey.mockResolvedValue({ choices, answers: answered ? answers : null, answered_at: null });
  api.answerTeamSurvey.mockImplementation(async (given) => ({ choices, answers: given, answered_at: "now" }));
  api.fetchLicenseAcceptance.mockResolvedValue({ version: "v2", accepted_version: accepted, accepted_at: null });
  api.fetchLicense.mockResolvedValue({ version: "v2", text: "Software: Agent Switch\nThe terms." });
  api.acceptLicense.mockImplementation(async (version) => ({
    version: "v2",
    accepted_version: version,
    accepted_at: "now",
  }));
}

function renderGate() {
  return render(
    <SetupGate>
      <p>The dashboard</p>
    </SetupGate>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  auth.capabilities.features.gateway_onboarding = true;
});

describe("SetupGate", () => {
  it("shows the dashboard as it is, asking nothing, where the dashboard does not onboard people", () => {
    auth.capabilities.features.gateway_onboarding = false;
    server({ answered: false, accepted: null });
    renderGate();
    expect(screen.getByText("The dashboard")).toBeTruthy();
    expect(api.fetchTeamSurvey).not.toHaveBeenCalled();
    expect(api.fetchLicenseAcceptance).not.toHaveBeenCalled();
  });

  it("shows the dashboard to someone who answered and accepted the current license", async () => {
    server({ answered: true, accepted: "v2" });
    renderGate();
    expect(await screen.findByText("The dashboard")).toBeTruthy();
  });

  it("asks about the team, then for the license, as steps of signing up", async () => {
    server({ answered: false, accepted: null });
    renderGate();
    expect(await screen.findByRole("heading", { name: "Tell us about your team" })).toBeTruthy();
    expect(screen.getByText("Team").closest("li")?.getAttribute("aria-current")).toBe("step");
    const submit = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    const pick = (group: string, choice: string) =>
      fireEvent.click(within(screen.getByRole("radiogroup", { name: group })).getByRole("radio", { name: choice }));
    pick("Company size", "1-10");
    pick("Company size", "51-200");
    pick("Your role", "AI / ML Engineer");
    pick("Number of AI agents", "6-20");
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Coding agents for my team" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Agents in Slack or Teams" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Internal tools" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Coding agents for my team" }));
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(api.answerTeamSurvey).toHaveBeenCalledWith(answers));

    expect(await screen.findByRole("heading", { name: "Review the license" })).toBeTruthy();
    expect(screen.getByText("License").closest("li")?.getAttribute("aria-current")).toBe("step");
    expect(await screen.findByText(/The terms\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "I have reviewed and accept the license" }));
    await waitFor(() => expect(api.acceptLicense).toHaveBeenCalledWith("v2"));
    expect(await screen.findByText("The dashboard")).toBeTruthy();
  });

  it("asks someone who accepted an older license to accept the new one, and nothing else", async () => {
    server({ answered: true, accepted: "v1" });
    renderGate();
    expect(await screen.findByText(/The license Switch is offered under has changed/)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Sign-up steps" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "I have reviewed and accept the license" }));
    expect(await screen.findByText("The dashboard")).toBeTruthy();
    expect(api.answerTeamSurvey).not.toHaveBeenCalled();
  });

  it("says so when the answers cannot be saved, and stays on the questions", async () => {
    server({ answered: false, accepted: "v2" });
    api.answerTeamSurvey.mockRejectedValue(new Error("company_size: must be one of: 1-10"));
    renderGate();
    await screen.findByRole("heading", { name: "Tell us about your team" });
    for (const [group, choice] of [
      ["Company size", "1-10"],
      ["Your role", "Other"],
      ["Number of AI agents", "1-5"],
    ])
      fireEvent.click(within(screen.getByRole("radiogroup", { name: group })).getByRole("radio", { name: choice }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Internal tools" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByText("Couldn't save your answers: company_size: must be one of: 1-10"),
    ).toBeTruthy();
    expect(screen.queryByText("The dashboard")).toBeNull();
  });

  it("says so when it cannot tell whether the account is set up, and tries again", async () => {
    server({ answered: true, accepted: "v2" });
    api.fetchLicenseAcceptance.mockRejectedValueOnce(new Error("database unavailable"));
    renderGate();
    expect(await screen.findByText("database unavailable")).toBeTruthy();
    expect(screen.queryByText("The dashboard")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("The dashboard")).toBeTruthy();
  });
});
