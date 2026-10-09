import { useEffect, useRef } from 'react';

/**
 * Run `callback` when the component unmounts, with the latest one it was given.
 *
 * For work that has to happen however a component goes away. A registry
 * dialog is the case in point: the registry runs its `onClose` only for a
 * Close button the dialog draws, while X, Escape and a click outside close it
 * directly, and all four unmount it.
 */
export function useOnUnmount(callback: () => void): void {
  const latest = useRef(callback);
  useEffect(() => {
    latest.current = callback;
  });
  useEffect(() => () => latest.current(), []);
}
