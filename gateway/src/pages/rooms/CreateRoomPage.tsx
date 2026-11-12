import {
  Box,
  IconButton,
  Paper,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import ArrowBack from "@mui/icons-material/ArrowBack";
import { useState } from "react";
import { useNavigate } from "react-router";
import RoomCreateFormBody from "./RoomCreateFormBody";
import RoomCreateYamlBody from "./RoomCreateYamlBody";

type CreateMode = "form" | "yaml";

export default function CreateRoomPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<CreateMode>("form");

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1} mb={2}>
        <IconButton onClick={() => navigate("/rooms")} size="small" aria-label="Back">
          <ArrowBack />
        </IconButton>
        <Typography variant="h5" sx={{ flexGrow: 1 }}>
          New room
        </Typography>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={mode}
          onChange={(_e, next) => {
            if (next) setMode(next);
          }}
        >
          <ToggleButton value="form">Form</ToggleButton>
          <ToggleButton value="yaml">YAML</ToggleButton>
        </ToggleButtonGroup>
      </Stack>

      <Paper variant="outlined" sx={{ borderRadius: 2, p: 3 }}>
        {mode === "form" ? <RoomCreateFormBody /> : <RoomCreateYamlBody />}
      </Paper>
    </Box>
  );
}
