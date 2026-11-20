/** Browser storage is optional for navigation. A privacy policy can block
 * even the storage getter, and a full quota can block individual writes. */
export function withBrowserStorage<T>(
  area: "localStorage" | "sessionStorage",
  use: (storage: Storage) => T,
): T | undefined {
  try {
    return use(window[area]);
  } catch (error) {
    if (error instanceof DOMException && ["SecurityError", "QuotaExceededError"].includes(error.name)) {
      return undefined;
    }
    throw error;
  }
}
