import CheckOutlined from "@mui/icons-material/CheckOutlined";
import MoreHorizOutlined from "@mui/icons-material/MoreHorizOutlined";
import {
  Alert,
  Button,
  Chip,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  Typography,
} from "@mui/material";
import { useId, useState } from "react";
import { useNavigate } from "react-router";
import ConfirmDialog from "../../../components/ConfirmDialog";
import CatalogueGrid from "../../../components/connectors/CatalogueGrid";
import ConnectorAvailability from "../../../components/connectors/ConnectorAvailability";
import ConnectorCard from "../../../components/connectors/ConnectorCard";
import InfoTip from "../../../components/InfoTip";
import {
  type ConnectorApp,
  type OrganizationService,
  type OrganizationServices,
  clearOrganizationService,
  setOrganizationService,
} from "../../../data/api";
import { reachText } from "../OrganizationServicesSection";
import {
  POLICIES,
  type Policy,
  SETUP_LABEL,
  available,
  needsConfirming,
  offConfirmation,
  policyChip,
  policyForSwitch,
  policyOf,
  settingOf,
  setupNeed,
} from "./orgConnectors";

/** The "…" beside a connector's switch: all five of the organization's
 * settings, the current one ticked. */
function PolicyMenu({
  service,
  policy,
  disabled,
  onChoose,
}: {
  service: OrganizationService;
  policy: Policy;
  disabled: boolean;
  onChoose: (policy: Policy) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const triggerId = useId();
  return (
    <>
      <IconButton
        id={triggerId}
        aria-label={`More settings for ${service.name}`}
        aria-haspopup="menu"
        aria-expanded={anchor ? "true" : undefined}
        disabled={disabled}
        onClick={(event) => setAnchor(event.currentTarget)}
        sx={{ width: 32, height: 32 }}
      >
        <MoreHorizOutlined fontSize="small" />
      </IconButton>
      <Menu
        anchorEl={anchor}
        open={anchor !== null}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ list: { "aria-labelledby": triggerId } }}
      >
        {POLICIES.map((option) => (
          <MenuItem
            key={option.value}
            selected={option.value === policy}
            onClick={() => {
              setAnchor(null);
              if (option.value !== policy) onChoose(option.value);
            }}
            sx={{ alignItems: "flex-start", maxWidth: 340, whiteSpace: "normal" }}
          >
            <ListItemIcon sx={{ mt: 0.25 }}>
              {option.value === policy && <CheckOutlined fontSize="small" />}
            </ListItemIcon>
            <ListItemText primary={option.label} secondary={option.detail} />
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}

/**
 * The organization's connectors as the catalogue shows them, each with the
 * organization's say. The switch is the decision most admins make, may the
 * workspaces use it at all; the "…" beside it holds the rest. A connector
 * that can't be used until the organization sets up its app offers that in
 * place of both: a switch that can't take effect is worse than none.
 */
export default function ConnectorsTab({
  organizationName,
  services,
  apps,
  onSetUp,
  onChanged,
}: {
  organizationName: string;
  services: OrganizationServices;
  apps: ConnectorApp[];
  onSetUp: (slug: string) => void;
  onChanged: (message: string | null) => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<OrganizationService | null>(null);
  const appBySlug = new Map(apps.map((app) => [app.slug, app]));

  const apply = async (service: OrganizationService, to: Policy) => {
    const setting = settingOf(to);
    const { warning: left } =
      setting === null
        ? await clearOrganizationService(service.slug)
        : await setOrganizationService(service.slug, setting);
    setWarning(left);
    const label = POLICIES.find((p) => p.value === to)!.label;
    onChanged(`${service.name}: ${label.toLowerCase()}.`);
  };

  const choose = async (service: OrganizationService, to: Policy) => {
    // One change at a time: each reads the lists again when it lands.
    if (busy !== null) return;
    if (needsConfirming(policyOf(service.setting), to)) {
      setConfirming(service);
      return;
    }
    setBusy(service.slug);
    setError(null);
    setWarning(null);
    try {
      await apply(service, to);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The change failed");
    } finally {
      setBusy(null);
    }
  };

  const confirmation = confirming ? offConfirmation(confirming, services.workspaces) : null;

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary" component="div">
        Choose which connectors {organizationName} can use. Switching one off takes it out of every
        workspace.{" "}
        <InfoTip>
          On, a connector is each workspace's own choice. The "…" beside it sets a default for the
          workspaces instead, or turns it on in every one of them.
        </InfoTip>
      </Typography>
      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {warning && (
        <Alert severity="warning" onClose={() => setWarning(null)}>
          {warning}
        </Alert>
      )}
      <div>
        <CatalogueGrid
          connectors={services.services}
          query={query}
          onQueryChange={setQuery}
          emptyMessage="No connectors match that search."
          renderCard={(service) => {
            const policy = policyOf(service.setting);
            const chip = policyChip(policy);
            const need = setupNeed(service, appBySlug.get(service.slug));
            return (
              <ConnectorCard
                connector={service}
                badges={chip && <Chip size="small" label={chip} />}
                meta={reachText(service, services.workspaces)}
                onOpen={() =>
                  navigate(`/connectors/${service.slug}`, {
                    state: { back: { label: "Connectors and apps", to: "/settings/org/connectors" } },
                  })
                }
                trailing={
                  service.server_switched_off !== null ? (
                    <Typography variant="body2" color="text.secondary">
                      Off for everyone
                    </Typography>
                  ) : need?.kind === "blocked" ? (
                    <Typography variant="body2" color="text.secondary" component="div">
                      Can't be set up yet <InfoTip>{need.reason}</InfoTip>
                    </Typography>
                  ) : need !== null ? (
                    <Button variant="outlined" size="small" onClick={() => onSetUp(service.slug)}>
                      {SETUP_LABEL[need.kind]}
                    </Button>
                  ) : (
                    <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
                      <ConnectorAvailability
                        available={available(policy)}
                        connectorName={service.name}
                        scopeName={organizationName}
                        turnedOffBy={null}
                        onChange={(on) => void choose(service, policyForSwitch(on))}
                      />
                      <PolicyMenu
                        service={service}
                        policy={policy}
                        disabled={busy !== null}
                        onChoose={(to) => void choose(service, to)}
                      />
                    </Stack>
                  )
                }
              />
            );
          }}
        />
      </div>
      {confirming && confirmation && (
        <ConfirmDialog
          open
          title={confirmation.title}
          description={confirmation.description}
          confirmLabel="Turn off everywhere"
          tone="destructive"
          onConfirm={() => apply(confirming, "off_locked")}
          onClose={() => setConfirming(null)}
        />
      )}
    </Stack>
  );
}
