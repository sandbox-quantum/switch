import { type MotionValue } from 'motion/react';
import { type ReactNode } from 'react';
import { AgentAvatar } from './AgentAvatar';
import lassyaAvatar from './assets/lassya.png';
import {
  type AgentKey,
  AVATARS,
  CHANNELS,
  MESSAGE_AREA,
  PALETTE,
  PANEL,
  PANEL_GLOW,
  ROWS,
  STACK_Y,
  type MessageRow,
} from './timeline';

/*
 * The workspace the agents step into: channel sidebar + message stack.
 *
 * Every row sits at its final coordinate inside one stack container, and the push-up is a
 * single `y` on that container clipped by the message area — so bottom-anchoring is just
 * arithmetic (a row that hasn't arrived is below the clip) and there is no height, layout
 * or reflow change anywhere in the piece.
 *
 * Each agent's avatar tile holds a real inlined agent, hidden until the free-flying clone
 * finishes its arc onto exactly these pixels. From that swap the agent belongs to the stack
 * rather than floating over it.
 *
 * No typing indicators: the avatar arriving IS the arrival signal, and dots after it are a
 * slower second beat saying the same thing.
 */

const FONT = "font-['Lato']";

interface ChannelRowProps {
  name: string;
  index: number;
  active: boolean;
}

function ChannelRow({ name, index, active }: ChannelRowProps) {
  return (
    <div
      className={`channel-${index} relative rounded-[8px] px-[12px] py-[6px]`}
      style={{ opacity: 0, transform: 'translateY(8px)' }}
    >
      {active && (
        <span
          className="channel-active-bg absolute inset-0 rounded-[8px]"
          style={{ backgroundColor: PALETTE.channelActive, opacity: 0 }}
        />
      )}
      <span
        className={`${FONT} relative`}
        style={{
          fontSize: 14,
          lineHeight: '20px',
          fontWeight: active ? 700 : 500,
          color: PALETTE.chatInk,
        }}
      >
        {name}
      </span>
    </div>
  );
}

interface MentionProps {
  agent: AgentKey;
  children: ReactNode;
}

function Mention({ agent, children }: MentionProps) {
  return (
    <span
      className={`mention-${agent} rounded-[4px] px-[3px]`}
      style={{
        backgroundColor: agent === 'writer' ? 'rgba(161,201,210,0)' : 'rgba(255,137,94,0)',
      }}
    >
      {children}
    </span>
  );
}

interface TextProps {
  children: ReactNode;
}

function AuthorName({ children }: TextProps) {
  return (
    <div
      className={FONT}
      style={{ fontSize: 14, lineHeight: '20px', fontWeight: 700, color: PALETTE.chatInk }}
    >
      {children}
    </div>
  );
}

function BodyLine({ children }: TextProps) {
  return (
    <div className={FONT} style={{ fontSize: 15, lineHeight: '22px', color: PALETTE.chatBody }}>
      {children}
    </div>
  );
}

interface RowProps {
  row: MessageRow;
  children: ReactNode;
}

function Row({ row, children }: RowProps) {
  return (
    <div
      className="absolute flex items-start gap-[16px]"
      style={{ left: 0, top: row.top - MESSAGE_AREA.top, width: MESSAGE_AREA.w }}
    >
      {children}
    </div>
  );
}

/*
 * Lassya's headshot, cropped to the same 40px block the agents get.
 *
 * The asset is 120x124 of solid WHITE with the portrait sitting as a 90x90 square at
 * (19,17). Dropped straight into a 40px tile that padding is invisible against the panel,
 * so her avatar read ~30px next to the agents' 40 — the same tile, three different sizes.
 * Scaling the 90x90 region up to fill the tile puts all three on the bigger size.
 *
 * `max-w-none` is load-bearing: Tailwind's preflight caps images at 100% of their box, which
 * would shrink the oversized image back down and undo the crop.
 */
const LASSYA_CROP = { x: 19, y: 17, size: 90, w: 120, h: 124 };

function LassyaAvatar() {
  const k = 40 / LASSYA_CROP.size;
  return (
    <div className="h-[40px] w-[40px] shrink-0 overflow-hidden rounded-[8px]">
      <img
        src={lassyaAvatar}
        alt=""
        className="max-w-none"
        style={{
          width: LASSYA_CROP.w * k,
          height: LASSYA_CROP.h * k,
          marginLeft: -LASSYA_CROP.x * k,
          marginTop: -LASSYA_CROP.y * k,
        }}
      />
    </div>
  );
}

/*
 * The agent's permanent home: a 40px tile with the inlined agent inset at exactly the size
 * and position the flying clone lands at, so the handoff is pixel-identical.
 */
interface AgentClockProps {
  agent: AgentKey;
  clock: MotionValue<number>;
}

