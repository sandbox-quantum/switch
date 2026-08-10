import { useId } from 'react';
import {
  LOGO_FONT_FAMILY,
  LOGO_TEXT,
  NATURAL_HEIGHT,
  NATURAL_WIDTH,
} from '@renderer/lib/switch-console-logo';

export function SwitchConsoleShimmerLogo({
  className,
  height = NATURAL_HEIGHT,
  color = 'currentColor',
  shimmerColor = 'white',
}: {
  className?: string;
  height?: number;
  color?: string;
  shimmerColor?: string;
}) {
  const uid = useId();
  const gradientId = `logo-shimmer-${uid.replace(/:/g, '')}`;
  const width = (height / NATURAL_HEIGHT) * NATURAL_WIDTH;
  const prefersReduced =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sweep = NATURAL_WIDTH * 2;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${NATURAL_WIDTH} ${NATURAL_HEIGHT}`}
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1={-NATURAL_WIDTH}
          y1="-144"
          x2="0"
          y2="144"
        >
          <stop offset="0%" stopColor={color} stopOpacity="1" />
          <stop offset="25%" stopColor={color} stopOpacity="1" />
          <stop offset="50%" stopColor={shimmerColor} stopOpacity="1" />
          <stop offset="75%" stopColor={color} stopOpacity="1" />
          <stop offset="100%" stopColor={color} stopOpacity="1" />
          {!prefersReduced && (
            <animateTransform
              attributeName="gradientTransform"
              type="translate"
              values={`0 0; ${sweep} 0; ${sweep} 0`}
              keyTimes="0; 0.9; 1"
              dur="7s"
              repeatCount="indefinite"
            />
          )}
        </linearGradient>
      </defs>
      <text
        x={NATURAL_WIDTH / 2}
        y="50"
        textAnchor="middle"
        fontFamily={LOGO_FONT_FAMILY}
        fontSize="52"
        fontWeight="700"
        letterSpacing="-1.5"
        fill={`url(#${gradientId})`}
      >
        {LOGO_TEXT}
      </text>
    </svg>
  );
}
