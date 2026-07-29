import "@fontsource/space-grotesk/300.css";
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";
import "./theme/hoot.css";

import { CssBaseline, GlobalStyles, InitColorSchemeScript, ThemeProvider } from "@mui/material";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { registerMuiLicense } from "./muiLicense";
import { GLOBAL_STYLE } from "./theme/global-style";
import { APP_THEME } from "./theme/theme";

registerMuiLicense();

const theme = APP_THEME();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <InitColorSchemeScript attribute="data-mui-color-scheme" defaultMode="light" />
    <ThemeProvider theme={theme} disableTransitionOnChange noSsr defaultMode="light">
      <CssBaseline />
      <GlobalStyles styles={GLOBAL_STYLE} />
      <App />
    </ThemeProvider>
  </StrictMode>,
);
