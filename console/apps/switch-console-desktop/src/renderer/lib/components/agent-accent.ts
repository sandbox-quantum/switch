import { useEffect, useState } from 'react';
import { useThirdPartyAvatarsEnabled } from '@renderer/lib/stores/use-avatar-settings';
import { pickAccent } from '@renderer/utils/pick-accent';
import { agentAvatarSrc } from './agent-avatar';

const SAMPLE_PX = 24;

/** By image source, shared while pending so many badges for one agent load it once; failures cached too. */
const accents = new Map<string, Promise<string | null>>();
const settled = new Map<string, string | null>();

function sampleAccent(src: string): Promise<string | null> {
  let pending = accents.get(src);
  if (!pending) {
    pending = new Promise<string | null>((resolve) => {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = SAMPLE_PX;
          const context = canvas.getContext('2d')!;
          context.drawImage(image, 0, 0, SAMPLE_PX, SAMPLE_PX);
          const rgb = pickAccent(context.getImageData(0, 0, SAMPLE_PX, SAMPLE_PX).data);
          resolve(rgb ? `rgb(${rgb.join(' ')})` : null);
        } catch {
          // A host without CORS taints the canvas: the badge keeps its neutral colour.
          resolve(null);
        }
      };
      image.onerror = () => resolve(null);
      image.src = src;
    }).then((accent) => {
      settled.set(src, accent);
      return accent;
    });
    accents.set(src, pending);
  }
  return pending;
}

/** The main colour of an agent's avatar, from the same source the avatar shows; null for none or not yet known. */
export function useAgentAccent(
  agent: { name: string; iconUrl: string | null } | null,
  serverId: string | null
): string | null {
  const thirdParty = useThirdPartyAvatarsEnabled(serverId);
  const src = agent ? agentAvatarSrc(agent.iconUrl, agent.name, thirdParty) : null;
  const [loaded, setLoaded] = useState<{ src: string; accent: string | null } | null>(null);
  useEffect(() => {
    if (!src || settled.has(src)) return;
    let live = true;
    void sampleAccent(src).then((accent) => {
      if (live) setLoaded({ src, accent });
    });
    return () => {
      live = false;
    };
  }, [src]);
  if (!src) return null;
  return settled.get(src) ?? (loaded?.src === src ? loaded.accent : null);
}
