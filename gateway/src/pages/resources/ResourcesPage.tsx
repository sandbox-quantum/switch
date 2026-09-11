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
import CreateTemplateDialog from "./CreateTemplateDialog";
import ReferenceTypesTab from "./ReferenceTypesTab";
import TemplatesTab from "./TemplatesTab";

// One list drives the tab bar, the URL parameter, the type and the create
// button's label. They belong together: a tab listed in one and missed in
// another renders a body nothing can navigate to, which compiles cleanly and
// is invisible until someone goes looking for the tab.
const TABS = [
  { value: "references", label: "References", newLabel: "New reference" },
  { value: "types", label: "Reference types", newLabel: "New reference type" },
  { value: "documents", label: "Documents", newLabel: "New document" },
  { value: "packages", label: "Packages", newLabel: "New package" },
  { value: "templates", label: "Templates", newLabel: "Upload template" },
] as const;

type ResourceTab = (typeof TABS)[number]["value"];

export default function ResourcesPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const active = TABS.find((t) => t.value === tabParam) ?? TABS[0];
  const tab: ResourceTab = active.value;
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

  const handleTemplateCreated = (id: string) => {
    setCreateOpen(false);
    setRefreshKey((k) => k + 1);
    navigate(`/resources/templates/${id}`);
  };

  const handleReferenceTypeCreated = () => {
    setCreateOpen(false);
    setRefreshKey((k) => k + 1);
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" mb={2}>
        <Typography variant="h5">Resources</Typography>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => setCreateOpen(true)}
        >
          {active.newLabel}
        </Button>
      </Stack>

      <Tabs
        value={tab}
        onChange={(_, v) => setTab(v as ResourceTab)}
        sx={{ mb: 2, borderBottom: 1, borderColor: "divider" }}
      >
        {TABS.map((t) => (
          <Tab key={t.value} label={t.label} value={t.value} />
        ))}
      </Tabs>

      <Box sx={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
        {tab === "references" && <ReferencesTab refreshKey={refreshKey} />}
        {tab === "types" && <ReferenceTypesTab refreshKey={refreshKey} />}
        {tab === "documents" && <DocumentsTab refreshKey={refreshKey} />}
        {tab === "packages" && <PackagesTab refreshKey={refreshKey} />}
        {tab === "templates" && <TemplatesTab refreshKey={refreshKey} />}
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
      {tab === "templates" && (
        <CreateTemplateDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreated={handleTemplateCreated}
        />
      )}
    </Box>
  );
}
