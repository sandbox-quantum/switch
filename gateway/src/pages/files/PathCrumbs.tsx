import ChevronRight from "@mui/icons-material/ChevronRight";
import { Link, Stack, Typography } from "@mui/material";
import { type CloudFileEntry, entryTitle, pathCrumbs } from "./cloudFiles";

/** Where you are: All files, then each folder (each opens it), then the open file's name if a file is open. */
export function PathCrumbs({
  path,
  rootEntries,
  onOpen,
  fileName,
}: {
  path: string;
  rootEntries: readonly CloudFileEntry[];
  onOpen: (path: string) => void;
  fileName?: string;
}) {
  const crumbs = pathCrumbs(path);
  const top = rootEntries.find((entry) => entry.name === crumbs[0]?.name);
  return (
    <Stack direction="row" alignItems="center" spacing={0.5} component="nav" aria-label="Folder path" sx={{ minWidth: 0 }}>
      <Link component="button" underline="hover" onClick={() => onOpen("")}>
        All files
      </Link>
      {crumbs.map((crumb, index) => (
        <Stack key={crumb.path} direction="row" alignItems="center" spacing={0.5} sx={{ minWidth: 0 }}>
          <ChevronRight fontSize="small" color="action" />
          <Link component="button" underline="hover" noWrap onClick={() => onOpen(crumb.path)}>
            {index === 0 && top ? entryTitle(top) : crumb.name}
          </Link>
        </Stack>
      ))}
      {fileName !== undefined && (
        <Stack direction="row" alignItems="center" spacing={0.5} sx={{ minWidth: 0 }}>
          <ChevronRight fontSize="small" color="action" />
          <Typography variant="subtitle2" noWrap aria-current="page">
            {fileName}
          </Typography>
        </Stack>
      )}
    </Stack>
  );
}
