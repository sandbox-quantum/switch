import { expect } from "vitest";
import { SwitchHttpError, errorDetail } from "../clients/switch-client.ts";
import type { FastScenario } from "./scenario.ts";

/**
 * What ends: ownership, a workspace and an account. The harness admin hands a
 * package to a colleague who signed up, who cannot hand on what is not
 * theirs. A second person who signed up makes a workspace of their own and
 * deletes it, once they type its name right, and it is no longer among their
 * workspaces. Asked before deleting, the colleague's account could go and the
 * harness admin's, Switch's administrator account, could not. Typing someone
 * else's email deletes nothing; the colleague deletes their own account with
 * theirs, which ends their session and their sign-in.
 *
 * The workspace maker's account is left behind, so this runs only on a stack
 * thrown away after the run.
 */
export const accountLifecycle: FastScenario = {
  header: {
    id: "account-lifecycle",
    covers: [
      "POST /gateway/auth/signup",
      "POST /gateway/ownership/transfer",
      "DELETE /gateway/tenants/{tenant_id}",
      "GET /gateway/tenants",
      "GET /gateway/auth/me/deletion",
      "DELETE /gateway/auth/me",
    ],
    lane: "fast",
    environments: ["ephemeral"],
    owner: "platform",
    requires: [],
  },
  async run({ names, switchClient, fixtures }) {
    const status = async (
      call: () => Promise<unknown>,
    ): Promise<[number, string]> => {
      try {
        await call();
      } catch (error) {
        if (error instanceof SwitchHttpError)
          return [error.status, errorDetail(error.body)];
        throw error;
      }
      return [200, ""];
    };

    const colleague = await fixtures.account("colleague");

    const given = await switchClient.createPackage({
      name: names.name("given"),
      description: `Switch end-to-end harness, handed over (run ${names.runId}).`,
      instructions: "",
    });
    fixtures.defer(`the handed-over package ${given.name}`, async () => {
      // Deleting the colleague's account may already have deleted it.
      const [code, detail] = await status(() =>
        switchClient.deletePackage(given.id),
      );
      if (code !== 200 && code !== 404) throw new Error(`${code}: ${detail}`);
    });
    const kept = await switchClient.createPackage({
      name: names.name("kept"),
      description: `Switch end-to-end harness, not handed over (run ${names.runId}).`,
      instructions: "",
    });
    fixtures.defer(`the kept package ${kept.name}`, () =>
      switchClient.deletePackage(kept.id),
    );

    const moved = await switchClient.transferOwnership({
      kind: "package",
      id: given.id,
      newOwnerId: colleague.id,
    });
    expect(moved, "the package handed to the colleague").toMatchObject({
      kind: "package",
      id: given.id,
      owner_id: colleague.id,
      agent_key_reissued: false,
    });
    const [notTheirs] = await status(() =>
      colleague.client.transferOwnership({
        kind: "package",
        id: kept.id,
        newOwnerId: colleague.id,
      }),
    );
    expect(notTheirs, "a member taking what isn't theirs").toBe(403);

    const makerEmail = `${names.name("maker")}@e2e.invalid`;
    const { client: maker } = await switchClient.signUp({
      email: makerEmail,
      password: `e2e-${names.runId}-${crypto.randomUUID()}`,
      displayName: "E2E workspace maker",
    });
    const spaceName = names.name("space");
    const spaceId = await maker.createTenant(spaceName);
    const [wrongName] = await status(() =>
      maker.deleteTenant(spaceId, "not its name"),
    );
    expect(wrongName, "deleting with the wrong name").toBe(400);
    await maker.deleteTenant(spaceId, spaceName);
    expect(
      (await maker.workspaces()).map((row) => row.id),
      "the maker's workspaces after deleting one",
    ).not.toContain(spaceId);

    expect(
      await colleague.client.accountDeletionRefusal(),
      "a member asking whether their account can go",
    ).toBeNull();
    // Only the server's administrator account is kept whatever happens;
    // another operator may go while one remains.
    expect(
      await switchClient.accountDeletionRefusal(),
      "Switch's administrator asking whether their account can go",
    ).toContain("administrator account");

    const [someoneElse] = await status(() =>
      colleague.client.deleteMyAccount(makerEmail),
    );
    expect(someoneElse, "deleting your account by typing someone else's email").toBe(400);
    expect(
      await colleague.client.userId(),
      "the colleague, still signed in after the refusal",
    ).toBe(colleague.id);

    await colleague.client.deleteMyAccount(colleague.email);
    const [session] = await status(() => colleague.client.tenantId());
    expect(session, "the deleted account's session").toBe(401);
    const [signIn] = await status(() =>
      switchClient.as(colleague.email, colleague.password).tenantId(),
    );
    expect(signIn, "signing in to a deleted account").toBe(401);
  },
};
