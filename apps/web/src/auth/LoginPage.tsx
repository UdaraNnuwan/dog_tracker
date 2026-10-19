import { useState, type FormEvent } from "react";
import { login, LoginError } from "./session.js";

/** Username + password sign-in (ADR 0010). Accounts are seeded with `pnpm seed:users`. */
export function LoginPage({ onSignedIn }: { onSignedIn: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
      onSignedIn();
    } catch (err) {
      setError(err instanceof LoginError ? err.message : "Could not reach the server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <form className="panel login-card" onSubmit={(e) => void submit(e)}>
        <h1>🐕 Smart Dog Collar</h1>
        <p className="muted small">Sign in to continue</p>
        <label>
          Username
          <input
            autoFocus
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && <p className="error small">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
