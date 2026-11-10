// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  type DevResponse,
  devRoleAccounts,
  serveDevRoleAccounts,
} from "../../scripts/dev-role-accounts.mjs";

/** Any file that exists will do for the contents. */
const EXISTING = new URL("../../package.json", import.meta.url);
const MISSING = new URL("../../.no-such-accounts.json", import.meta.url);

async function ask(file: URL, remoteAddress: string) {
  const answer = { status: 200, headers: {} as Record<string, string>, body: "" };
  const res: DevResponse = {
    set statusCode(status: number) {
      answer.status = status;
    },
    get statusCode() {
      return answer.status;
    },
    setHeader: (name, value) => {
      answer.headers[name] = value;
    },
    end: (body) => {
      answer.body = body;
    },
  };
  await serveDevRoleAccounts(file)({ socket: { remoteAddress } }, res);
  return answer;
}

describe("the dev server's role accounts route", () => {
  it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])("hands the file to %s", async (address) => {
    const answer = await ask(EXISTING, address);
    expect(answer.status).toBe(200);
    expect(answer.body).toContain('"name": "switch-gateway"');
    expect(answer.headers["Cache-Control"]).toBe("no-store");
  });

  it("refuses anyone not on this machine, without reading the file", async () => {
    const answer = await ask(EXISTING, "192.168.0.17");
    expect(answer.status).toBe(403);
    expect(answer.body).not.toContain("switch-gateway");
  });

  it("answers 404 while nothing has been seeded", async () => {
    expect((await ask(MISSING, "127.0.0.1")).status).toBe(404);
  });

  it("exists only in the dev server", () => {
    expect(devRoleAccounts(MISSING).apply).toBe("serve");
  });
});
