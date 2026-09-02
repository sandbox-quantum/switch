import AddIcon from "@mui/icons-material/Add";
import { Box, Button, Stack, Tab, Tabs, Typography } from "@mui/material";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import CreateDocumentDialog from "./CreateDocumentDialog";
import CreatePackageDialog from "./CreatePackageDialog";
import CreateReferenceDialog from "./CreateReferenceDialog";
import CreateReferenceTypeDialog from "./CreateReferenceTypeDialog";
import DocumentsTab from "./DocumentsTab";
import PackagesTab from "./PackagesTab";
import ReferencesTab from "./ReferencesTab";
import ReferenceTypesTab from "./ReferenceTypesTab";

type ResourceTab = "references" | "types" | "documents" | "packages";

const NEW_LABELS: Record<ResourceTab, string> = {
  references: "New reference",
  types: "New reference type",
  documents: "New document",
  packages: "New package",
};

export default function ResourcesPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: ResourceTab =
    tabParam === "documents"
      ? "documents"
      : tabParam === "packages"
        ? "packages"
        : tabParam === "types"
          ? "types"
          : "references";
  const [createOpen, setCreateOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const setTab = (next: ResourceTab) => {
    const sp = new URLSearchParams(searchParams);
    sp.set("tab", next);
    setSearchParams(sp, { replace: true });
  };

  const handleReferenceCreated = (id: string) => {
    setCreateOpen(false);
    setRefreshKey((k) => k + 1);
    navigate(`/resources/references/${id}`);
  };

  const handleDocumentCreated = (id: string) => {
    setCreateOpen(false);
    setRefreshKey((k) => k + 1);
    navigate(`/resources/documents/${id}`);
  };

  const handlePackageCreated = (id: string) => {
    setCreateOpen(false);
    setRefreshKey((k) => k + 1);
    navigate(`/resources/packages/${id}`);
  };

  const handleReferenceTypeCreated = () => {
    setCreateOpen(false);
    setRefreshKey((k) => k + 1);
  };

  const newLabel = NEW_LABELS[tab];

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" mb={2}>
        <Typography variant="h5">Resources</Typography>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => setCreateOpen(true)}
        >
          {newLabel}
        </Button>
      </Stack>

      <Tabs
        value={tab}
        onChange={(_, v) => setTab(v as ResourceTab)}
        sx={{ mb: 2, borderBottom: 1, borderColor: "divider" }}
      >
        <Tab label="References" value="references" />
        <Tab label="Reference types" value="types" />
        <Tab label="Documents" value="documents" />
        <Tab label="Packages" value="packages" />
      </Tabs>

      <Box sx={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
        {tab === "references" && <ReferencesTab refreshKey={refreshKey} />}
        {tab === "types" && <ReferenceTypesTab refreshKey={refreshKey} />}
        {tab === "documents" && <DocumentsTab refreshKey={refreshKey} />}
        {tab === "packages" && <PackagesTab refreshKey={refreshKey} />}
      </Box>

      {tab === "references" && (
        <CreateReferenceDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreated={handleReferenceCreated}
        />
      )}
      {tab === "types" && (
        <CreateReferenceTypeDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreated={handleReferenceTypeCreated}
        />
      )}
      {tab === "documents" && (
        <CreateDocumentDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreated={handleDocumentCreated}
        />
      )}
      {tab === "packages" && (
        <CreatePackageDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreated={handlePackageCreated}
        />
      )}
    </Box>
  );
}
