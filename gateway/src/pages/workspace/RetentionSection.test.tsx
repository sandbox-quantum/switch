import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RetentionSection, { describeRetention } from "./RetentionSection";

type Call = { url: string; method: string; body: unknown };

function serve(initialDays: number | null, toDelete = 0) {
  let days = initialDays;
  const calls: Call[] = [];
  const policy = () => ({
    message_retention_days: days,
    updated_at: null,
    updated_by_user_id: null,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (url.includes("/retention/preview")) {
        const asked = Number(new URL(url, "http://x").searchParams.get("days"));
        return new Response(
          JSON.stringify({ message_retention_days: asked, messages_to_delete: toDelete }),
        );
      }
      if (method === "PUT") days = (body as { message_retention_days: number }).message_retention_days;
      if (method === "DELETE") days = null;
      return new Response(JSON.stringify(policy()));
    }),
  );
  return calls;
}

describe("describeRetention", () => {
  it("says what the policy does in plain words", () => {
    expect(describeRetention(null)).toBe("Messages are kept forever.");
    expect(describeRetention(1)).toBe("Messages older than 1 day are deleted.");
    expect(describeRetention(90)).toBe("Messages older than 90 days are deleted.");
  });
});

describe("RetentionSection", () => {
  it("shows no setting at all when the policy cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ detail: "boom" }), { status: 500 })),
    );
    render(<RetentionSection tenantId="t1" />);

    await screen.findByText("boom");
    expect(screen.queryByText(/kept forever/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("asks for confirmation with the number of messages before turning retention on", async () => {
    const calls = serve(null, 1234);
    render(<RetentionSection tenantId="t1" />);
    await screen.findByText(/Messages are kept forever/);

    fireEvent.click(screen.getByLabelText("Delete messages older than"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/1,234 messages/)).toBeTruthy();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);

    fireEvent.click(within(dialog).getByRole("button", { name: "Turn on retention" }));
    await screen.findByText(/Messages older than 90 days are deleted/);
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ message_retention_days: 90 });
  });

  it("goes back to keeping forever without a confirmation", async () => {
    const calls = serve(30);
    render(<RetentionSection tenantId="t1" />);
    await screen.findByText(/Messages older than 30 days are deleted/);

    fireEvent.click(screen.getByLabelText("Keep forever"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText(/Messages are kept forever/);
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not save a custom window out of range", async () => {
    serve(45);
    render(<RetentionSection tenantId="t1" />);
    await screen.findByText(/Messages older than 45 days are deleted/);

    const days = screen.getByLabelText("Days");
    expect((days as HTMLInputElement).value).toBe("45");
    fireEvent.change(days, { target: { value: "5000" } });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true),
    );
  });
});
