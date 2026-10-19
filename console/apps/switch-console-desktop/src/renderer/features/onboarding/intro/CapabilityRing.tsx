import { Cable, Cpu, Goal, Hand, type LucideIcon, ShieldCheck } from 'lucide-react';
import { CHIPS, type ChipIcon, MARK, PALETTE } from './timeline';

/*
 * The five capability chips.
 *
 * Each chip keeps the radius Max hand-placed it at — the ring is deliberately irregular, and
 * a uniform radius flattens the composition. The orbit is therefore one rotation on the ring
 * container (which preserves every chip's own radius) rather than five independent arcs; each
 * chip then counter-rotates by the same angle so its label stays upright.
 *
 * Absorption translates the chip toward the ring centre *in the ring's rotating frame*, so
 * the straight pull is bent into a spiral by the orbit still running underneath it.
 */

const ICONS: Record<ChipIcon, LucideIcon> = { Cable, Cpu, Goal, Hand, ShieldCheck };

interface ChipVisualProps {
  label: string;
  icon: ChipIcon;
}

function ChipVisual({ label, icon }: ChipVisualProps) {
  const Icon = ICONS[icon];
  return (
    <div
      className="flex shrink-0 items-center gap-[8px] rounded-[16px] p-[16px] whitespace-nowrap"
      style={{
        backgroundColor: PALETTE.surface,
        color: PALETTE.ink, // the icon inherits this; lucide's `color` prop would write an
        // attribute, and a CSS variable does not resolve in one
        filter: `drop-shadow(0 1px 2px ${PALETTE.chipShadow})`,
      }}
    >
      <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
      <span
        className="font-['Space_Grotesk'] font-medium"
        style={{
          fontSize: 16,
          lineHeight: '23px',
          letterSpacing: '-0.32px',
          color: PALETTE.ink,
        }}
      >
        {label}
      </span>
    </div>
  );
}

export function CapabilityRing() {
  return (
    <div
      className="chip-orbit pointer-events-none absolute z-0"
      style={{ left: MARK.cx, top: MARK.cy, width: 0, height: 0, transform: 'rotate(0deg)' }}
    >
      {CHIPS.map((chip) => {
        const rad = (chip.angle * Math.PI) / 180;
        return (
          <div
            key={chip.id}
            // zero-size flex box: centres the chip exactly on its polar point, whatever its width
            className="absolute flex items-center justify-center"
            style={{
              left: chip.r * Math.cos(rad),
              top: chip.r * Math.sin(rad),
              width: 0,
              height: 0,
            }}
          >
            <div
              className={`chip-${chip.id} shrink-0`}
              style={{
                opacity: 0,
                transform: `translate(0px, 0px) scale(0) rotate(${chip.jitter}deg)`,
              }}
            >
              <div
                className={`chip-counter-${chip.id} shrink-0`}
                style={{ transform: 'rotate(0deg)' }}
              >
                <ChipVisual label={chip.label} icon={chip.icon} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
