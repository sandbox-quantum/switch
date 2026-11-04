import { useEffect } from "react";
import { useAuth } from "../../../data/AuthContext";

/** On a 401, ask the app to check the session again. If it has ended, the
 *  app's own routing sends the person to sign-in, the same as on every other
 *  Switch web page. */
export function useSignedOut(signedOut: boolean): void {
  const { refresh } = useAuth();
  useEffect(() => {
    if (signedOut) void refresh();
  }, [signedOut, refresh]);
}
