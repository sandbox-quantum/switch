import { Alert, Button, Stack, Typography } from "@mui/material";
import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Shows what broke when a page throws while it draws, instead of React
 * blanking the whole dashboard, with a way to load it again. Moving to
 * another page (`resetKey`) tries again.
 */
export default class PageErrorBoundary extends Component<
  { resetKey: string; children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("A dashboard page failed to draw:", error, info.componentStack);
  }

  componentDidUpdate(previous: { resetKey: string }): void {
    if (previous.resetKey !== this.props.resetKey && this.state.error !== null)
      this.setState({ error: null });
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <Stack spacing={2} sx={{ m: "auto", p: 4, maxWidth: 560 }}>
        <Typography variant="h6">This page could not be shown</Typography>
        <Alert severity="error">{error.message || String(error)}</Alert>
        <Button variant="contained" sx={{ alignSelf: "flex-start" }} onClick={() => window.location.reload()}>
          Load it again
        </Button>
      </Stack>
    );
  }
}
