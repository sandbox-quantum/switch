import { Alert } from "@switch-console/chat-ui/primitives/alert";
import { Button } from "@switch-console/chat-ui/primitives/button";
import { type ComponentProps, type ReactNode, useState } from "react";
import { useAuth } from "../../data/AuthContext";
import LinkNoticeBanner from "../../layout/LinkNoticeBanner";
import AuthLayout from "../auth/AuthLayout";

export default function CenteredCard({
  title,
  subtitle,
  width,
  children,
}: {
  title: string;
  subtitle: ReactNode;
  width?: ComponentProps<typeof AuthLayout>["width"];
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
    <AuthLayout
      heading={title}
      subheading={subtitle}
      width={width}
      footer={
        <div className="flex flex-col items-center gap-1">
          <span>{user ? `Signed in as ${user.email}` : ""}</span>
          <Button variant="ghost" size="sm" className="text-inherit" onClick={() => void signOut()}>
            Sign out
          </Button>
          {signOutError && (
            <Alert variant="destructive" className="break-words">
              {signOutError}
            </Alert>
          )}
        </div>
      }
    >
      <LinkNoticeBanner />
      {children}
    </AuthLayout>
  );
}
