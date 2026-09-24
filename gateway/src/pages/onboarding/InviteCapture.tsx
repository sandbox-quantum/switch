import { useEffect } from "react";
import { Navigate, useSearchParams } from "react-router";
import { useAuth } from "../../data/AuthContext";
import { storePendingInvite } from "../../data/sessionState";

/** `/invite?token=…`: keep the token for this tab and carry on. Signed out,
 * that is the login page, and the token waits through sign-in (including an
 * identity-provider round trip, which is why it is not kept in memory). */
export default function InviteCapture() {
  const [params] = useSearchParams();
  const { refresh } = useAuth();
  const token = params.get("token");

  useEffect(() => {
    if (token) {
      storePendingInvite(token);
      void refresh();
    }
  }, [token, refresh]);

  return <Navigate to="/" replace />;
}
