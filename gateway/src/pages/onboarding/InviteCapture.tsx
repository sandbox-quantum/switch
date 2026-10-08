import { useEffect } from "react";
import { Navigate, useLocation } from "react-router";
import { useAuth } from "../../data/AuthContext";
import { inviteTokenFromHash, storePendingInvite } from "../../data/sessionState";

/** `/invite#token=…`: keep the token for this tab and carry on. Signed out,
 * that is the login page, and the token waits through sign-in (including an
 * identity-provider round trip, which is why it is not kept in memory). */
export default function InviteCapture() {
  const { hash } = useLocation();
  const { refresh } = useAuth();
  const token = inviteTokenFromHash(hash);

  useEffect(() => {
    if (token) {
      storePendingInvite(token);
      void refresh();
    }
  }, [token, refresh]);

  return <Navigate to="/" replace />;
}
