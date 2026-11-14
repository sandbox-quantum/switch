import SearchOutlined from "@mui/icons-material/SearchOutlined";
import { Box, InputAdornment, Stack, TextField, Typography } from "@mui/material";
import { Fragment, type ReactNode, useMemo } from "react";
import { SCREEN_READER_ONLY } from "../screenReaderOnly";
import type { CatalogueConnector } from "./ConnectorCard";

/**
 * A search box, the page's own controls beside it, and the connectors two
 * to a row. The page narrows the list first (its own tabs or toggles) and
 * passes what is left; this only applies the search, so searching reads the
 * same way on every page that shows the catalogue.
 *
 * `comingSoon` lists the catalogue's entries nobody can connect yet. They
 * get a section of their own under the rest, so a long list of them never
 * pushes the ones people can use out of sight, and the same search covers
 * both.
 */
export default function CatalogueGrid<T extends CatalogueConnector>({
  connectors,
  comingSoon,
  query,
  onQueryChange,
  controls,
  emptyMessage,
  renderCard,
}: {
  connectors: T[];
  comingSoon?: T[];
  query: string;
  onQueryChange: (query: string) => void;
  controls?: ReactNode;
  /** Shown when nothing is left to show, worded by the page. */
  emptyMessage: string;
  renderCard: (connector: T) => ReactNode;
}) {
  const [visible, visibleSoon] = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const matches = (list: T[]) =>
      needle
        ? list.filter((connector) =>
            [connector.name, connector.category, connector.description]
              .join(" ")
              .toLocaleLowerCase()
              .includes(needle),
          )
        : list;
    return [matches(connectors), matches(comingSoon ?? [])];
  }, [connectors, comingSoon, query]);
  const total = connectors.length + (comingSoon?.length ?? 0);
  const shown = visible.length + visibleSoon.length;

  return (
    <>
      <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
        {controls}
        <TextField
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search by name or category"
          sx={{ flex: 1, minWidth: 0 }}
          slotProps={{
            htmlInput: { "aria-label": "Search connectors" },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchOutlined fontSize="small" />
                </InputAdornment>
              ),
            },
          }}
        />
      </Stack>
      {/* Announced as the search narrows the list, since the results change
          away from the field being typed in. */}
      <Box role="status" aria-live="polite">
        {shown === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 4 }}>
            {emptyMessage}
          </Typography>
        ) : (
          <Box sx={SCREEN_READER_ONLY}>{`${shown} of ${total} connectors`}</Box>
        )}
      </Box>
      {visible.length > 0 && visibleSoon.length > 0 && <SectionTitle id="catalogue-available" title="Available" count={visible.length} />}
      {visible.length > 0 && <Grid connectors={visible} renderCard={renderCard} />}
      {visibleSoon.length > 0 && (
        <Box component="section" aria-labelledby="catalogue-coming-soon" sx={{ mt: 2 }}>
          <SectionTitle id="catalogue-coming-soon" title="Coming soon" count={visibleSoon.length} />
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            Not available yet. They appear above once they can be connected.
          </Typography>
          <Grid connectors={visibleSoon} renderCard={renderCard} />
        </Box>
      )}
    </>
  );
}

function SectionTitle({ id, title, count }: { id: string; title: string; count: number }) {
  return (
    <Stack direction="row" spacing={1} sx={{ mt: 3, alignItems: "baseline" }}>
      <Typography id={id} variant="h6" component="h2" sx={{ fontSize: 16, fontWeight: 600 }}>
        {title}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {count}
      </Typography>
    </Stack>
  );
}

function Grid<T extends CatalogueConnector>({
  connectors,
  renderCard,
}: {
  connectors: T[];
  renderCard: (connector: T) => ReactNode;
}) {
  return (
    <Box sx={{ mt: 2.5, display: "grid", gap: 1.5, gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: "repeat(2, minmax(0, 1fr))" } }}>
      {connectors.map((connector) => (
        <Fragment key={connector.slug}>{renderCard(connector)}</Fragment>
      ))}
    </Box>
  );
}
