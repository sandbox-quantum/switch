import "@switch-console/chat-ui/theme.css";
import { Alert } from "@switch-console/chat-ui/primitives/alert";
import { SHARED_UI_CLASS } from "@switch-console/chat-ui/model/scope";
import { pickSubtitle } from "@switch-console/chat-ui/model/workspace-offers";
import { useState } from "react";
import { useAuth } from "../../data/AuthContext";
import CenteredCard from "./CenteredCard";
import { WorkspaceOfferRows, useWorkspaceOffers } from "./WorkspaceOffers";

export default function WorkspacePickerPage() {
  const { session, switchTo } = useAuth();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const offers = useWorkspaceOffers();
  const [joining, setJoining] = useState(false);
  const tenants = session?.tenants ?? [];

  const choose = async (tenantId: string) => {
    setPending(tenantId);
    setError(null);
    try {
      await switchTo(tenantId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open that workspace");
      setPending(null);
    }
  };

  return (
    <div className={SHARED_UI_CLASS}>
      <CenteredCard title="Choose a workspace" subtitle={pickSubtitle(tenants.length, offers.count)}>
        {error && (
          <Alert variant="destructive" className="mb-4">
            {error}
          </Alert>
        )}
        <div className="space-y-1">
          {tenants.map((tenant) => (
            <button
              key={tenant.id}
              onClick={() => choose(tenant.id)}
              disabled={pending !== null || joining}
              className="w-full rounded-md border border-border bg-background px-4 py-3 text-left transition-colors hover:bg-background-3 hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="font-medium text-foreground">{tenant.name}</div>
              <div className="text-xs capitalize text-muted-foreground">{tenant.role}</div>
            </button>
          ))}
        </div>
        <WorkspaceOfferRows offers={offers} landing="/" disabled={pending !== null} onBusy={setJoining} />
      </CenteredCard>
    </div>
  );
}
