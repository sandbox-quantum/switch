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
 */
export default function CatalogueGrid<T extends CatalogueConnector>({
  connectors,
  query,
  onQueryChange,
  controls,
  emptyMessage,
  renderCard,
}: {
  connectors: T[];
  query: string;
  onQueryChange: (query: string) => void;
  controls?: ReactNode;
  /** Shown when nothing is left to show, worded by the page. */
  emptyMessage: string;
  renderCard: (connector: T) => ReactNode;
}) {
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return connectors;
    return connectors.filter((connector) =>
      [connector.name, connector.category, connector.description].join(" ").toLocaleLowerCase().includes(needle),
    );
  }, [connectors, query]);

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
        {visible.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 4 }}>
            {emptyMessage}
          </Typography>
        ) : (
          <Box sx={SCREEN_READER_ONLY}>{`${visible.length} of ${connectors.length} connectors`}</Box>
        )}
      </Box>
      {visible.length > 0 && (
        <Box sx={{ mt: 2.5, display: "grid", gap: 1.5, gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: "repeat(2, minmax(0, 1fr))" } }}>
          {visible.map((connector) => (
            <Fragment key={connector.slug}>{renderCard(connector)}</Fragment>
          ))}
        </Box>
      )}
    </>
  );
}
