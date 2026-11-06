import { useContext, useState } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { ThemeContext } from '@renderer/lib/providers/theme-provider';
import { Button } from '@renderer/lib/ui/button';
import { HIGHLIGHT_MAX_BYTES } from '@shared/core/cloud-files/cloud-files';
import { FileMarkdown, FileText } from './file-markdown';
import { parseCsv, prettyJson } from './preview-format';

/**
 * The preview modal's bodies, one per kind of file. Everything a file holds is
 * shown as React text: the highlighter turns code into a tree of React
 * elements (never HTML), CSV cells and JSON are strings, and Markdown keeps
 * `FileMarkdown`'s rules (no raw HTML, images as alt text, `https:` links only).
 */

function Note({ children }: { children: React.ReactNode }) {
  return <p className="mb-2 text-xs text-foreground-muted">{children}</p>;
}

/** Code with highlighting and line numbers, or plain text once it's too big to highlight quickly. */
export function CodeView({ text, language }: { text: string; language: string }) {
  const [wrap, setWrap] = useState(false);
  const dark = useContext(ThemeContext)?.effectiveTheme === 'emdark';
  if (new TextEncoder().encode(text).length > HIGHLIGHT_MAX_BYTES)
    return (
      <>
        <Note>Shown without highlighting, because the file is large.</Note>
        <FileText text={text} />
      </>
    );
  return (
    <div className="min-w-0">
      <div className="mb-2 flex justify-end">
        <Button variant="ghost" size="xs" aria-pressed={wrap} onClick={() => setWrap((on) => !on)}>
          Wrap lines
        </Button>
      </div>
      <div data-code-view="" data-language={language}>
        <SyntaxHighlighter
          language={language}
          style={dark ? oneDark : oneLight}
          showLineNumbers
          wrapLongLines={wrap}
          PreTag="div"
          className="!my-0 !rounded-md !text-xs"
        >
          {text}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}

/** JSON laid out and highlighted, or plain text with a note when it doesn't parse. */
export function JsonView({ text }: { text: string }) {
  const pretty = prettyJson(text);
  if (pretty === null)
    return (
      <>
        <Note>This isn’t valid JSON.</Note>
        <FileText text={text} />
      </>
    );
  return <CodeView text={pretty} language="json" />;
}

/** A CSV or TSV file as a table with a sticky header, capped in rows and columns. */
export function CsvView({ text, delimiter }: { text: string; delimiter: ',' | '\t' }) {
  const table = parseCsv(text, delimiter);
  return (
    <div className="min-w-0">
      {table.totalRows > table.rows.length && (
        <Note>
          Showing {table.rows.length.toLocaleString()} of {table.totalRows.toLocaleString()} rows.
          Download to see all.
        </Note>
      )}
      {table.moreColumns && <Note>Some columns aren’t shown. Download to see all.</Note>}
      <div className="max-h-[70vh] overflow-auto rounded-md border border-border">
        <table className="w-full border-collapse text-left text-xs">
          <thead className="sticky top-0 bg-background-1">
            <tr>
              {table.header.map((cell, index) => (
                <th key={index} className="border-b border-border px-3 py-2 font-semibold">
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="border-t border-border">
                {row.map((cell, index) => (
                  <td key={index} className="px-3 py-1.5 align-top whitespace-pre-wrap">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Markdown rendered with `FileMarkdown`'s rules, with a toggle to see its source. */
export function MarkdownView({ text }: { text: string }) {
  const [source, setSource] = useState(false);
  return (
    <div className="min-w-0">
      <div className="mb-2 flex justify-end">
        <Button
          variant="ghost"
          size="xs"
          aria-pressed={source}
          onClick={() => setSource((on) => !on)}
        >
          Show source
        </Button>
      </div>
      {source ? <FileText text={text} /> : <FileMarkdown text={text} />}
    </div>
  );
}

/**
 * A video from a Blob URL typed `video/mp4` or `video/webm`: the browser's own
 * player, with no autoplay, muted until the person turns sound on, and only
 * its metadata loaded up front. No poster or subtitle track comes from the file.
 */
export function VideoView({ url, label }: { url: string; label: string }) {
  return (
    <video
      src={url}
      controls
      muted
      playsInline
      preload="metadata"
      aria-label={label}
      className="max-h-[70vh] max-w-full rounded-md border border-border bg-black"
    />
  );
}
