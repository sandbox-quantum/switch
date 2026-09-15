import { useEffect, useRef, useState } from "react";
import { type TemplateValidation, validateTemplate } from "../../data/api";

/**
 * Check a document as it is edited, debounced.
 *
 * Advisory throughout: the server accepts an upload whatever comes back, and a
 * check that cannot be reached must never be the reason a form refuses to
 * submit — so a failed request clears the findings rather than inventing one.
 */
export function useTemplateValidation(
  content: string,
  { enabled = true }: { enabled?: boolean } = {},
): { result: TemplateValidation | null; checking: boolean } {
  const [result, setResult] = useState<TemplateValidation | null>(null);
  const [checking, setChecking] = useState(false);
  // Only the newest request may write the result; a slow earlier one landing
  // late would otherwise describe a document that is no longer on screen.
  const latest = useRef(0);

  useEffect(() => {
    if (!enabled || content.trim().length === 0) {
      setResult(null);
      setChecking(false);
      return;
    }

    const token = ++latest.current;
    setChecking(true);
    const timer = setTimeout(() => {
      validateTemplate(content)
        .then((r) => {
          if (token === latest.current) setResult(r);
        })
        .catch(() => {
          if (token === latest.current) setResult(null);
        })
        .finally(() => {
          if (token === latest.current) setChecking(false);
        });
    }, 400);

    return () => clearTimeout(timer);
  }, [content, enabled]);

  return { result, checking };
}
