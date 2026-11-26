import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TemplateRunDialog from "./TemplateRunDialog";
import * as api from "../../data/api";
import * as gatewayFetch from "../../data/gatewayFetch";

vi.mock("../../data/api");
vi.mock("../../data/gatewayFetch");

describe("TemplateRunDialog", () => {
  beforeEach(() => {
    vi.mocked(api.fetchTemplateContent).mockResolvedValue("template: content");
    vi.mocked(gatewayFetch.gatewayFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          created_agents: [{ slot: "agent", agent_id: "a1", name: "test-agent", machine: { id: "m1", name: "machine" }, listening: true }],
          room: null,
        }),
        { status: 200 }
      )
    );
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders dialog with template name", async () => {
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <TemplateRunDialog templateId="t1" templateName="Test Template" onClose={onClose} />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText("Use Test Template")).toBeTruthy();
    });
  });

  it("shows development notice", async () => {
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <TemplateRunDialog templateId="t1" templateName="Test Template" onClose={onClose} />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/Template running from the web is in early development/)).toBeTruthy();
    });
  });

  it("parses and shows template params as input fields", async () => {
    vi.mocked(api.fetchTemplateContent).mockResolvedValue(`params:
  product:
    required: true
    type: string
  priority:
    required: false
    type: string
room:
  name: test`);

    render(
      <MemoryRouter>
        <TemplateRunDialog templateId="t1" templateName="Test" onClose={vi.fn()} />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByLabelText(/product/)).toBeTruthy();
      expect(screen.getByLabelText(/priority/)).toBeTruthy();
    });
  });

  it("validates required params before running", async () => {
    vi.mocked(api.fetchTemplateContent).mockResolvedValue(`params:
  product:
    required: true
    type: string`);

    render(
      <MemoryRouter>
        <TemplateRunDialog templateId="t1" templateName="Test" onClose={vi.fn()} />
      </MemoryRouter>
    );

    await waitFor(() => screen.getByRole("button", { name: "Run template" }));
    fireEvent.click(screen.getByRole("button", { name: "Run template" }));

    await waitFor(() => {
      expect(screen.getByText(/product is required/)).toBeTruthy();
    });
    expect(vi.mocked(gatewayFetch.gatewayFetch)).not.toHaveBeenCalled();
  });

  it("runs template with filled params", async () => {
    vi.mocked(api.fetchTemplateContent).mockResolvedValue(`params:
  product:
    required: true
    type: string`);

    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <TemplateRunDialog templateId="t1" templateName="Test" onClose={onClose} />
      </MemoryRouter>
    );

    await waitFor(() => screen.getByLabelText(/product/));
    fireEvent.change(screen.getByLabelText(/product/), { target: { value: "MyProduct" } });
    fireEvent.click(screen.getByRole("button", { name: "Run template" }));

    await waitFor(() => {
      expect(vi.mocked(gatewayFetch.gatewayFetch)).toHaveBeenCalledWith(
        "/gateway/rooms/from-template-document",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"product":"MyProduct"'),
        })
      );
    });
  });

  it("shows server error detail for 400 responses", async () => {
    vi.mocked(gatewayFetch.gatewayFetch).mockResolvedValue(
      new Response(
        JSON.stringify({ detail: "Missing required param(s): machine, provider" }),
        { status: 400 }
      )
    );

    render(
      <MemoryRouter>
        <TemplateRunDialog templateId="t1" templateName="Test" onClose={vi.fn()} />
      </MemoryRouter>
    );

    await waitFor(() => screen.getByRole("button", { name: "Run template" }));
    fireEvent.click(screen.getByRole("button", { name: "Run template" }));

    await waitFor(() => {
      expect(screen.getByText(/Missing required param/)).toBeTruthy();
    });
  });
});
