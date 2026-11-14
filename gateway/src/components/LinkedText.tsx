import { Link } from "@mui/material";

const ADDRESS = /(https:\/\/[^\s]+[^\s.,;:!?)])/;

/**
 * Text from the server shown with each https address in it as a link that
 * opens in a new tab. An address moves to its own line rather than breaking
 * at a hyphen, and breaks only where it is wider than the line.
 */
export default function LinkedText({ text }: { text: string }) {
  return (
    <>
      {text.split(ADDRESS).map((part, index) =>
        index % 2 === 1 ? (
          <Link
            key={index}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            sx={{
              display: "inline-block",
              maxWidth: "100%",
              overflowWrap: "anywhere",
            }}
          >
            {part}
          </Link>
        ) : (
          part
        ),
      )}
    </>
  );
}
