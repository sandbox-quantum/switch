import DownloadOutlined from "@mui/icons-material/DownloadOutlined";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Radio,
  RadioGroup,
  Stack,
  Switch,
  Tooltip,
  Typography,
} from "@mui/material";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type BridgeDetail,
  type TeamPlacement,
  addBridgeToTeam,
  fetchTeamPlacements,
  fetchTeamsAppPackage,
  removeBridgeFromTeam,
  setDefaultTeamsTeam,
} from "../../data/api";

interface Props {
  /** The bridge to manage teams for, or null when the dialog is closed. */
  bridge: BridgeDetail | null;
  onClose: () => void;
  // Choosing a default team turns channel creation on, so the bridges table
  // behind this dialog is stale once a change here succeeds.
  onChanged: () => void;
}

/** Which of the organisation's teams the distributed Teams app is in, and
 *  which one new channels go in by default. Everything here comes from the
 *  connection's own adapter; the dialog knows nothing about Microsoft Graph. */
export default function TeamsPlacementDialog({ bridge, onClose, onChanged }: Props) {
  const bridgeId = bridge?.bridge_id;

  const [teams, setTeams] = useState<TeamPlacement[]>([]);
  const [defaultTeamId, setDefaultTeamId] = useState<string | null>(null);
  const [inCatalog, setInCatalog] = useState(true);
  const [catalogProblem, setCatalogProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [togglingTeamId, setTogglingTeamId] = useState<string | null>(null);
  const [settingDefaultId, setSettingDefaultId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ teamId: string; message: string } | null>(
    null,
  );

  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // Each change reloads the list; only the latest load may write it, so an
  // earlier one answering late cannot put back what a later change undid.
  const latestLoad = useRef(0);

  const load = useCallback(() => {
    if (!bridgeId) return;
    const thisLoad = ++latestLoad.current;
    setLoading(true);
    setLoadError(null);
    fetchTeamPlacements(bridgeId)
      .then((result) => {
        if (thisLoad !== latestLoad.current) return;
        setTeams(result.teams);
        setDefaultTeamId(result.default_team_id);
        setInCatalog(result.in_catalog);
        setCatalogProblem(result.catalog_problem);
      })
      .catch((e) => {
        if (thisLoad !== latestLoad.current) return;
        setLoadError(e instanceof Error ? e.message : "Failed to load teams");
      })
      .finally(() => {
        if (thisLoad === latestLoad.current) setLoading(false);
      });
  }, [bridgeId]);

  useEffect(() => {
    if (bridgeId) load();
  }, [bridgeId, load]);

  const busy = togglingTeamId !== null || settingDefaultId !== null;

  const handleClose = () => {
    if (busy) return;
    setDownloadError(null);
    setRowError(null);
    onClose();
  };

  const handleToggle = useCallback(
    async (team: TeamPlacement) => {
      if (!bridgeId) return;
      setTogglingTeamId(team.team_id);
      setRowError(null);
      try {
        if (team.has_switch) {
          await removeBridgeFromTeam(bridgeId, team.team_id);
        } else {
          await addBridgeToTeam(bridgeId, team.team_id);
        }
        load();
        onChanged();
      } catch (e) {
        setRowError({
          teamId: team.team_id,
          message: e instanceof Error ? e.message : "Failed to update the team",
        });
      } finally {
        setTogglingTeamId(null);
      }
    },
    [bridgeId, load, onChanged],
  );

  const handleMakeDefault = useCallback(
    async (team: TeamPlacement) => {
      if (!bridgeId || !team.has_switch) return;
      setSettingDefaultId(team.team_id);
      setRowError(null);
      try {
        // Choosing a default team is also the decision to turn channel
        // creation on: installed bridges start with it off.
        await setDefaultTeamsTeam(bridgeId, team.team_id);
        load();
        onChanged();
      } catch (e) {
        setRowError({
          teamId: team.team_id,
          message: e instanceof Error ? e.message : "Failed to set the default team",
        });
      } finally {
        setSettingDefaultId(null);
      }
    },
    [bridgeId, load, onChanged],
  );

  const handleDownload = useCallback(async () => {
    if (!bridgeId) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      const { blob, filename } = await fetchTeamsAppPackage(bridgeId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setDownloadError(
        e instanceof Error ? e.message : "Failed to download the app package",
      );
    } finally {
      setDownloading(false);
    }
  }, [bridgeId]);

  return (
    <Dialog open={!!bridge} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>Microsoft Teams: {bridge?.display_name}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 0.5 }}>
          <Typography variant="body2" color="text.secondary">
            Choose which of your organisation&apos;s teams Switch is in, and which
            one new channels go in by default. Only a team Switch is in can be the
            default.
          </Typography>

          {loading && (
            <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
              <CircularProgress size={28} />
            </Box>
          )}

          {!loading && loadError && <Alert severity="error">{loadError}</Alert>}

          {!loading && !loadError && (
            <>
              {!inCatalog && (
                <Alert
                  severity="warning"
                  action={
                    <Button
                      color="inherit"
                      size="small"
                      startIcon={
                        downloading ? (
                          <CircularProgress size={14} />
                        ) : (
                          <DownloadOutlined fontSize="small" />
                        )
                      }
                      onClick={handleDownload}
                      disabled={downloading}
                    >
                      Download app package
                    </Button>
                  }
                >
                  {catalogProblem ??
                    "Switch is not in your organisation's Teams app list yet."}{" "}
                  A Teams admin uploads it by hand in the Teams admin center, under
                  Teams apps, Manage apps, Upload new app. Once it is in any one team,
                  added from Teams, Switch can add it to the rest from here.
                </Alert>
              )}
              {downloadError && <Alert severity="error">{downloadError}</Alert>}

              {teams.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  No teams found in your organisation.
                </Typography>
              ) : (
                <RadioGroup
                  value={defaultTeamId ?? ""}
                  onChange={(_e, value) => {
                    const team = teams.find((t) => t.team_id === value);
                    if (team) handleMakeDefault(team);
                  }}
                >
                  <Stack divider={<Divider />}>
                    {teams.map((team) => (
                      <Stack
                        key={team.team_id}
                        direction="row"
                        alignItems="center"
                        spacing={1}
                        sx={{ py: 1 }}
                      >
                        <Tooltip
                          title={
                            team.has_switch
                              ? "Make this the default team for new channels"
                              : "Add Switch to this team before it can be the default"
                          }
                        >
                          <span>
                            <Radio
                              size="small"
                              value={team.team_id}
                              disabled={!team.has_switch || busy}
                              slotProps={{
                                input: {
                                  "aria-label": `Make ${team.name} the default team`,
                                },
                              }}
                            />
                          </span>
                        </Tooltip>

                        <Stack sx={{ flex: 1 }}>
                          <Typography variant="body2">{team.name}</Typography>
                          {team.has_switch === null && (
                            <Typography variant="caption" color="text.secondary">
                              Switch could not read this team&apos;s apps.
                            </Typography>
                          )}
                          {rowError?.teamId === team.team_id && (
                            <Typography variant="caption" color="error">
                              {rowError.message}
                            </Typography>
                          )}
                        </Stack>

                        {settingDefaultId === team.team_id && (
                          <CircularProgress size={16} />
                        )}

                        <Tooltip
                          title={
                            team.has_switch === null
                              ? "Switch could not read this team's apps"
                              : !team.has_switch && !inCatalog
                              ? "Switch is not in your organisation's Teams app list yet"
                              : team.has_switch
                                ? "Remove Switch from this team"
                                : "Add Switch to this team"
                          }
                        >
                          <span>
                            <Switch
                              size="small"
                              checked={team.has_switch === true}
                              disabled={
                                team.has_switch === null ||
                                togglingTeamId === team.team_id ||
                                (!team.has_switch && !inCatalog)
                              }
                              onChange={() => handleToggle(team)}
                              slotProps={{
                                input: {
                                  "aria-label": team.has_switch
                                    ? `Remove Switch from ${team.name}`
                                    : `Add Switch to ${team.name}`,
                                },
                              }}
                            />
                          </span>
                        </Tooltip>
                      </Stack>
                    ))}
                  </Stack>
                </RadioGroup>
              )}
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={busy}>
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
}
