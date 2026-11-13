import CloseOutlined from "@mui/icons-material/CloseOutlined";
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  Chip,
  Drawer,
  IconButton,
  Stack,
  Typography,
} from "@mui/material";
import { useEffect, useState } from "react";
import BrandTile from "../../../components/connectors/BrandTile";
import type { ConnectorApp, ConnectorApps } from "../../../data/api";
import { formatDate } from "../../../theme/format";
import ConnectorAppCard from "../../connector-apps/ConnectorAppCard";
import {
  PUBLIC_URL_BANNER,
  attention,
  cardState,
  missingPublicUrl,
  notSetUpSentence,
  sentBackTo,
  setUpLine,
} from "../../connector-apps/connectorApps";
import { ConnectorAppScopeContext } from "../../connector-apps/scope";
import SetupDialog from "../../connector-apps/SetupDialog";
import { appRowStatus } from "./orgConnectors";

const CHIP_COLOR = {
  ready: "success",
  not_set_up: "default",
  configured: "success",
  attention: "warning",
} as const;

/** The one line under an app's name: who set it up and when, or why it
 * needs someone, or what not having one means. */
function rowLine(app: ConnectorApp, checkFailure: string | null): string {
  const needs = attention(app, checkFailure);
  if (needs !== null) return needs.sentence;
  if (app.source === "none") return notSetUpSentence(app);
  return setUpLine(app, formatDate) ?? "";
}

