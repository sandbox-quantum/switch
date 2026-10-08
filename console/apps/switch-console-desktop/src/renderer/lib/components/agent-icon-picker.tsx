import { useQuery } from '@tanstack/react-query';
import { Pencil, RotateCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useThirdPartyAvatarsEnabled } from '@renderer/lib/stores/use-avatar-settings';
import { Input } from '@renderer/lib/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/lib/ui/popover';
import { SegmentedControl } from '@renderer/lib/ui/segmented-control';
import { cn } from '@renderer/utils/utils';

type PickerTab = 'generated' | 'url';

const BOTH_TABS: readonly { value: PickerTab; label: string }[] = [
  { value: 'generated', label: 'Generated' },
  { value: 'url', label: 'Image URL' },
];

const URL_ONLY_TAB: readonly { value: PickerTab; label: string }[] = [
  { value: 'url', label: 'Image URL' },
];

/**
 * Choose an agent's picture (CHOO-2171): one of a set of generated avatars, or a
 * link to an image of the reader's own.
 *
 * `iconUrl` is null when nothing has been chosen, and the agent then wears the
 * avatar its name generates — the state the ✕ returns to. A new agent does not
 * start there: it opens on a concrete random avatar, since an unnamed agent has no
 * name to draw from.
 *
 * A server that disables third-party avatars (`THIRD_PARTY_AVATARS_ENABLED`)
 * offers neither of those — generating one sends the name to DiceBear, and
 * drawing from the name here but not on the server would disagree with what
 * Slack shows anyway — so the picker then offers only a link to an image of
 * the reader's own, with a line saying why the other option is missing rather
 * than just not there. While the server's setting is still unknown, the
 * Generated tab stays to avoid the layout jumping, but nothing is fetched for
 * it yet.
 */
