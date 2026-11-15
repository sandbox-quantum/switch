import OpenInNewOutlined from "@mui/icons-material/OpenInNewOutlined";
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Link,
} from "@mui/material";

/** Where someone without Switch Console is sent to get it (the same page
 * switch-core's link hand-off offers). */
export const GET_SWITCH_CONSOLE_URL =
  "https://docs.switchagents.ai/flintai/switch/getting-started/install-switch-console";

/**
 * Run a template: in Switch Console, where its inputs are filled in and its
 * agents are given somewhere to run. The browser cannot tell whether Console
 * is installed, and opening its link without it does nothing at all, so the
 * way to get it is offered beside the link rather than after a silent click.
 */
export default function RunInConsoleDialog({
  templateName,
  link,
  onClose,
}: {
  templateName: string;
  /** The Switch Console link that opens the template's Use form. */
  link: string;
  onClose: () => void;
}) {
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Run {templateName}</DialogTitle>
      <DialogContent>
        <DialogContentText>
          Templates run in Switch Console, where you fill in what the template asks for and
          choose where its agents run.
        </DialogContentText>
        <DialogContentText sx={{ mt: 2 }}>
          Don’t have Switch Console?{" "}
          <Link href={GET_SWITCH_CONSOLE_URL} target="_blank" rel="noreferrer">
            Get Switch Console
          </Link>
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          onClick={() => {
            window.location.assign(link);
            onClose();
          }}
          endIcon={<OpenInNewOutlined />}
        >
          Open in Switch Console
        </Button>
      </DialogActions>
    </Dialog>
  );
}
