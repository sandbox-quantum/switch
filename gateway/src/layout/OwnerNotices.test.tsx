import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dismissOwnerNotice, fetchOwnerNotices, OwnerNoticesUnsupported } from "../data/ownerNotices";
import OwnerNotices from "./OwnerNotices";

vi.mock("../data/ownerNotices", () => ({
  dismissOwnerNotice: vi.fn(),
  fetchOwnerNotices: vi.fn(),
  OwnerNoticesUnsupported: class OwnerNoticesUnsupported extends Error {},
}));

const notice = {
  id: "notice-1",
  owner_id: "user-1",
  tenant_id: "tenant-1",
  kind: "unverified_agent_invite" as const,
  agent_name: "Helper",
  room_name: "Operations",
  created_at: "2026-11-08T00:00:00Z",
};

beforeEach(() => {
  vi.mocked(fetchOwnerNotices).mockResolvedValue([notice]);
  vi.mocked(dismissOwnerNotice).mockResolvedValue();
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("shows an owner notice and removes it only after successful dismissal", async () => {
  render(<OwnerNotices ownerId="user-1" tenantId="tenant-1" />);
  expect(await screen.findByText(/Helper was added to Operations/)).toBeTruthy();
  vi.mocked(fetchOwnerNotices).mockResolvedValue([]);
  fireEvent.click(screen.getByRole("button", { name: /Dismiss notice for Helper/ }));
  await waitFor(() => expect(screen.queryByText(/Helper was added/)).toBeNull());
  expect(dismissOwnerNotice).toHaveBeenCalledWith("notice-1");
});

it("keeps a notice visible when dismissal fails", async () => {
  vi.mocked(dismissOwnerNotice).mockRejectedValue(new Error("offline"));
  render(<OwnerNotices ownerId="user-1" tenantId="tenant-1" />);
  await screen.findByText(/Helper was added/);
  fireEvent.click(screen.getByRole("button", { name: /Dismiss notice for Helper/ }));
  expect(await screen.findByText(/Could not dismiss the notice/)).toBeTruthy();
  expect(screen.getByText(/Helper was added/)).toBeTruthy();
});

it("reports a loading failure instead of silently hiding notices", async () => {
  vi.mocked(fetchOwnerNotices).mockRejectedValue(new Error("offline"));
  render(<OwnerNotices ownerId="user-1" tenantId="tenant-1" />);
  expect(await screen.findByText(/Could not load owner notices/)).toBeTruthy();
});

it("does not show a response for another owner or workspace", async () => {
  vi.mocked(fetchOwnerNotices).mockResolvedValue([{ ...notice, tenant_id: "another-tenant" }]);
  render(<OwnerNotices ownerId="user-1" tenantId="tenant-1" />);
  expect(await screen.findByText(/signed-in account or workspace changed/)).toBeTruthy();
  expect(screen.queryByText(/Helper was added/)).toBeNull();
});

it("explains when an older server cannot provide owner notices", async () => {
  vi.mocked(fetchOwnerNotices).mockRejectedValue(new OwnerNoticesUnsupported());
  render(<OwnerNotices ownerId="user-1" tenantId="tenant-1" />);
  expect(await screen.findByText(/Update it to receive them/)).toBeTruthy();
});
