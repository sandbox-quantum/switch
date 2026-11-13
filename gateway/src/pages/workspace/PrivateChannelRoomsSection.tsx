import { Alert, Button, Stack, Typography } from "@mui/material";
import { useCallback } from "react";
import { Link as RouterLink } from "react-router";
import { countPrivateChannelRooms } from "../../data/api";
import { useLoad } from "./useLoad";

/** One line on the workspace page when Public rooms sit on private channels,
 * leading to the review page. Shows nothing when there are none, or when the
 * count can't be read: it is a pointer, not the place to fix anything. */
export default function PrivateChannelRoomsSection({ tenantId }: { tenantId: string }) {
  const load = useCallback(() => countPrivateChannelRooms(tenantId), [tenantId]);
  const { data: count } = useLoad(load);
  if (!count) return null;

  return (
    <Stack spacing={1.5}>
      <Typography variant="h6">Room visibility</Typography>
      <Alert
        severity="warning"
        action={
          <Button
            color="inherit"
            size="small"
            component={RouterLink}
            to="/workspace/private-channel-rooms"
          >
            Review
          </Button>
        }
      >
        {count === 1
          ? "1 Public room is on a private channel, so everyone in the workspace can read it in Switch."
          : `${count} Public rooms are on private channels, so everyone in the workspace can read them in Switch.`}
      </Alert>
    </Stack>
  );
}
