import { expect } from "vitest";
import { SwitchHttpError, errorDetail } from "../clients/switch-client.ts";
import type { FastScenario } from "./scenario.ts";

/**
 * What ends: ownership, a workspace and an account. The harness admin hands a
 * package to a colleague, who cannot hand on what is not theirs. A second
 * person makes a workspace of their own and deletes it, once they type its
 * name right. The colleague cannot delete anyone's account; the operator
 * deletes theirs, which ends their sign-in.
 *
 * The workspace maker is a deployment operator, so they can make a
 * workspace, and an operator's account cannot be deleted, so this runs only
 * on a stack thrown away after the run.
 */
export const accountLifecycle: FastScenario = {
  header: {
    id: "account-lifecycle",
    covers: [
      "POST /gateway/ownership/transfer",
      "DELETE /gateway/tenants/{tenant_id}",
      "DELETE /gateway/users/{user_id}",
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

    const password = `e2e-${names.runId}-${crypto.randomUUID()}`;
    const email = `${names.name("colleague")}@e2e.invalid`;
    const { id: colleagueId } = await switchClient.createUser({
      name: "E2E colleague",
      email,
      password,
      role: "user",
    });
    const colleague = switchClient.as(email, password);
    // Signing in joins the default workspace, where the transfer happens.
    await colleague.tenantId();

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
      newOwnerId: colleagueId,
    });
    expect(moved, "the package handed to the colleague").toMatchObject({
      kind: "package",
      id: given.id,
      owner_id: colleagueId,
      agent_key_reissued: false,
    });
    const [notTheirs] = await status(() =>
      colleague.transferOwnership({
        kind: "package",
        id: kept.id,
        newOwnerId: colleagueId,
      }),
    );
    expect(notTheirs, "a member taking what isn't theirs").toBe(403);

    const makerEmail = `${names.name("maker")}@e2e.invalid`;
    const { id: makerId } = await switchClient.createUser({
      name: "E2E workspace maker",
      email: makerEmail,
      password,
      role: "admin",
    });
    const maker = switchClient.as(makerEmail, password);
    const spaceName = names.name("space");
    const spaceId = await maker.createTenant(spaceName);
    const [wrongName] = await status(() =>
      maker.deleteTenant(spaceId, "not its name"),
    );
    expect(wrongName, "deleting with the wrong name").toBe(400);
    await maker.deleteTenant(spaceId, spaceName);
    const everyWorkspace = await switchClient.operatorWorkspaces();
    expect(
      everyWorkspace.map((row) => row.id),
      "the deleted workspace",
    ).not.toContain(spaceId);

    const [notOperator] = await status(() => colleague.deleteUser(makerId));
    expect(notOperator, "a member deleting someone's account").toBe(403);

    await switchClient.deleteUser(colleagueId);
    const [signIn] = await status(() =>
      switchClient.as(email, password).tenantId(),
    );
    expect(signIn, "signing in to a deleted account").toBe(401);
  },
};