function AppRow({
  app,
  checkFailure,
  selected,
  onOpen,
  onSetUp,
}: {
  app: ConnectorApp;
  checkFailure: string | null;
  selected: boolean;
  onOpen: () => void;
  onSetUp: () => void;
}) {
  const state = cardState(app, checkFailure);
  const offerSetUp = state === "not_set_up" && app.setup_blocked === null;
  return (
    <Stack
      direction="row"
      spacing={1.5}
      sx={{
        alignItems: "center",
        pr: offerSetUp ? 2 : 0,
        border: "1px solid var(--sw-border)",
        borderRadius: "10px",
        backgroundColor: "var(--sw-card)",
        ...(selected && { outline: "2px solid var(--mui-palette-primary-main)" }),
      }}
      data-testid={`org-app-${app.slug}`}
    >
      <ButtonBase
        onClick={onOpen}
        sx={{
          flex: 1,
          minWidth: 0,
          justifyContent: "flex-start",
          textAlign: "left",
          gap: 1.5,
          p: 1.5,
          borderRadius: "10px",
          "&:hover": { backgroundColor: "var(--sw-muted)" },
        }}
      >
        <BrandTile slug={app.slug} name={app.name} size={40} />
        <Box sx={{ minWidth: 0 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
              {app.name}
            </Typography>
            <Chip size="small" color={CHIP_COLOR[state]} label={appRowStatus(app, state)} />
          </Stack>
          <Typography variant="body2" color="text.secondary" noWrap sx={{ mt: 0.25 }}>
            {rowLine(app, checkFailure)}
          </Typography>
        </Box>
      </ButtonBase>
      {/* Outside the row's hit area, so setting up doesn't also open the panel. */}
      {offerSetUp && (
        <Button variant="outlined" size="small" onClick={onSetUp} sx={{ flexShrink: 0 }}>
          {app.server_app === true ? "Set up your own" : "Set up"}
        </Button>
      )}
    </Stack>
  );
}

/**
 * Organization settings › Connectors and apps › Apps & accounts: the vendor
 * apps the organization's workspaces sign in through, one row each, and the
 * row's detail in a panel beside the page. The panel is today's card, with
 * its checks, secret updates, switching and removal: the job is done rarely,
 * so it has no place in the list someone scans. Setting one up is today's
 * wizard.
 */
export default function AppsTab({
  apps,
  openApp,
  setupFor,
  onOpenApp,
  onSetupDone,
  onChanged,
}: {
  apps: ConnectorApps;
  openApp: string | null;
  /** An app whose setup to open at once: the Connectors tab sent someone here for it. */
  setupFor: string | null;
  onOpenApp: (slug: string | null) => void;
  onSetupDone: () => void;
  onChanged: (message: string | null) => void;
}) {
  const [checkFailures, setCheckFailures] = useState<Record<string, string>>({});
  const [settingUp, setSettingUp] = useState<ConnectorApp | null>(null);
  const opened = apps.apps.find((app) => app.slug === openApp) ?? null;
  const missingUrl = missingPublicUrl(apps.apps, apps.public_url);

  useEffect(() => {
    if (setupFor === null) return;
    const app = apps.apps.find((candidate) => candidate.slug === setupFor);
    if (app !== undefined && app.setup_blocked === null) setSettingUp(app);
    onSetupDone();
  }, [setupFor, apps.apps, onSetupDone]);

  return (
    <ConnectorAppScopeContext.Provider value="organization">
      <Stack spacing={1.5}>
        <Typography variant="body2" color="text.secondary">
          Your organization can register its own app at a vendor, and every workspace in it signs in
          through that one instead of Switch&apos;s.
          {apps.public_url !== null && ` ${sentBackTo(apps.public_url)}`}
        </Typography>
        {missingUrl && <Alert severity="warning">{PUBLIC_URL_BANNER}</Alert>}
        {apps.apps.map((app) => (
          <AppRow
            key={app.slug}
            app={app}
            checkFailure={checkFailures[app.slug] ?? null}
            selected={app.slug === openApp}
            onOpen={() => onOpenApp(app.slug === openApp ? null : app.slug)}
            onSetUp={() => setSettingUp(app)}
          />
        ))}
      </Stack>
      <Drawer
        anchor="right"
        open={opened !== null}
        onClose={() => onOpenApp(null)}
        slotProps={{ paper: { sx: { width: { xs: "100%", sm: 440 } } } }}
      >
        {opened && (
          <Stack spacing={2} sx={{ p: 3 }} role="region" aria-label={`${opened.name} app`}>
            <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
              <BrandTile slug={opened.slug} name={opened.name} size={40} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" color="text.secondary">
                  Connector app
                </Typography>
                <Typography variant="h6" noWrap>
                  {opened.name}
                </Typography>
              </Box>
              <IconButton aria-label={`Close ${opened.name}`} onClick={() => onOpenApp(null)}>
                <CloseOutlined fontSize="small" />
              </IconButton>
            </Stack>
            <ConnectorAppCard
              app={opened}
              publicUrl={apps.public_url}
              checkFailure={checkFailures[opened.slug] ?? null}
              onCheckFailure={(message) =>
                setCheckFailures((current) => {
                  const next = { ...current };
                  if (message === null) delete next[opened.slug];
                  else next[opened.slug] = message;
                  return next;
                })
              }
              onChecked={() => onChanged(null)}
              onChanged={onChanged}
            />
            {opened.scopes.length > 0 && (
              <Box>
                <Typography variant="overline" color="text.secondary">
                  Permissions it asks for
                </Typography>
                <Stack direction="row" useFlexGap spacing={0.75} sx={{ flexWrap: "wrap", mt: 0.5 }}>
                  {opened.scopes.map((scope) => (
                    <Chip key={scope} size="small" variant="outlined" label={scope} />
                  ))}
                </Stack>
              </Box>
            )}
          </Stack>
        )}
      </Drawer>
      {settingUp && (
        <SetupDialog
          app={settingUp}
          publicUrl={apps.public_url}
          mode={settingUp.saved_client_id !== null ? "enter_again" : "set_up"}
          open
          onClose={() => setSettingUp(null)}
          onSaved={() => {
            const name = settingUp.name;
            setSettingUp(null);
            onChanged(`${name} is set up for your organization.`);
          }}
        />
      )}
    </ConnectorAppScopeContext.Provider>
  );
}
