import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import BrowserHandoffPage, { codeFromHash, pageToOpen } from "./BrowserHandoffPage";

const CODE = "c0de-c0de-c0de-c0de-c0de-c0de-c0de-c0de-c0d";
const ADA = { name: "Ada", email: "ada@example.com" };
const BOB = { name: "Bob", email: "bob@example.com" };

type Answer = [status: number, body: unknown];

interface Request {
  url: string;
  method: string;
  body: unknown;
  // The address bar when the request went out.
  address: string;
}

const realLocation = window.location;
const replace = vi.fn();

/** Answers each `/gateway` path from `routes`, keeping every request whole:
 * the full URL it went to, and where the address bar was at the time. */
function answer(routes: Record<string, Answer>): Request[] {
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
        address: realLocation.href,
      });
      const [status, body] = routes[url.replace(/^\/gateway/, "")] ?? [404, { detail: "unmocked" }];
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return requests;
}

function peeked(signedInAs: typeof ADA | null, samePerson = false): Answer {
  return [
    200,
    { ...ADA, workspace_name: "Acme", signed_in_as: signedInAs, same_person: samePerson },
  ];
}

const REDEEMED: Answer = [200, { next: "/rooms/r1?workspace=acme#docs" }];
const EXPIRED: Answer = [
  410,
  {
    detail:
      "This sign-in link has expired or was already used. Open the page again from Switch Console.",
  },
];

function openLink(hash = `#code=${CODE}`) {
  window.history.replaceState(null, "", `/auth/handoff${hash}`);
  // Strict, as the app renders: the effect runs twice on mount.
  render(
    <StrictMode>
      <MemoryRouter>
        <BrowserHandoffPage />
      </MemoryRouter>
    </StrictMode>,
  );
}

beforeEach(() => {
  // Everything but `replace` reads the real address, which `history` moves.
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: {
      get href() {
        return realLocation.href;
      },
      get origin() {
        return realLocation.origin;
      },
      get pathname() {
        return realLocation.pathname;
      },
      get search() {
        return realLocation.search;
      },
      get hash() {
        return realLocation.hash;
      },
      replace,
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  replace.mockReset();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: realLocation,
  });
  window.history.replaceState(null, "", "/");
});

describe("the sign-in link page", () => {
  it("drops the code from the address before asking anything", async () => {
    const requests = answer({ "/auth/handoff/peek": peeked(null), "/auth/handoff/redeem": REDEEMED });

    openLink();

    expect(realLocation.pathname).toBe("/auth/handoff");
    expect(realLocation.hash).toBe("");
    expect(realLocation.href).not.toContain(CODE);
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(requests.length).toBe(2);
    for (const request of requests) expect(request.address).not.toContain(CODE);
  });

  it("signs a browser with no session straight in and opens the page, once", async () => {
    const requests = answer({ "/auth/handoff/peek": peeked(null), "/auth/handoff/redeem": REDEEMED });

    openLink();

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/rooms/r1?workspace=acme#docs"));
    expect(replace).toHaveBeenCalledOnce();
    expect(requests.map((r) => [r.method, r.url, r.body])).toEqual([
      ["POST", "/gateway/auth/handoff/peek", { code: CODE }],
      ["POST", "/gateway/auth/handoff/redeem", { code: CODE }],
    ]);
  });

  it("signs the same person straight in", async () => {
    answer({ "/auth/handoff/peek": peeked(ADA, true), "/auth/handoff/redeem": REDEEMED });

    openLink();

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/rooms/r1?workspace=acme#docs"));
    expect(screen.queryByText(/You're signed in here as/)).toBeNull();
  });

  it("asks before replacing someone else's session, and continues when told to", async () => {
    const requests = answer({
      "/auth/handoff/peek": peeked(BOB),
      "/auth/handoff/redeem": REDEEMED,
    });

    openLink();

    expect(
      await screen.findByText(
        "You're signed in here as Bob (bob@example.com). Continue as Ada (ada@example.com)?",
      ),
    ).toBeTruthy();
    expect(screen.getByText("The page opens in Acme.")).toBeTruthy();
    expect(requests.map((r) => r.url)).toEqual(["/gateway/auth/handoff/peek"]);
    expect(replace).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Continue as Ada" }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/rooms/r1?workspace=acme#docs"));
    expect(requests.map((r) => r.url)).toEqual([
      "/gateway/auth/handoff/peek",
      "/gateway/auth/handoff/redeem",
    ]);
  });

  it("stays as the person already signed in, spending nothing", async () => {
    const requests = answer({ "/auth/handoff/peek": peeked(BOB) });

    openLink();
    fireEvent.click(await screen.findByRole("button", { name: "Stay as Bob" }));

    expect(replace).toHaveBeenCalledWith("/");
    expect(requests.map((r) => r.url)).toEqual(["/gateway/auth/handoff/peek"]);
  });

  it("says when the link has expired, and offers the sign-in page", async () => {
    const requests = answer({ "/auth/handoff/peek": EXPIRED });

    openLink();

    expect(
      await screen.findByText(
        "This sign-in link has expired or was already used. Open the page again from Switch Console.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/login");
    expect(requests.map((r) => r.url)).toEqual(["/gateway/auth/handoff/peek"]);
    expect(replace).not.toHaveBeenCalled();
  });

  it("says why when redeeming is refused", async () => {
    answer({
      "/auth/handoff/peek": peeked(null),
      "/auth/handoff/redeem": [
        410,
        { detail: "Switch Console was signed out after it made this sign-in link. Sign in again." },
      ],
    });

    openLink();

    expect(await screen.findByText(/Switch Console was signed out/)).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  it("says the link has expired without asking anything when it carries no code", async () => {
    const requests = answer({});

    openLink("");

    expect(await screen.findByText(/has expired or was already used/)).toBeTruthy();
    expect(requests).toEqual([]);
  });

  it("never puts the code in an address it requests", async () => {
    const requests = answer({ "/auth/handoff/peek": peeked(BOB), "/auth/handoff/redeem": REDEEMED });

    openLink();
    fireEvent.click(await screen.findByRole("button", { name: "Continue as Ada" }));
    await waitFor(() => expect(replace).toHaveBeenCalled());

    expect(requests.length).toBe(2);
    for (const request of requests) {
      expect(request.url).not.toContain(CODE);
      expect(request.body).toEqual({ code: CODE });
    }
  });
});

describe("the dashboard", () => {
  it("opens the link page outside any session, in either layout", async () => {
    const requests = answer({ "/auth/handoff/peek": peeked(null), "/auth/handoff/redeem": REDEEMED });
    window.history.replaceState(null, "", `/auth/handoff#code=${CODE}`);

    render(<App />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/rooms/r1?workspace=acme#docs"));
    // Neither the session nor the flags that pick a layout were read.
    expect(requests.map((r) => r.url)).toEqual([
      "/gateway/auth/handoff/peek",
      "/gateway/auth/handoff/redeem",
    ]);
  });
});

describe("reading the link", () => {
  it("takes the code from the fragment", () => {
    expect(codeFromHash(`#code=${CODE}`)).toBe(CODE);
    expect(codeFromHash("")).toBeNull();
    expect(codeFromHash("#code=")).toBeNull();
  });

  it("opens only pages on this dashboard", () => {
    expect(pageToOpen("/rooms/r1?workspace=acme#docs")).toBe("/rooms/r1?workspace=acme#docs");
    expect(pageToOpen("//evil.example/rooms")).toBe("/");
    expect(pageToOpen("https://evil.example/")).toBe("/");
  });
});
