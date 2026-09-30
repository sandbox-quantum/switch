import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { useCallback, useMemo, useState } from "react";
import {
  type ChatClaim,
  type ClaimablePlatform,
  type InstalledApp,
  beginAppInstall,
  beginChatClaim,
} from "../../data/api";
import { useInstallablePlatforms, useInstalledApps } from "../../data/hooks";
import {
  MONO_SX,
  formatDate,
  pluralize,
  titleCase,
} from "../../theme/hootFormat";
import discordIcon from "../../assets/bridges/discord.svg";
import slackIcon from "../../assets/bridges/slack.svg";
import telegramIcon from "../../assets/bridges/telegram.svg";
import ClaimChatDialog from "./ClaimChatDialog";
import DisconnectAppDialog, { installNoun } from "./DisconnectAppDialog";

/**
 * The other way a connection comes into being. Registering an app means
 * creating one on the platform, choosing its scopes and pasting its token in
 * here; installing means clicking a button and approving a consent screen,
 * with this deployment's own app supplying the credentials.
 *
 * Both are shown because both exist, and an operator has to be able to tell
 * which of their connections is which — a registered app's token is theirs to
 * rotate and an installed one's is not, and only the second has to be removed
 * through Disconnect.
 *
 * Renders nothing at all on a deployment that has no app of its own and has
 * never had one, which is most of them: an empty section explaining a feature
 * nobody here can use is worse than no section.
 *
 * One card per platform, each carrying its own actions, so the page does not
 * grow a row of buttons with every app. Installs are listed by name; ended
 * ones, which are history rather than state, are folded away.
 *
 * A claim-based platform (Telegram) is installed a chat at a time, and a chat
 * is a room rather than a connection. So its buttons are offered to whoever
 * the server says may use them — an admin to connect the first chat, anyone
 * after that — and any member may disconnect one of its chats, where every
 * OAuth action here is a tenant admin's. Its connection outlives its chats,
 * and is turned off by deleting it with the other connections.
 */

// The platform's own logo on its Add button, as Switch Console shows it.
const PLATFORM_ICON: Record<string, string> = {
  discord: discordIcon,
  slack: slackIcon,
  telegram: telegramIcon,
};

const ENDED_COLOR: Record<string, "warning" | "default"> = {
  // Ended at the platform rather than here — somebody removed the app, or its
  // token was killed. Warned rather than greyed out, because unlike
  // "disconnected" it is news.
  revoked: "warning",
  disconnected: "default",
};

interface Props {
  isAdmin: boolean;
  // Disconnecting removes the connection the install created, so the list of
  // connections above this section is stale once it succeeds.
  onConnectionsChanged: () => void;
}

export default function InstalledAppsSection({
  isAdmin,
  onConnectionsChanged,
}: Props) {
  const { data: offered, refetch: refetchOffered } = useInstallablePlatforms();
  const { data: installs, loading, refetch } = useInstalledApps();
  const [starting, setStarting] = useState<string | null>(null);
  const [claim, setClaim] = useState<{
    platform: string;
    claim: ChatClaim;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<InstalledApp | null>(
    null,
  );

  const claimable = useMemo(() => offered?.claimable ?? [], [offered]);
  const installable = useMemo(() => offered?.platforms ?? [], [offered]);
  const rows = useMemo(() => installs ?? [], [installs]);

  // Every platform this organisation can add to, or has anything recorded
  // for — a platform whose app was since removed still shows its history.
  const platforms = useMemo(() => {
    const seen = new Set<string>();
    for (const c of claimable) seen.add(c.platform);
    if (isAdmin) for (const p of installable) seen.add(p);
    for (const row of rows) seen.add(row.platform);
    return [...seen];
  }, [claimable, installable, rows, isAdmin]);

  const handleInstall = useCallback(async (platform: string) => {
    setStarting(platform);
    setError(null);
    try {
      // A top-level navigation, not a popup and not an iframe: the platform's
      // consent screen sets cookies on its own domain and refuses to be
      // framed, and a popup opened after an await is what a browser blocks.
      // `starting` is deliberately left set — the page is on its way out.
      window.location.href = await beginAppInstall(platform);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start the install");
      setStarting(null);
    }
  }, []);

  const handleClaim = useCallback(async (platform: string) => {
    setStarting(platform);
    setError(null);
    try {
      setClaim({ platform, claim: await beginChatClaim(platform) });
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Failed to start connecting a chat",
      );
    } finally {
      setStarting(null);
    }
  }, []);

  // A claim lands in the chat, not here, so the list is refreshed when the
  // dialog closes rather than waited on.
  const handleClaimClosed = useCallback(() => {
    setClaim(null);
    refetch();
    refetchOffered();
    onConnectionsChanged();
  }, [refetch, refetchOffered, onConnectionsChanged]);

  const handleDisconnected = useCallback(() => {
    setDisconnectTarget(null);
    refetch();
    refetchOffered();
    onConnectionsChanged();
  }, [refetch, refetchOffered, onConnectionsChanged]);

  if (platforms.length === 0) {
    return null;
  }

  return (
    <Box mt={5}>
      <Typography variant="h5" mb={1}>
        Installed apps
      </Typography>
      <Typography variant="body2" color="text.secondary" mb={2}>
        This deployment&apos;s own apps, using credentials only the deployment
        holds. Disconnect what an app is installed in here: a connection above
        cannot be deleted while an app is still installed through it.
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {loading ? (
        <CircularProgress />
      ) : (
        <Stack spacing={2}>
          {platforms.map((platform) => {
            const claimed = claimable.find((c) => c.platform === platform);
            return (
              <PlatformCard
                key={platform}
                platform={platform}
                installs={rows.filter((row) => row.platform === platform)}
                claimable={claimed}
                canInstall={isAdmin && installable.includes(platform)}
                canDisconnect={isAdmin || claimed !== undefined}
                starting={starting}
                onAdd={() =>
                  claimed ? handleClaim(platform) : handleInstall(platform)
                }
                onDisconnect={setDisconnectTarget}
              />
            );
          })}
        </Stack>
      )}

      <DisconnectAppDialog
        install={disconnectTarget}
        onClose={() => setDisconnectTarget(null)}
        onDisconnected={handleDisconnected}
      />
      <ClaimChatDialog
        platform={claim?.platform ?? ""}
        claim={claim?.claim ?? null}
        onClose={handleClaimClosed}
      />
    </Box>
  );
}

