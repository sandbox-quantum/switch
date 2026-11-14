import { openExternalUrl } from '@renderer/lib/open-external';

const ADDRESS = /(https:\/\/[^\s]+[^\s.,;:!?)])/;

/**
 * Text from the server with each https address in it as a link that opens in
 * the browser. An address moves to its own line rather than breaking at a
 * hyphen, and breaks only where it is wider than the line.
 */
export function LinkedText({ text }: { text: string }) {
  return (
    <>
      {text.split(ADDRESS).map((part, index) =>
        index % 2 === 1 ? (
          <a
            key={index}
            href={part}
            className="inline-block max-w-full [overflow-wrap:anywhere] underline underline-offset-2 hover:text-foreground"
            onClick={(event) => {
              event.preventDefault();
              void openExternalUrl(part, 'Could not open the link');
            }}
          >
            {part}
          </a>
        ) : (
          part
        )
      )}
    </>
  );
}
