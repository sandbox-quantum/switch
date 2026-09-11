import { Alert, AlertTitle, Box } from "@mui/material";
import type { TemplateValidation } from "../../data/api";

/**
 * What the checker made of the document.
 *
 * Errors are shown as errors and warnings as warnings, but neither stops an
 * upload — the registry stores documents in shapes this server may not
 * understand, so the form reports and the person decides.
 */
export default function TemplateFindings({
  result,
  checking,
}: {
  result: TemplateValidation | null;
  checking: boolean;
}) {
  if (checking || result === null) return null;
  if (result.errors.length === 0 && result.warnings.length === 0) return null;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {result.errors.length > 0 && (
        <Alert severity="error">
          <AlertTitle>
            {result.errors.length === 1
              ? "This does not look like a valid template"
              : `${result.errors.length} problems with this template`}
          </AlertTitle>
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {result.errors.map((f, i) => (
              <li key={`${f.code}-${f.subject ?? i}`}>{f.message}</li>
            ))}
          </Box>
          You can still upload it — the registry stores documents it does not
          understand — but check this is what you meant.
        </Alert>
      )}
      {result.warnings.length > 0 && (
        <Alert severity="warning">
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {result.warnings.map((f, i) => (
              <li key={`${f.code}-${f.subject ?? i}`}>{f.message}</li>
            ))}
          </Box>
        </Alert>
      )}
    </Box>
  );
}
