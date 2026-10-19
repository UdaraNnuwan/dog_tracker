import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError, fetchMe, type Me } from "../api.js";
import { LoginPage } from "./LoginPage.js";
import { logout, useSession } from "./session.js";

type State =
  | { kind: "checking" }
  | { kind: "signedOut" }
  | { kind: "error"; message: string }
  | { kind: "ready"; me: Me };

/**
 * Shows the login page until `/api/auth/me` accepts us (ADR 0010). Local development with
 * LIVE_VIEW_UNAUTHENTICATED skips it: the Worker answers as the dev user.
 */
export function AuthGate({ children }: { children: (me: Me, signOut: () => void) => ReactNode }) {
  const session = useSession();
  const [state, setState] = useState<State>({ kind: "checking" });

  const check = useCallback(() => {
    fetchMe()
      .then((me) => setState({ kind: "ready", me }))
      .catch((err: unknown) =>
        setState(
          err instanceof ApiError && err.status === 401
            ? { kind: "signedOut" }
            : { kind: "error", message: String(err) },
        ),
      );
  }, []);

  // Re-check whenever the session appears/disappears (login, logout, failed refresh).
  useEffect(check, [check, session?.user.id]);

  if (state.kind === "checking") return <p className="muted notice">Loading…</p>;
  if (state.kind === "signedOut") return <LoginPage onSignedIn={check} />;
  if (state.kind === "error") {
    return (
      <main className="notice">
        <h2>Can't reach the server</h2>
        <p className="muted">{state.message}</p>
        <button type="button" onClick={check}>
          Try again
        </button>
      </main>
    );
  }
  return <>{children(state.me, logout)}</>;
}
