import "@switch-console/chat-ui/theme.css";
import { Alert } from "@switch-console/chat-ui/primitives/alert";
import { Button } from "@switch-console/chat-ui/primitives/button";
import { Field } from "@switch-console/chat-ui/primitives/field";
import { Input } from "@switch-console/chat-ui/primitives/input";
import { Label } from "@switch-console/chat-ui/primitives/label";
import { Separator } from "@switch-console/chat-ui/primitives/separator";
import { SHARED_UI_CLASS } from "@switch-console/chat-ui/model/scope";
import { pickSubtitle } from "@switch-console/chat-ui/model/workspace-offers";
import { useState } from "react";
import { useAuth } from "../../data/AuthContext";
import OrganizationsWithoutWorkspace from "../account/OrganizationsWithoutWorkspace";
import { inviteTokenFrom, storePendingInvite } from "../../data/sessionState";
import CenteredCard from "./CenteredCard";
import { AGENT_MANAGEMENT, GATEWAY_ONBOARDING } from "../../data/featureFlags";
import { GET_STARTED } from "../get-started/paths";
import CreateWorkspaceForm from "./CreateWorkspaceForm";
import { WorkspaceOfferRows, useWorkspaceOffers } from "./WorkspaceOffers";

export default function OnboardingPage() {
  const { session, refresh, capabilities } = useAuth();
  const landing =
    capabilities.features[GATEWAY_ONBOARDING] === true &&
    capabilities.features[AGENT_MANAGEMENT] === true
      ? GET_STARTED
      : "/";
  const [invite, setInvite] = useState("");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const canCreate = session?.can_create_workspace ?? false;
  const offers = useWorkspaceOffers();
  const [joining, setJoining] = useState(false);

  const joinWithInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    const token = inviteTokenFrom(invite);
    if (token === null) {
      setInviteError("That doesn't look like an invite link.");
      return;
    }
    storePendingInvite(token);
    await refresh();
  };

  return (
    <div className={SHARED_UI_CLASS}>
      <CenteredCard
        title="Welcome to Switch"
        subtitle={
          offers.count > 0
            ? `${pickSubtitle(0, offers.count)}${canCreate ? " Or create an organization for your team." : ""}`
            : canCreate
              ? "Create an organization for your team, or join a workspace you've been invited to."
              : "You're not in a workspace yet. Ask a workspace admin for an invite link."
        }
      >
        <div className="space-y-6">
          <OrganizationsWithoutWorkspace />
          <WorkspaceOfferRows offers={offers} landing={landing} disabled={false} onBusy={setJoining} />
          {canCreate && !joining && <CreateWorkspaceForm landing={landing} />}
          {canCreate && (
            <div className="relative">
              <Separator />
              <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-background px-2 text-xs text-muted-foreground">
                or
              </span>
            </div>
          )}
          <form onSubmit={joinWithInvite} className="space-y-4">
            <h3 className="text-sm font-medium">Have an invite link?</h3>
            {inviteError && <Alert variant="destructive">{inviteError}</Alert>}
            <Field>
              <Label htmlFor="invite-link">Invite link</Label>
              <Input
                id="invite-link"
                value={invite}
                onChange={(e) => {
                  setInvite(e.target.value);
                  setInviteError(null);
                }}
              />
            </Field>
            <Button type="submit" variant="outline" disabled={invite.trim() === ""} className="w-full">
              Join with invite
            </Button>
          </form>
        </div>
      </CenteredCard>
    </div>
  );
}
