import { Box, Typography } from "@mui/material";
import { ConnectorAppsList } from "../connector-apps/ConnectorAppsPage";
import { sentBackTo } from "../connector-apps/connectorApps";

function Heading({ publicUrl }: { publicUrl: string | null }) {
  return (
    <Box mb={2}>
      <Typography variant="h6">Connectors</Typography>
      <Typography variant="body2" color="text.secondary">
        Your organization can register its own app at a vendor, and every workspace in it signs
        in through that one instead of the server&apos;s.
        {publicUrl !== null && ` ${sentBackTo(publicUrl)}`}
      </Typography>
    </Box>
  );
}

/** The apps the organization's workspaces sign in through, for its admins.
 * Shown only where the server lets organizations save their own. */
export default function OrganizationConnectorsSection() {
  return (
    <ConnectorAppsList
      scope="organization"
      notEnabled={null}
      heading={(publicUrl) => <Heading publicUrl={publicUrl} />}
    />
  );
}
