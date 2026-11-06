import { Box } from "@mui/material";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * A Markdown file from the person's cloud, rendered with nothing in it that can
 * run or fetch, by the same rules as Console: raw HTML is dropped (`skipHtml`,
 * and no `rehype-raw`), an image shows as its alt text only (so nothing is ever
 * requested), and only an `https:` link is a link, opening outside Switch with
 * `noopener`. `javascript:`, `data:`, `file:`, plain `http:` and relative links
 * are inert text.
 */

const HTTPS = /^https:\/\//i;

/** Whether a link in a cloud Markdown file may open: `https:` only. */
export function opensLink(href: unknown): href is string {
  return typeof href === "string" && HTTPS.test(href.trim());
}

const COMPONENTS: Components = {
  a: ({ href, children }) =>
    opensLink(href) ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <Box component="span" sx={{ textDecoration: "underline dotted" }}>
        {children}
      </Box>
    ),
  img: ({ alt }) => (
    <Box component="span" data-image-placeholder="" sx={{ color: "text.secondary" }}>
      {alt ? `[image: ${alt}]` : "[image]"}
    </Box>
  ),
};

export function FileMarkdown({ text }: { text: string }) {
  return (
    <Box
      sx={{
        minWidth: 0,
        typography: "body2",
        "& h1": { typography: "h5", mt: 0, mb: 2, pb: 1, borderBottom: 1, borderColor: "divider" },
        "& h2": { typography: "h6", mt: 3, mb: 1.5, pb: 1, borderBottom: 1, borderColor: "divider" },
        "& h3, & h4, & h5, & h6": { typography: "subtitle1", fontWeight: 600, mt: 2, mb: 1 },
        "& p": { mt: 0, mb: 1.5, lineHeight: 1.6 },
        "& ul, & ol": { mt: 0, mb: 1.5, pl: 3 },
        "& blockquote": { m: 0, mb: 1.5, pl: 2, borderLeft: 4, borderColor: "divider", color: "text.secondary" },
        "& code": { fontFamily: "monospace", fontSize: "0.85em", bgcolor: "action.hover", px: 0.5, borderRadius: 0.5 },
        "& pre": { p: 1.5, mb: 1.5, overflowX: "auto", bgcolor: "action.hover", borderRadius: 1 },
        "& pre code": { bgcolor: "transparent", p: 0 },
        "& table": { borderCollapse: "collapse", mb: 1.5 },
        "& th, & td": { border: 1, borderColor: "divider", px: 1.5, py: 1, textAlign: "left" },
        "& th": { fontWeight: 600 },
        "& hr": { border: 0, borderTop: 1, borderColor: "divider", my: 3 },
      }}
    >
      <Markdown remarkPlugins={[remarkGfm]} components={COMPONENTS} skipHtml>
        {text}
      </Markdown>
    </Box>
  );
}
