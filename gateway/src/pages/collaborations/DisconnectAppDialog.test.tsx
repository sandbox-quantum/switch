import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { InstalledApp } from "../../data/api";
import DisconnectAppDialog from "./DisconnectAppDialog";

const install: InstalledApp = {
  id: "i1",
  platform: "teams",
  external_workspace_id: "org-123",
  status: "active",
  scopes: "ChannelMessage.Send",
  bridge_id: "b1",
  installed_at: "2026-01-01",
  ended_at: null,
};

describe("DisconnectAppDialog", () => {
  afterEach(() => cleanup());

  it("names Microsoft Teams and the admin centers, and does not claim a token is revoked", () => {
    render(
      <DisconnectAppDialog
        install={install}
        onClose={() => {}}
        onDisconnected={() => {}}
      />,
    );

    // The dialog renders through a portal, so it lands outside `container`
    // and has to be read off `document.body` instead.
    const text = document.body.textContent ?? "";
    expect(text).toContain("Microsoft Teams organisation");
    expect(text).toContain("Teams admin center");
    expect(text).toContain("Microsoft Entra admin center");
    expect(text).not.toContain("access token is revoked");
  });

  it("uses the default, token-revoking copy for a platform with no entry of its own", () => {
    render(
      <DisconnectAppDialog
        install={{ ...install, platform: "slack" }}
        onClose={() => {}}
        onDisconnected={() => {}}
      />,
    );

    expect(document.body.textContent ?? "").toContain("access token is revoked");
  });
});
