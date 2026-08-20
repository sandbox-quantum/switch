import { Pencil, RotateCw, X } from 'lucide-react';
import { useState } from 'react';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { Input } from '@renderer/lib/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/lib/ui/popover';
import { SegmentedControl } from '@renderer/lib/ui/segmented-control';
import { cn } from '@renderer/utils/utils';
import { agentAvatarChoices } from '@shared/core/agents/agent-avatar';

type PickerTab = 'generated' | 'url';

const TABS: readonly { value: PickerTab; label: string }[] = [
  { value: 'generated', label: 'Generated' },
  { value: 'url', label: 'Image URL' },
];

/**
 * Choose an agent's picture (CHOO-2171): one of a set of generated bots, or a
 * link to an image of the reader's own.
 *
 * `iconUrl` is null when nothing has been chosen, and the agent then wears the
 * avatar its name generates — the state the ✕ returns to. A new agent does not
 * start there: it opens on a concrete random bot, since an unnamed agent has no
 * name to draw from.
 */
export function AgentIconPicker({
  name,
  iconUrl,
  onChange,
  size = 84,
  disabled = false,
}: {
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

  // An unnamed agent still needs something to seed the grid, or every tile is
  // the same bot drawn from the empty string.
  const seedName = name.trim() || 'agent';
  const choices = agentAvatarChoices(seedName, round);

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
        <AgentAvatar name={seedName} iconUrl={iconUrl} size={size} />
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
        <SegmentedControl
          value={tab}
          onChange={setTab}
          options={TABS}
          ariaLabel="How to choose the icon"
        />

        {tab === 'generated' ? (
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
                    <AgentAvatar name={seedName} iconUrl={choice} size={44} />
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-foreground-muted">
              {round === 0
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
              <AgentAvatar name={seedName} iconUrl={iconUrl} size={44} />
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
              {urlError ?? 'A direct link to a PNG or JPEG. It is cropped to a circle.'}
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
            Use the one from the name
          </button>
        )}
        {/* Why the picture is what it is. Without this the avatar appears to
            change arbitrarily as the name is typed. */}
        {iconUrl === null && (
          <p className="text-xs text-foreground-passive">
            Using the one from the name{name.trim() === '' ? '' : ` "${name.trim()}"`}.
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
