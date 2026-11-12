import AddIcon from "@mui/icons-material/Add";
import { Box, Button, Stack, Typography } from "@mui/material";
import { useState } from "react";
import { useNavigate } from "react-router";
import CreateTemplateDialog from "../resources/CreateTemplateDialog";
import TemplatesTab from "../resources/TemplatesTab";

/** Templates as a page of its own, in the new layout: today's list and
 * upload, out of the Resources tabs. */
export default function TemplatesPage() {
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" mb={2}>
        <Typography variant="h5">Templates</Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setCreateOpen(true)}>
          Upload template
        </Button>
      </Stack>
      <Box sx={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
        <TemplatesTab refreshKey={refreshKey} />
      </Box>
      <CreateTemplateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => {
          setCreateOpen(false);
          setRefreshKey((k) => k + 1);
          navigate(`/templates/${id}`);
        }}
      />
    </Box>
  );
}
