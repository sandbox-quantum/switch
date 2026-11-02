import { render } from "@testing-library/react";
import type { ComponentType } from "react";
import { MemoryRouter } from "react-router";
import { vi } from "vitest";
import { HostedContext, type HostedState } from "../HostedContext";

export const MARKER = "zz-marker-w5-71c4";
export const VIEWER = { id: "op-me", name: "Jo Operator" };

/** Answers every fetch with one status and body, and records the calls. */
export function answer(status: number, body: unknown = {}) {
  const fetchMock = vi.fn(
    async (_path: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Answers each fetch in turn from the list. */
export function answers(...replies: { status: number; body: unknown }[]) {
  const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => {
    const next = replies.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Renders a tab inside the shell's context, as shell v1.1 provides it. */
export function renderTab(Tab: ComponentType, state: Partial<HostedState> = {}) {
  const value: HostedState = {
    operator: VIEWER,
    overview: null,
    overviewStale: false,
    refreshKey: 0,
    refresh: async () => undefined,
    ...state,
  };
  const ui = (v: HostedState) => (
    <MemoryRouter>
      <HostedContext.Provider value={v}>
        <Tab />
      </HostedContext.Provider>
    </MemoryRouter>
  );
  const result = render(ui(value));
  return {
    ...result,
    /** Re-renders with a new context, as the shell does after `refresh()`. */
    update: (next: Partial<HostedState>) => result.rerender(ui({ ...value, ...next })),
  };
}
