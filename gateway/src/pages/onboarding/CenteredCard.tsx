import "@switch-console/chat-ui/theme.css";
import { Alert } from "@switch-console/chat-ui/primitives/alert";
import { Button } from "@switch-console/chat-ui/primitives/button";
import { type ReactNode, useState } from "react";
import { useAuth } from "../../data/AuthContext";
import LinkNoticeBanner from "../../layout/LinkNoticeBanner";

export default function CenteredCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: ReactNode;
  children: ReactNode;
}) {
  const { user, logout } = useAuth();
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const signOut = async () => {
    setSignOutError(null);
    try {
      await logout();
    } catch (err) {
      setSignOutError(`Couldn't sign out: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  return (
    <div className="flex min-h-screen items-center justify-center bg-background py-4">
      <div className="w-full max-w-md space-y-6 rounded-lg border border-border bg-background p-8 shadow-lg">
        <div>
          <h1 className="text-xl font-semibold text-foreground">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
        </div>
        <LinkNoticeBanner />
        {children}
        <div className="flex items-center justify-between pt-3 text-sm">
          <span className="truncate text-muted-foreground">
            {user ? `Signed in as ${user.email}` : ""}
          </span>
          <Button variant="ghost" size="sm" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
        {signOutError && (
          <Alert variant="destructive" className="mt-2 break-words">
            {signOutError}
          </Alert>
        )}
      </div>
    </div>
  );
}
