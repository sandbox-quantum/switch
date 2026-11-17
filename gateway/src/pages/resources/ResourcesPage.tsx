import AddIcon from "@mui/icons-material/Add";
import { Box, Button, Stack, Tab, Tabs, Typography } from "@mui/material";
import { useState } from "react";
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router";
import CreateDocumentDialog from "./CreateDocumentDialog";
import CreatePackageDialog from "./CreatePackageDialog";
import CreateReferenceDialog from "./CreateReferenceDialog";
import CreateReferenceTypeDialog from "./CreateReferenceTypeDialog";
import DocumentsTab from "./DocumentsTab";
import PackagesTab from "./PackagesTab";
import ReferencesTab from "./ReferencesTab";
import ReferenceTypesTab from "./ReferenceTypesTab";

// One list drives the tab bar, the URL parameter, the type and the create
// button's label. They belong together: a tab listed in one and missed in
// another renders a body nothing can navigate to, which compiles cleanly and
// is invisible until someone goes looking for the tab.
const TABS = [
  { value: "references", label: "References", newLabel: "New reference" },
  { value: "types", label: "Reference types", newLabel: "New reference type" },
  { value: "documents", label: "Documents", newLabel: "New document" },
  { value: "packages", label: "Packages", newLabel: "New package" },
] as const;

type ResourceTab = (typeof TABS)[number]["value"];

/** References, their types, documents and packages. Templates, once a tab
 * here, are a page of their own; a link to the old tab is sent there. */
export default function ResourcesPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { hash } = useLocation();
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

  const handleReferenceTypeCreated = () => {
    setCreateOpen(false);
    setRefreshKey((k) => k + 1);
  };

  if (tabParam === "templates") {
    const rest = new URLSearchParams(searchParams);
    rest.delete("tab");
    const search = rest.toString();
    return (
      <Navigate
        to={{ pathname: "/templates", search: search === "" ? "" : `?${search}`, hash }}
        replace
      />
    );
  }

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
      </Box>

      {/* Mounted only while open: each dialog loads what it offers, which no
          one needs until they create something. */}
      {createOpen && tab === "references" && (
        <CreateReferenceDialog
          open
          onClose={() => setCreateOpen(false)}
          onCreated={handleReferenceCreated}
        />
      )}
      {createOpen && tab === "types" && (
        <CreateReferenceTypeDialog
          open
          onClose={() => setCreateOpen(false)}
          onCreated={handleReferenceTypeCreated}
        />
      )}
      {createOpen && tab === "documents" && (
        <CreateDocumentDialog
          open
          onClose={() => setCreateOpen(false)}
          onCreated={handleDocumentCreated}
        />
      )}
      {createOpen && tab === "packages" && (
        <CreatePackageDialog
          open
          onClose={() => setCreateOpen(false)}
          onCreated={handlePackageCreated}
        />
      )}
    </Box>
  );
}
