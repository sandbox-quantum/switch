import AccountTreeOutlined from "@mui/icons-material/AccountTreeOutlined";
import ChevronRight from "@mui/icons-material/ChevronRight";
import {
  Box,
  Button,
  Card,
  CardActionArea,
  CircularProgress,
  Stack,
  Typography,
} from "@mui/material";
import { useCallback } from "react";
import { Link as RouterLink } from "react-router";
import PageHeader from "../../components/PageHeader";
import { useAuth } from "../../data/AuthContext";
import { fetchMembers, loadAgents, loadRooms } from "../../data/api";
import { AGENT_MANAGEMENT, GATEWAY_ONBOARDING } from "../../data/featureFlags";
import { type ListScope, agentsInScope, listScopeOf, roomsInScope } from "../../data/listScope";
import { GET_STARTED } from "../get-started/paths";
import { EM_DASH } from "../../theme/format";
import { useWebChats } from "../chats/WebChatHost";
import { useRoomsListPath } from "../rooms/roomsListPath";
import { useLoad } from "../workspace/useLoad";
import { BuddyHome } from "./BuddyHome";

interface Count {
  value: number | null;
  loading: boolean;
  error: string | null;
}

/** One count, and the way into the list behind it. A count that could not be
 * read shows a dash and the reason, never a 0 that would read as "none". */
function CountCard({
  label,
  to,
  count,
  caption,
}: {
  label: string;
  to: string;
  count: Count;
  caption: string | null;
}) {
  return (
    <Card sx={{ flex: "1 1 200px", minWidth: 200 }}>
      <CardActionArea component={RouterLink} to={to} sx={{ height: "100%", p: 2 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between">
          <Typography component="span" variant="subtitle1" sx={{ fontWeight: 600 }}>
            {label}
          </Typography>
          <ChevronRight fontSize="small" sx={{ color: "text.secondary" }} />
        </Stack>
        {count.loading ? (
          <Box sx={{ py: 0.75 }}>
            <CircularProgress size={24} aria-label={`Counting ${label.toLowerCase()}`} />
          </Box>
        ) : (
          <Typography
            component="p"
            variant="h1"
            className="tabular"
            sx={{ color: count.value === null ? "text.secondary" : "text.primary" }}
          >
            {count.value === null ? EM_DASH : count.value.toLocaleString("en-US")}
          </Typography>
        )}
        {count.error !== null ? (
          <Typography variant="body2" sx={{ color: "error.main" }}>
            Couldn't count {label.toLowerCase()}: {count.error}
          </Typography>
        ) : (
          caption !== null && (
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              {caption}
            </Typography>
          )
        )}
      </CardActionArea>
    </Card>
  );
}

function countOf<T>(
  loaded: { data: T | null; loading: boolean; error: string | null },
  count: (data: T) => number,
): Count {
  return {
    value: loaded.data === null || loaded.error !== null ? null : count(loaded.data),
    loading: loaded.loading,
    error: loaded.error,
  };
}

/** The three counts, each read from what its list page reads and narrowed by
 * the same rule, so a card and its list agree. */
function Counts({
  tenantId,
  userId,
  scope,
  setupOffered,
}: {
  tenantId: string;
  userId: string;
  scope: ListScope;
  setupOffered: boolean;
}) {
  const agents = useLoad(loadAgents);
  const rooms = useLoad(loadRooms);
  const loadMembers = useCallback(() => fetchMembers(tenantId), [tenantId]);
  const members = useLoad(loadMembers);
  const caption = scope === "yours" ? "Yours" : null;
  const roomsList = useRoomsListPath();
  // Get started ends with the person's first agent, as a first visit decides.
  const settingUp =
    setupOffered && agents.data !== null && !agents.data.some((agent) => agent.owner_id === userId);

  return (
    <Stack spacing={3}>
      {settingUp && (
        <Card variant="outlined" sx={{ p: 2.5 }}>
          <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 600 }}>
            Finish getting started
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            Meet switch-buddy, your first agent, and connect the AI provider it runs on.
          </Typography>
          <Button variant="contained" component={RouterLink} to={GET_STARTED}>
            Get started
          </Button>
        </Card>
      )}
      <Stack direction="row" useFlexGap sx={{ flexWrap: "wrap", gap: 3 }}>
        <CountCard
          label="Agents"
          to="/agents"
          caption={caption}
          count={countOf(agents, (data) => agentsInScope(data, scope, userId).length)}
        />
        <CountCard
          label="Users"
          to="/settings/users"
          caption={null}
          count={countOf(members, (data) => data.length)}
        />
        <CountCard
          label="Rooms"
          to={roomsList}
          caption={caption}
          count={countOf(rooms, (data) => roomsInScope(data, scope).length)}
        />
      </Stack>
    </Stack>
  );
}

/** Where the dashboard has chats, Console's Home: a chat with switch-buddy.
 * Elsewhere the workspace at a glance: how many agents, users and rooms it
 * has, or, for a member, how many agents and rooms are theirs. */
export default function OverviewPage() {
  const { session, capabilities } = useAuth();
  const web = useWebChats();
  const tenant = session?.tenant;
  if (!session || !tenant) return <CircularProgress />;
  const managementOffered = capabilities.features[AGENT_MANAGEMENT] === true;
  const setupOffered = capabilities.features[GATEWAY_ONBOARDING] === true && managementOffered;
  if (web) return <BuddyHome web={web} managementOffered={managementOffered} setupOffered={setupOffered} />;
  // A role can change while the page is open (the session is read again when
  // the tab comes back), and the server lists an admin rooms it hides from a
  // member, so the counts are read again under the new scope.
  const scope = listScopeOf(capabilities);

  return (
    <Box>
      <PageHeader
        sx={{ mb: 3 }}
        title={<Typography variant="h5">Home</Typography>}
        actions={
          <Button component={RouterLink} to="/ecosystem" variant="outlined" startIcon={<AccountTreeOutlined />}>
            View graph
          </Button>
        }
      />
      <Counts
        key={scope}
        tenantId={tenant.id}
        userId={session.user.id}
        scope={scope}
        setupOffered={setupOffered}
      />
    </Box>
  );
}