interface CardProps {
  platform: string;
  installs: InstalledApp[];
  // Set for a claim-based platform, with what this caller may do on it.
  claimable: ClaimablePlatform | undefined;
  canInstall: boolean;
  canDisconnect: boolean;
  starting: string | null;
  onAdd: () => void;
  onDisconnect: (install: InstalledApp) => void;
}

function PlatformCard({
  platform,
  installs,
  claimable,
  canInstall,
  canDisconnect,
  starting,
  onAdd,
  onDisconnect,
}: CardProps) {
  const [showEnded, setShowEnded] = useState(false);
  const name = titleCase(platform);
  const noun = installNoun(platform);
  const active = installs.filter((row) => row.status === "active");
  const ended = installs.filter((row) => row.status !== "active");
  const canAdd = claimable ? claimable.can_add_chat : canInstall;
  const icon = PLATFORM_ICON[platform];

  return (
    <Paper variant="outlined" sx={{ borderRadius: 2 }}>
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{ px: 2, py: 1.5 }}
      >
        <Box sx={{ flexGrow: 1 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
            {name}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {active.length > 0
              ? `${pluralize(active.length, noun)} connected`
              : claimable?.connected
                ? `No ${noun}s connected. The connection stays until an admin deletes it above.`
                : "Not connected"}
          </Typography>
        </Box>
        {canAdd && (
          <Button
            variant="contained"
            disabled={starting !== null}
            startIcon={
              starting === platform ? (
                <CircularProgress size={16} />
              ) : icon ? (
                <Box
                  component="img"
                  src={icon}
                  alt=""
                  sx={{ width: 16, height: 16 }}
                />
              ) : undefined
            }
            onClick={onAdd}
          >
            Add to {name}
          </Button>
        )}
      </Stack>

      {active.map((install) => (
        <InstallRow
          key={install.id}
          install={install}
          onDisconnect={canDisconnect ? () => onDisconnect(install) : undefined}
        />
      ))}

      {ended.length > 0 && (
        <>
          <Divider />
          <Box sx={{ px: 1, py: 0.5 }}>
            <Button
              size="small"
              onClick={() => setShowEnded((shown) => !shown)}
            >
              {showEnded ? "Hide ended" : `Show ${ended.length} ended`}
            </Button>
          </Box>
          {showEnded &&
            ended.map((install) => (
              <InstallRow key={install.id} install={install} />
            ))}
        </>
      )}
    </Paper>
  );
}

function InstallRow({
  install,
  onDisconnect,
}: {
  install: InstalledApp;
  onDisconnect?: () => void;
}) {
  const live = install.status === "active";
  return (
    <>
      <Divider />
      <Stack
        direction="row"
        alignItems="center"
        spacing={2}
        sx={{ px: 2, py: 1 }}
      >
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          {/* The id is always a hover away: it is what the platform's own
              admin screens and Switch's logs call the install. */}
          <Tooltip
            title={install.external_workspace_id}
            placement="bottom-start"
          >
            <Typography
              variant="body2"
              noWrap
              sx={install.name ? undefined : MONO_SX}
            >
              {install.name ?? install.external_workspace_id}
            </Typography>
          </Tooltip>
          {install.scopes && (
            // Verbatim, and in full on hover: a scope string that means
            // nothing here is still the answer to why the platform refused a
            // call.
            <Tooltip title={install.scopes} placement="bottom-start">
              <Typography
                variant="caption"
                color="text.secondary"
                noWrap
                component="div"
                sx={MONO_SX}
              >
                {install.scopes}
              </Typography>
            </Tooltip>
          )}
        </Box>
        {!live && (
          <Chip
            label={titleCase(install.status)}
            size="small"
            color={ENDED_COLOR[install.status] ?? "default"}
          />
        )}
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ whiteSpace: "nowrap" }}
        >
          {live
            ? `Connected ${formatDate(install.installed_at)}`
            : `Ended ${formatDate(install.ended_at)}`}
        </Typography>
        {live && onDisconnect && (
          <Button size="small" color="error" onClick={onDisconnect}>
            Disconnect
          </Button>
        )}
      </Stack>
    </>
  );
}