export function AgentIconPicker({
  serverId,
  name,
  iconUrl,
  onChange,
  size = 84,
  disabled = false,
}: {
  /** The Switch server whose generated icons are offered. */
  serverId: string | null;
  /** The agent's name, which seeds the generated avatars. */
  name: string;
  /** The current choice, or null for "whatever the name generates". */
  iconUrl: string | null;
  onChange: (iconUrl: string | null) => void;
  /** Diameter of the avatar that opens the picker. */
  size?: number;
  disabled?: boolean;
}) {
  const [tab, setTab] = useState<PickerTab>('generated');
  const [round, setRound] = useState(0);
  const [urlDraft, setUrlDraft] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);

  const thirdPartyAvatarsEnabled = useThirdPartyAvatarsEnabled(serverId);
  // Hidden only once the server has actually said no — while it is still
  // unknown this stays up so the popover does not reflow a moment later, it
  // just offers nothing in it yet (see the query below).
  const generatedOffered = thirdPartyAvatarsEnabled !== false;
  const tabs = generatedOffered ? BOTH_TABS : URL_ONLY_TAB;

  // A reader left on the Generated tab when its server turns out to disable
  // it would be looking at a tab that no longer exists.
  useEffect(() => {
    if (!generatedOffered) setTab('url');
  }, [generatedOffered]);

  // An unnamed agent still needs something to seed the grid, or every tile is
  // the same face drawn from the empty string.
  const seedName = name.trim() || 'agent';
  // The server generates the icons on offer, so every client offers the same
  // ones and an agent created anywhere looks the same. Not asked at all until
  // the server has said it allows them: a server that disables them answers
  // this with an empty list anyway, but there is no reason to send the name
  // over the wire to be told that.
  const { data: choices = [], error: choicesError } = useQuery({
    queryKey: ['agent-icon-choices', serverId, seedName, round],
    queryFn: () =>
      rpc.switchServers
        .agentIconChoices({ serverId: serverId!, name: seedName, page: round })
        .then((result) => result.choices),
    enabled: serverId !== null && thirdPartyAvatarsEnabled === true,
    staleTime: Infinity,
  });

  const commitUrl = () => {
    const trimmed = urlDraft.trim();
    if (trimmed === '') {
      setUrlError(null);
      onChange(null);
      return;
    }
    if (!/^https:\/\/\S+$/i.test(trimmed)) {
      setUrlError('Must be a link starting with https://');
      return;
    }
    setUrlError(null);
    onChange(trimmed);
  };

  return (
    <Popover>
      <PopoverTrigger
        aria-label="Change the agent's icon"
        disabled={disabled}
        className={cn(
          'relative rounded-full transition-opacity',
          !disabled && 'cursor-pointer hover:opacity-80'
        )}
      >
        <AgentAvatar name={seedName} iconUrl={iconUrl} serverId={serverId} size={size} />
        {/* Shown at rest rather than on hover: that the picture is editable at
            all is not guessable, and a hover-only affordance answers the
            question only for someone who already suspected the answer. */}
        {!disabled ? (
          <span
            aria-hidden
            className="absolute right-0 bottom-0 flex size-6 items-center justify-center rounded-full border border-border bg-background text-foreground-muted shadow-sm"
          >
            <Pencil className="size-3" />
          </span>
        ) : null}
      </PopoverTrigger>

      <PopoverContent align="center" sideOffset={8} className="w-80 gap-3">
        {generatedOffered && (
          <SegmentedControl
            value={tab}
            onChange={setTab}
            options={tabs}
            ariaLabel="How to choose the icon"
          />
        )}

        {tab === 'generated' && generatedOffered ? (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-5 gap-2">
              {choices.map((choice) => {
                const selected = iconUrl === choice;
                return (
                  <button
                    key={choice}
                    type="button"
                    aria-label="Use this icon"
                    aria-pressed={selected}
                    onClick={() => onChange(choice)}
                    className={cn(
                      'flex cursor-pointer items-center justify-center rounded-full p-0.5 ring-2 transition-colors',
                      selected ? 'ring-border-focus' : 'ring-transparent hover:ring-border'
                    )}
                  >
                    <AgentAvatar name={seedName} iconUrl={choice} serverId={serverId} size={44} />
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-foreground-muted">
              {serverId === null
                ? 'Choose a Switch server to see the icons it offers.'
                : thirdPartyAvatarsEnabled === null
                  ? 'Checking what this server allows…'
                  : choicesError
                    ? `The server's icons could not be loaded: ${failureText(choicesError, 'try again')}`
                    : round === 0
                      ? "First is generated from the agent's name."
                      : 'Shuffled — keep going for more.'}
            </p>
            <button
              type="button"
              onClick={() => setRound((current) => current + 1)}
              className="flex cursor-pointer items-center justify-center gap-1.5 rounded-md border border-border py-1.5 text-xs hover:bg-background-tertiary"
            >
              <RotateCw className="size-3.5" />
              Show 9 more
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2.5 rounded-md bg-background-tertiary p-2.5">
              <AgentAvatar name={seedName} iconUrl={iconUrl} serverId={serverId} size={44} />
              <Input
                value={urlDraft}
                placeholder="https://example.com/avatar.png"
                onChange={(event) => setUrlDraft(event.target.value)}
                onBlur={commitUrl}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    commitUrl();
                  }
                }}
              />
            </div>
            {/* Named formats rather than "an image": the same link is handed to
                Slack and Discord for the agent's avatar there, and neither
                renders SVG, so a vector link works here and nowhere else. */}
            <p
              className={cn(
                'text-xs',
                urlError ? 'text-foreground-danger' : 'text-foreground-muted'
              )}
            >
              {urlError ??
                (generatedOffered
                  ? 'A direct link to a PNG or JPEG. It is cropped to a circle.'
                  : "This server doesn't generate icons from a name — paste a direct link to a PNG or JPEG instead. It is cropped to a circle.")}
            </p>
          </div>
        )}

        {iconUrl !== null && (
          <button
            type="button"
            onClick={() => {
              setUrlDraft('');
              setUrlError(null);
              onChange(null);
            }}
            className="flex cursor-pointer items-center gap-1.5 text-xs text-foreground-muted hover:text-foreground"
          >
            <X className="size-3.5" />
            {generatedOffered ? 'Use the one from the name' : 'Remove'}
          </button>
        )}
        {/* Why the picture is what it is. Without this the avatar appears to
            change arbitrarily as the name is typed. */}
        {iconUrl === null && (
          <p className="text-xs text-foreground-passive">
            {generatedOffered
              ? `Using the one from the name${name.trim() === '' ? '' : ` "${name.trim()}"`}.`
              : 'No icon set — shown by its initials.'}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
