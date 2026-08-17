import iconRounded from '@/assets/images/switch-console/icon-rounded.png';

/**
 * The Switch Console mark, pre-rounded.
 *
 * The rounding is baked into the artwork rather than applied with a CSS radius:
 * the OS app icon is only rounded by the platform on macOS, so anywhere the app
 * draws its own icon it has to supply a shape that looks right on Windows and
 * Linux too (CHOO-2022).
 */
export function SwitchConsoleAppIcon({
  size = 64,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <img
      src={iconRounded}
      width={size}
      height={size}
      alt=""
      aria-hidden
      className={className}
      draggable={false}
    />
  );
}
