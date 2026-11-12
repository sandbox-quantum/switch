import { Box, Stack, Switch, Typography } from "@mui/material";
import { SCREEN_READER_ONLY } from "../screenReaderOnly";

/**
 * Whether a connector is available at one level, an organization or a
 * workspace: the trailing control on its card in that level's settings.
 *
 * The state is in words, "Enabled" or "Disabled", so everyone reads the same
 * line. The switch follows only for someone who may change it; nobody gets a
 * greyed-out switch, since someone who can't change it has nothing to press.
 * A connector the level above has turned off says so in place of both: it
 * can't be switched back on from here.
 */
export default function ConnectorAvailability({
  available,
  connectorName,
  scopeName,
  turnedOffBy,
  onChange,
}: {
  available: boolean;
  connectorName: string;
  /** The level this decides for, as the switch names it: "… available in Acme". */
  scopeName: string;
  /** The level above that has the connector off ("Off for SandboxAQ"), or null. */
  turnedOffBy: string | null;
  /** Null when the viewer may not change it: then there is no switch. */
  onChange: ((available: boolean) => void) | null;
}) {
  if (turnedOffBy !== null) {
    return (
      <Typography variant="body2" color="text.secondary">
        Off for {turnedOffBy}
      </Typography>
    );
  }
  const word = available ? "Enabled" : "Disabled";
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
      {/* The switch, or the sentence below, says the same to a screen reader. */}
      <Typography
        variant="body2"
        aria-hidden
        sx={{ fontWeight: 500, color: available ? "var(--sw-success-text)" : "var(--sw-muted-foreground)" }}
      >
        {word}
      </Typography>
      {onChange ? (
        <Switch
          checked={available}
          onChange={(_, checked) => onChange(checked)}
          slotProps={{ input: { "aria-label": `${connectorName} available in ${scopeName}` } }}
          // On is the green the word beside it uses: here the switch is a
          // status as much as a control.
          sx={{ "& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track": { backgroundColor: "var(--sw-success)" } }}
        />
      ) : (
        <Box component="span" sx={SCREEN_READER_ONLY}>
          {`${connectorName} is ${word.toLowerCase()} in ${scopeName}.`}
        </Box>
      )}
    </Stack>
  );
}
