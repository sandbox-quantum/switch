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
 * Hand something over to Switch Console: using a template, where its inputs
 * are filled in and its agents are given somewhere to run, or making one.
 * The browser cannot tell whether Console is installed, and opening its link
 * without it does nothing at all, so the way to get it is offered beside the
 * link rather than after a silent click.
 */
export default function OpenInConsoleDialog({
  title,
  description,
  link,
  onClose,
}: {
  title: string;
  /** What happens in Switch Console once it opens. */
  description: string;
  /** The Switch Console link to open. */
  link: string;
  onClose: () => void;
}) {
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <DialogContentText>{description}</DialogContentText>
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

/** Using a template: the same words wherever it is offered. */
export function UseInConsoleDialog({
  templateName,
  link,
  onClose,
}: {
  templateName: string;
  link: string;
  onClose: () => void;
}) {
  return (
    <OpenInConsoleDialog
      title={`Use ${templateName}`}
      description="Templates are used in Switch Console, where you fill in what the template asks for and choose where its agents run."
      link={link}
      onClose={onClose}
    />
  );
}