function RowAvatar({ agent, clock }: AgentClockProps) {
  const box = AVATARS[agent].box * AVATARS[agent].ejectScale;
  return (
    <div
      className={`tile-${agent} relative h-[40px] w-[40px] shrink-0 rounded-[8px]`}
      style={{ backgroundColor: PALETTE.tile, opacity: 0 }}
    >
      <div
        className={`rowavatar-${agent} absolute`}
        style={{ left: (40 - box) / 2, top: (40 - box) / 2, width: box, height: box, opacity: 0 }}
      >
        <AgentAvatar agent={agent} clock={clock} />
      </div>
    </div>
  );
}

interface ChatPanelProps {
  clock: MotionValue<number>;
}

export function ChatPanel({ clock }: ChatPanelProps) {
  const [lassya, writer, builder] = ROWS;
  const textWidth = MESSAGE_AREA.w - 56; // 40px avatar + 16px gap

  return (
    <div
      className="chat-panel pointer-events-none absolute z-20 flex rounded-[16px]"
      style={{
        left: PANEL.left,
        top: PANEL.top,
        width: PANEL.w,
        height: PANEL.h,
        padding: PANEL.pad,
        gap: PANEL.gap,
        backgroundColor: PALETTE.panel,
        opacity: 0,
        transform: `translateY(${PANEL.riseY}px)`,
      }}
    >
      {/* channels */}
      <div className="flex shrink-0 flex-col gap-[2px]" style={{ width: PANEL.sidebarW }}>
        {CHANNELS.map((name, i) => (
          <ChannelRow key={name} name={name} index={i} active={i === 0} />
        ))}
      </div>

      {/* messages */}
      <div
        className="relative shrink-0 rounded-[16px]"
        style={{ width: PANEL.messageW, backgroundColor: PALETTE.surface }}
      >
        {/* the clip the push-up reads against — a row below it simply hasn't arrived yet */}
        <div
          className="absolute overflow-hidden"
          style={{
            left: PANEL.messagePad,
            top: PANEL.messagePad,
            width: MESSAGE_AREA.w,
            height: MESSAGE_AREA.h,
          }}
        >
          <div
            className="msg-stack absolute inset-0"
            style={{ transform: `translateY(${STACK_Y.closed}px)` }}
          >
            <Row row={lassya}>
              <div
                className="msg-lassya flex gap-[16px]"
                style={{ opacity: 0, transform: 'translateY(14px)' }}
              >
                <LassyaAvatar />
                <div style={{ width: textWidth }}>
                  <AuthorName>Lassya</AuthorName>
                  <BodyLine>
                    <Mention agent="writer">@writer</Mention>{' '}
                    <Mention agent="builder">@builder</Mention> can you help
                  </BodyLine>
                </div>
              </div>
            </Row>

            {[writer, builder].map((row) => {
              const agent = row.id;
              return (
                <Row key={agent} row={row}>
                  <RowAvatar agent={agent} clock={clock} />
                  <div style={{ width: textWidth }}>
                    <div
                      className={`msg-${agent}-0`}
                      style={{ opacity: 0, transform: 'translateY(14px)' }}
                    >
                      <AuthorName>{row.author}</AuthorName>
                      <BodyLine>{row.lines[0]}</BodyLine>
                    </div>
                    {row.lines[1] && (
                      <div
                        className={`msg-${agent}-1`}
                        style={{ opacity: 0, transform: 'translateY(14px)' }}
                      >
                        <BodyLine>{row.lines[1]}</BodyLine>
                      </div>
                    )}
                  </div>
                </Row>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/*
 * The surface glowing where the mark went in — the same power-up bloom the agents get, but
 * across the whole messaging UI and far more restrained.
 *
 * Two offset radial stops, one per agent colour, so the panel briefly takes on the colour of
 * the two things that just came out of it. Each stop fades to its OWN hue at zero alpha, not
 * to `transparent` — `transparent` is rgba(0,0,0,0) and would fringe the bloom grey.
 *
 * Rendered BEHIND the panel and inflated past its bounds, so what reads is a halo bleeding
 * out from the edges rather than a wash over the message text.
 */
export function PanelGlow() {
  const { bleed, blur } = PANEL_GLOW;
  return (
    <div
      className="panel-glow pointer-events-none absolute"
      style={{
        left: PANEL.left - bleed,
        top: PANEL.top - bleed,
        width: PANEL.w + bleed * 2,
        height: PANEL.h + bleed * 2,
        borderRadius: 16 + bleed,
        background: PANEL_GLOW.background,
        filter: `blur(${blur}px)`,
        zIndex: 15,
        opacity: 0,
        transform: 'scale(0.98)',
      }}
    />
  );
}
