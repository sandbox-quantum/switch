import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "../data/AuthContext";
import { ALL_OFF, GATEWAY_V2 } from "../data/featureFlags";
import { DevRoleCorner, DevRoleSlot } from "./DevRoleSlot";

vi.mock("../data/AuthContext", () => ({ useAuth: vi.fn() }));
vi.mock("../dev/DevRoleSwitcher", () => ({ default: () => <span>role switcher</span> }));

function withNewLayout(on: boolean) {
  vi.mocked(useAuth).mockReturnValue({
    capabilities: { features: { ...ALL_OFF, [GATEWAY_V2]: on } },
  } as unknown as ReturnType<typeof useAuth>);
}

afterEach(cleanup);

describe("DevRoleSlot", () => {
  it("shows the switcher when the server runs the new layout", async () => {
    withNewLayout(true);
    render(<DevRoleSlot />);
    expect(await screen.findByText("role switcher")).toBeTruthy();
  });

  it("shows nothing without it, including signed out, where every flag reads off", async () => {
    withNewLayout(false);
    const { container } = render(
      <>
        <DevRoleSlot />
        <DevRoleCorner />
      </>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.innerHTML).toBe("");
  });
});
