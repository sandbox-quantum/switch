import { Box, Button, Typography, useMediaQuery, useTheme } from "@mui/material";
import { useState } from "react";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import c from "react-syntax-highlighter/dist/esm/languages/prism/c";
import cpp from "react-syntax-highlighter/dist/esm/languages/prism/cpp";
import csharp from "react-syntax-highlighter/dist/esm/languages/prism/csharp";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import docker from "react-syntax-highlighter/dist/esm/languages/prism/docker";
import go from "react-syntax-highlighter/dist/esm/languages/prism/go";
import ini from "react-syntax-highlighter/dist/esm/languages/prism/ini";
import java from "react-syntax-highlighter/dist/esm/languages/prism/java";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import kotlin from "react-syntax-highlighter/dist/esm/languages/prism/kotlin";
import less from "react-syntax-highlighter/dist/esm/languages/prism/less";
import makefile from "react-syntax-highlighter/dist/esm/languages/prism/makefile";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import php from "react-syntax-highlighter/dist/esm/languages/prism/php";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import ruby from "react-syntax-highlighter/dist/esm/languages/prism/ruby";
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust";
import scss from "react-syntax-highlighter/dist/esm/languages/prism/scss";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import swift from "react-syntax-highlighter/dist/esm/languages/prism/swift";
import toml from "react-syntax-highlighter/dist/esm/languages/prism/toml";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { HIGHLIGHT_MAX_BYTES } from "./cloudFiles";
import { FileMarkdown } from "./FileMarkdown";
import { parseCsv, prettyJson } from "./previewFormat";

/**
 * The preview modal's bodies, one per kind of file. Everything a file holds is
 * React text: the highlighter turns code into a tree of React elements (never
 * HTML, and its grammars are bundled here, never fetched), CSV cells and JSON
 * are strings, and Markdown keeps `FileMarkdown`'s rules.
 */

const LANGUAGES = {
  bash, c, cpp, csharp, css, docker, go, ini, java, javascript, json, jsx, kotlin, less, makefile,
  markup, php, python, ruby, rust, scss, sql, swift, toml, tsx, typescript, yaml,
};
for (const [name, grammar] of Object.entries(LANGUAGES)) SyntaxHighlighter.registerLanguage(name, grammar);

function Note({ children }: { children: React.ReactNode }) {
  return (
    <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 1 }}>
      {children}
    </Typography>
  );
}

/** Text or code as React text in a `<pre>`, so nothing in it is ever markup. */
export function PlainText({ text }: { text: string }) {
  return (
    <Box component="pre" sx={{ m: 0, fontFamily: "monospace", fontSize: 13, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
      {text}
    </Box>
  );
}

/** Code with highlighting and line numbers, or plain text once it's too big to highlight quickly. */
export function CodeView({ text, language }: { text: string; language: string }) {
  // Long lines wrap by default on a phone, where they'd otherwise run off the right edge.
  const phone = useMediaQuery(useTheme().breakpoints.down("sm"));
  const [chosen, setChosen] = useState<boolean | null>(null);
  const wrap = chosen ?? phone;
  if (new TextEncoder().encode(text).length > HIGHLIGHT_MAX_BYTES)
    return (
      <>
        <Note>Shown without highlighting, because the file is large.</Note>
        <PlainText text={text} />
      </>
    );
  return (
    <Box sx={{ minWidth: 0 }}>
      <Box sx={{ display: "flex", justifyContent: "flex-end", mb: 1 }}>
        <Button size="small" variant={wrap ? "contained" : "outlined"} aria-pressed={wrap} onClick={() => setChosen(!wrap)}>
          Wrap lines
        </Button>
      </Box>
      <Box data-code-view="" data-language={language} sx={{ "& pre": { m: "0 !important", fontSize: "13px !important" } }}>
        <SyntaxHighlighter language={language} style={oneLight} showLineNumbers wrapLongLines={wrap}>
          {text}
        </SyntaxHighlighter>
      </Box>
    </Box>
  );
}

/** JSON laid out and highlighted, or plain text with a note when it doesn't parse. */
export function JsonView({ text }: { text: string }) {
  const pretty = prettyJson(text);
  if (pretty === null)
    return (
      <>
        <Note>This isn’t valid JSON.</Note>
        <PlainText text={text} />
      </>
    );
  return <CodeView text={pretty} language="json" />;
}

/** A CSV or TSV file as a table with a sticky header, capped in rows and columns. */
export function CsvView({ text, delimiter }: { text: string; delimiter: "," | "\t" }) {
  const table = parseCsv(text, delimiter);
  return (
    <Box sx={{ minWidth: 0 }}>
      {table.totalRows > table.rows.length && (
        <Note>
          Showing {table.rows.length.toLocaleString()} of {table.totalRows.toLocaleString()} rows. Download to see all.
        </Note>
      )}
      {table.moreColumns && <Note>Some columns aren’t shown. Download to see all.</Note>}
      <Box sx={{ maxHeight: "70vh", overflow: "auto", border: 1, borderColor: "divider", borderRadius: 1 }}>
        <Box component="table" sx={{ width: "100%", borderCollapse: "collapse", fontSize: 13, "& td, & th": { px: 1.5, py: 0.75, textAlign: "left", verticalAlign: "top", borderTop: 1, borderColor: "divider", whiteSpace: "pre-wrap" } }}>
          <Box component="thead" sx={{ position: "sticky", top: 0, bgcolor: "background.paper", "& th": { fontWeight: 600, borderTop: 0, borderBottom: 1, borderColor: "divider" } }}>
            <tr>
              {table.header.map((cell, index) => (
                <th key={index}>{cell}</th>
              ))}
            </tr>
          </Box>
          <tbody>
            {table.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, index) => (
                  <td key={index}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </Box>
      </Box>
    </Box>
  );
}

/** Markdown rendered with `FileMarkdown`'s rules, with a toggle to see its source. */
export function MarkdownView({ text }: { text: string }) {
  const [source, setSource] = useState(false);
  return (
    <Box sx={{ minWidth: 0 }}>
      <Box sx={{ display: "flex", justifyContent: "flex-end", mb: 1 }}>
        <Button size="small" variant="outlined" onClick={() => setSource((on) => !on)}>
          {source ? "Show formatted" : "Show source"}
        </Button>
      </Box>
      {source ? <PlainText text={text} /> : <FileMarkdown text={text} />}
    </Box>
  );
}

/**
 * A video from a Blob URL typed `video/mp4` or `video/webm`: the browser's own
 * player, with no autoplay, muted until the person turns sound on, and only
 * its metadata loaded up front. No poster or subtitle track comes from the file.
 */
export function VideoView({ url, label }: { url: string; label: string }) {
  return (
    <Box
      component="video"
      src={url}
      controls
      muted
      playsInline
      preload="metadata"
      aria-label={label}
      sx={{ display: "block", maxHeight: "70vh", maxWidth: "100%", mx: "auto", bgcolor: "common.black", borderRadius: 1 }}
    />
  );
}
