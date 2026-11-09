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
import { useAuth } from "../../data/AuthContext";
import { fetchMembers, loadAgents, loadRooms } from "../../data/api";
import { type ListScope, agentsInScope, listScopeOf, roomsInScope } from "../../data/listScope";
import { EM_DASH } from "../../theme/hootFormat";
import { useLoad } from "../workspace/useLoad";

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
}: {
  tenantId: string;
  userId: string;
  scope: ListScope;
}) {
  const agents = useLoad(loadAgents);
  const rooms = useLoad(loadRooms);
  const loadMembers = useCallback(() => fetchMembers(tenantId), [tenantId]);
  const members = useLoad(loadMembers);
  const caption = scope === "yours" ? "Yours" : null;

  return (
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
        to="/rooms"
        caption={caption}
        count={countOf(rooms, (data) => roomsInScope(data, scope).length)}
      />
    </Stack>
  );
}

/** The workspace at a glance: how many agents, users and rooms it has, or,
 * for a member, how many agents and rooms are theirs. */
export default function OverviewPage() {
  const { session, capabilities } = useAuth();
  const tenant = session?.tenant;
  if (!session || !tenant) return <CircularProgress />;
  // A role can change while the page is open (the session is read again when
  // the tab comes back), and the server lists an admin rooms it hides from a
  // member, so the counts are read again under the new scope.
  const scope = listScopeOf(capabilities);

  return (
    <Box>
      <Stack direction="row" alignItems="center" justifyContent="space-between" mb={3}>
        <Typography variant="h5">Overview</Typography>
        <Button
          component={RouterLink}
          to="/ecosystem"
          variant="outlined"
          startIcon={<AccountTreeOutlined />}
        >
          View graph
        </Button>
      </Stack>
      <Counts key={scope} tenantId={tenant.id} userId={session.user.id} scope={scope} />
    </Box>
  );
}
