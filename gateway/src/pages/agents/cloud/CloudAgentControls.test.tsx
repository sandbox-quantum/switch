import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as actions from "../../../data/cloudAgentActions";
import { CloudAgentSection, CloudRenameDialog } from "./CloudAgentControls";

vi.mock("../../../data/cloudAgentActions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../data/cloudAgentActions")>();
  return {
    ...actual,
    fetchCloudAgentRunning: vi.fn(),
    restartCloudAgent: vi.fn(),
    setCloudAgentRunning: vi.fn(),
    setCloudAgentDisplayName: vi.fn(),
  };
});

// The cloud delete is engineer-2's; here it only needs to open with the right agent and box.
vi.mock("./CloudDeleteDialog", () => ({
  default: ({ agent, controllerId }: { agent: { id: string; name: string } | null; controllerId: string }) =>
    agent ? <div role="dialog">{`delete ${agent.name} on ${controllerId}`}</div> : null,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const section = () =>
  render(
    <CloudAgentSection
      agent={{ id: "a", name: "Site builder" }}
      controllerId="c-box"
      onDeleted={vi.fn()}
    />,
  );

describe("CloudAgentSection", () => {
  it("offers Stop and Restart for a running agent", async () => {
    vi.mocked(actions.fetchCloudAgentRunning).mockResolvedValue(true);
    section();
    expect(await screen.findByText("Running")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(actions.setCloudAgentRunning).toHaveBeenCalledWith("a", false));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Restart" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(actions.restartCloudAgent).toHaveBeenCalledWith("a"));
  });

  it("offers Start for a stopped agent, with Restart off", async () => {
    vi.mocked(actions.fetchCloudAgentRunning).mockResolvedValue(false);
    section();
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    await waitFor(() => expect(actions.setCloudAgentRunning).toHaveBeenCalledWith("a", true));
    expect((screen.getByRole("button", { name: "Restart" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("shows a refusal in Core's words", async () => {
    vi.mocked(actions.fetchCloudAgentRunning).mockResolvedValue(true);
    vi.mocked(actions.setCloudAgentRunning).mockRejectedValue(new Error("Your cloud is resting."));
    section();
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    expect(await screen.findByText("Your cloud is resting.")).toBeTruthy();
  });

  it("deletes through the cloud delete, on the box's controller", async () => {
    vi.mocked(actions.fetchCloudAgentRunning).mockResolvedValue(true);
    section();
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(screen.getByRole("dialog").textContent).toBe("delete Site builder on c-box");
  });
});

describe("CloudRenameDialog", () => {
  it("keeps the name fixed and saves the display name", async () => {
    vi.mocked(actions.setCloudAgentDisplayName).mockResolvedValue();
    const onRenamed = vi.fn();
    render(
      <CloudRenameDialog
        open
        agentId="a1"
        name="site-builder"
        displayName="Site builder"
        onClose={vi.fn()}
        onRenamed={onRenamed}
      />,
    );
    expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Web builder" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(onRenamed).toHaveBeenCalledWith('Display name is now "Web builder".'));
    expect(actions.setCloudAgentDisplayName).toHaveBeenCalledWith("a1", "Web builder");
  });

  it("renders a display name as text, never markup", () => {
    const { container } = render(
      <CloudRenameDialog
        open
        agentId="a1"
        name="a"
        displayName="<img src=x onerror=alert(1)>"
        onClose={vi.fn()}
        onRenamed={vi.fn()}
      />,
    );
    expect(container.ownerDocument.querySelector("img")).toBeNull();
  });
});
