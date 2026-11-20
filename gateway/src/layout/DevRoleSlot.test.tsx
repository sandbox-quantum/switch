import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DevRoleCorner, DevRoleSlot } from "./DevRoleSlot";

vi.mock("../dev/DevRoleSwitcher", () => ({ default: () => <span>role switcher</span> }));

afterEach(cleanup);

describe("DevRoleSlot", () => {
  it("shows the switcher in a dev build", async () => {
    render(<DevRoleSlot />);
    expect(await screen.findByText("role switcher")).toBeTruthy();
  });

  it("shows it in the corner of the screens with no top bar", async () => {
    render(<DevRoleCorner />);
    expect(await screen.findByText("role switcher")).toBeTruthy();
  });
});
