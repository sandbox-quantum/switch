import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import WebChatHost from "./WebChatHost";
import { useChatHost } from "@switch-console/chat-ui/host";
import { useAuth } from "../../data/AuthContext";
import { useState } from "react";

vi.mock("../../data/AuthContext");
vi.mock("./webChatClient", () => ({
  webChatsClient: {},
  webFailures: {},
  warn: vi.fn(),
  callGateway: vi.fn(),
  ChatRequestError: class extends Error {},
}));
vi.mock("@switch-console/chat-ui/model/failures", () => ({
  configureFailures: vi.fn(),
}));
vi.mock("../../data/api", () => ({
  fetchAvatarSettings: vi.fn().mockResolvedValue({ third_party_avatars_enabled: true }),
  fetchBridgeTypes: vi.fn().mockResolvedValue([]),
}));

function TestComponent({ onHost, onLocation }: { onHost: (host: any) => void; onLocation: (location: string) => void }) {
  const host = useChatHost();
  const location = useLocation();
  const [initialized, setInitialized] = useState(false);

  if (!initialized && host) {
    onHost(host);
    setInitialized(true);
  }

  onLocation(location.pathname + location.search);
  return null;
}

describe("WebChatHost chat removal", () => {
  const mockAuth = {
    user: { id: "test-user", name: "Test User" },
    session: { tenant: { id: "test-tenant" } },
    capabilities: { features: [] },
  };

  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue(mockAuth as any);
  });

  it("isOpenChat returns true when chat param matches roomId", async () => {
    let capturedHost: any;

    render(
      <MemoryRouter initialEntries={["/chats/agents/agent-1?chat=test-room"]}>
        <WebChatHost>
          <Routes>
            <Route path="*" element={<TestComponent onHost={(h) => (capturedHost = h)} onLocation={() => {}} />} />
          </Routes>
        </WebChatHost>
      </MemoryRouter>,
    );

    await waitFor(() => expect(capturedHost).toBeDefined());
    expect(capturedHost.isOpenChat("test-room")).toBe(true);
    expect(capturedHost.isOpenChat("other-room")).toBe(false);
  });

  it("isOpenChat returns true when room param matches roomId", async () => {
    let capturedHost: any;

    render(
      <MemoryRouter initialEntries={["/chats/agents/agent-1?room=test-room"]}>
        <WebChatHost>
          <Routes>
            <Route path="*" element={<TestComponent onHost={(h) => (capturedHost = h)} onLocation={() => {}} />} />
          </Routes>
        </WebChatHost>
      </MemoryRouter>,
    );

    await waitFor(() => expect(capturedHost).toBeDefined());
    expect(capturedHost.isOpenChat("test-room")).toBe(true);
  });

  it("leaveOpenChat navigates to agent page when chat param matches", async () => {
    let capturedHost: any;
    let currentLocation = "";

    render(
      <MemoryRouter initialEntries={["/chats/agents/agent-1?chat=test-room"]}>
        <WebChatHost>
          <Routes>
            <Route path="*" element={<TestComponent onHost={(h) => (capturedHost = h)} onLocation={(l) => (currentLocation = l)} />} />
          </Routes>
        </WebChatHost>
      </MemoryRouter>,
    );

    await waitFor(() => expect(capturedHost).toBeDefined());
    expect(currentLocation).toBe("/chats/agents/agent-1?chat=test-room");

    capturedHost.leaveOpenChat("test-room");

    await waitFor(() => {
      expect(currentLocation).toBe("/chats/agents/agent-1");
    });
  });

  it("leaveOpenChat does not navigate when roomId does not match", async () => {
    let capturedHost: any;
    let currentLocation = "";

    render(
      <MemoryRouter initialEntries={["/chats/agents/agent-1?chat=test-room"]}>
        <WebChatHost>
          <Routes>
            <Route path="*" element={<TestComponent onHost={(h) => (capturedHost = h)} onLocation={(l) => (currentLocation = l)} />} />
          </Routes>
        </WebChatHost>
      </MemoryRouter>,
    );

    await waitFor(() => expect(capturedHost).toBeDefined());
    const initialLocation = currentLocation;

    capturedHost.leaveOpenChat("other-room");

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(currentLocation).toBe(initialLocation);
  });

  it("leaveOpenChat navigates to /chats when in /chats/rooms/<roomId>", async () => {
    let capturedHost: any;
    let currentLocation = "";

    render(
      <MemoryRouter initialEntries={["/chats/rooms/test-room"]}>
        <WebChatHost>
          <Routes>
            <Route path="*" element={<TestComponent onHost={(h) => (capturedHost = h)} onLocation={(l) => (currentLocation = l)} />} />
          </Routes>
        </WebChatHost>
      </MemoryRouter>,
    );

    await waitFor(() => expect(capturedHost).toBeDefined());
    expect(currentLocation).toBe("/chats/rooms/test-room");

    capturedHost.leaveOpenChat("test-room");

    await waitFor(() => {
      expect(currentLocation).toBe("/chats");
    });
  });
});
