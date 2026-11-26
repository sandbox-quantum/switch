import { useEffect, useState } from "react";
import { type LicenseText, fetchLicense } from "../../data/api";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The license Switch is offered under, as the server ships it. */
export function useLicenseText(): { license: LicenseText | null; error: string | null } {
  const [license, setLicense] = useState<LicenseText | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetchLicense().then(setLicense, (err: unknown) =>
      setError(`Couldn't load the license: ${message(err)}`),
    );
  }, []);
  return { license, error };
}

export function LicensePanel({ text }: { text: string }) {
  return (
    <pre
      tabIndex={0}
      aria-label="License text"
      className="max-h-[55vh] overflow-y-auto whitespace-pre-wrap rounded-xl border border-black/10 bg-white/80 p-6 font-mono text-xs leading-relaxed text-neutral-800 dark:border-white/10 dark:bg-black/30 dark:text-neutral-200"
    >
      {text}
    </pre>
  );
}
