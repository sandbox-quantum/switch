import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionDetail } from "../../data/api";
import { SessionsSection } from "./AgentDetailPage";
import { sessionPlace, sessionRunner } from "./sessionLabels";

function session(overrides: Partial<AgentSessionDetail>): AgentSessionDetail {
  return {
    room_id: "room-1",
    room_name: "design",
    lifecycle: "connection",
    state: "live",
    last_seen_at: "2026-10-01T00:00:00Z",
    controller_id: null,
    ...overrides,
  };
}

describe("sessionRunner", () => {
  it("says a controller session is run by a machine, and names the controller", () => {
    expect(
      sessionRunner(session({ lifecycle: "controller", controller_id: "ctrl-1" })),
    ).toEqual({
      label: "Run by a machine",
      detail:
        "Run by agents controller ctrl-1 on the machine the agent is placed on, working in this room.",
    });
    expect(
      sessionRunner(
        session({ lifecycle: "controller", controller_id: "ctrl-1", room_id: null, room_name: null }),
      )?.detail,
    ).toBe(
      "Run by agents controller ctrl-1 on the machine the agent is placed on, running, with no session working in a room yet.",
    );
  });

  it("says nothing for a session the agent runs itself", () => {
    for (const lifecycle of ["connection", "heartbeat", "explicit"])
      expect(sessionRunner(session({ lifecycle }))).toBeNull();
  });
});

describe("sessionPlace", () => {
  it("names the room, or what no room means for the session", () => {
    expect(sessionPlace(session({}))).toBe("design");
    expect(sessionPlace(session({ room_name: null }))).toBe("room-1");
    expect(sessionPlace(session({ room_id: null, room_name: null }))).toBe("Room-agnostic");
    expect(
      sessionPlace(session({ lifecycle: "controller", room_id: null, room_name: null })),
    ).toBe("Not in a room yet");
  });
});

describe("SessionsSection", () => {
  afterEach(cleanup);

  function renderSessions(sessions: AgentSessionDetail[]) {
    render(
      <MemoryRouter initialEntries={["/agents/a1"]}>
        <Routes>
          <Route path="/agents/a1" element={<SessionsSection sessions={sessions} />} />
          <Route path="/machines" element={<p>Machines page</p>} />
          <Route path="/rooms/:id" element={<p>Room page</p>} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it("labels a controller session with its room, and links to the machines", () => {
    renderSessions([
      session({ lifecycle: "controller", controller_id: "ctrl-1" }),
      session({ lifecycle: "connection", room_id: "room-2", room_name: "triage" }),
    ]);

    expect(screen.getByText("design")).toBeTruthy();
    expect(screen.getByText("triage")).toBeTruthy();
    expect(screen.getAllByText("Run by a machine")).toHaveLength(1);
    expect(screen.queryByText("controller")).toBeNull();

    fireEvent.click(screen.getByText("Run by a machine"));
    expect(screen.getByText("Machines page")).toBeTruthy();
  });

  it("shows a live controller with no session in a room as such", () => {
    renderSessions([
      session({ lifecycle: "controller", controller_id: "ctrl-1", room_id: null, room_name: null }),
    ]);
    expect(screen.getByText("Not in a room yet")).toBeTruthy();
    expect(screen.getByText("Run by a machine")).toBeTruthy();
    expect(screen.queryByText("Room-agnostic")).toBeNull();
  });
});
