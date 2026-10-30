import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routeFetch } from "../../test/routeFetch";
import JoinDomainsSection from "./JoinDomainsSection";

const PATH = "/tenants/t1/join-domains";
const OPEN = { domain: "example.com", created_by: "u1", created_at: "2026-10-01" };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("JoinDomainsSection", () => {
  it("opens the workspace to the admin's own domain", async () => {
    const calls = routeFetch({
      [`GET ${PATH}`]: [
        { body: { domains: [], own_domain: "example.com", own_domain_refusal: null } },
        { body: { domains: [OPEN], own_domain: "example.com", own_domain_refusal: null } },
      ],
      [`POST ${PATH}`]: { status: 201, body: OPEN },
    });
    render(<JoinDomainsSection tenantId="t1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));

    expect(
      await screen.findByText("Anyone with an @example.com address can join as a member"),
    ).toBeTruthy();
    expect(calls.find((c) => c.route === `POST ${PATH}`)?.body).toEqual({
      domain: "example.com",
    });
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });

  it("shows why the admin's domain can't be added, in place of the button", async () => {
    routeFetch({
      [`GET ${PATH}`]: {
        body: {
          domains: [],
          own_domain: "gmail.com",
          own_domain_refusal: "gmail.com is a public e-mail provider's domain",
        },
      },
    });
    render(<JoinDomainsSection tenantId="t1" />);

    expect(await screen.findByText("gmail.com is a public e-mail provider's domain.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });

  it("closes the workspace to a domain", async () => {
    const calls = routeFetch({
      [`GET ${PATH}`]: [
        { body: { domains: [OPEN], own_domain: "example.com", own_domain_refusal: null } },
        { body: { domains: [], own_domain: "example.com", own_domain_refusal: null } },
      ],
      [`DELETE ${PATH}/example.com`]: { status: 204 },
    });
    render(<JoinDomainsSection tenantId="t1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));

    expect(await screen.findByRole("button", { name: "Allow" })).toBeTruthy();
    expect(calls.some((c) => c.route === `DELETE ${PATH}/example.com`)).toBe(true);
  });

  it("shows the server's refusal", async () => {
    routeFetch({
      [`GET ${PATH}`]: { body: { domains: [], own_domain: "example.com", own_domain_refusal: null } },
      [`POST ${PATH}`]: { status: 409, body: { detail: "The workspace is already open to example.com" } },
    });
    render(<JoinDomainsSection tenantId="t1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));

    expect(await screen.findByText("The workspace is already open to example.com")).toBeTruthy();
  });
});
