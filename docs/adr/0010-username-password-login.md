# ADR 0010: Username + password login

- Status: Accepted (first part of phase 5; per-device roles still to come)
- Date: 2026-10-19

## Context

The dashboard went online (`dogtracker.udara-kasper.workers.dev`), but live data, history,
logs, commands and clearing were open only on localhost (ADR 0004, 0006, 0009). The owner wants
a plain username + password sign-in. CLAUDE.md already chose Supabase Auth with email +
password, no e-mail verification and admin-created users.

Considered: Cloudflare Access in front of the hostname (one-time e-mail PIN). It's quick, but
it isn't the username/password the owner asked for, and phase 5 needs Supabase Auth anyway.

## Decision

- **Supabase Auth, username → synthetic email.** `udara` signs in as
  `udara@users.dogtracker.local` (never mailed). Usernames are 3–32 of `a-z 0-9 . _ -`.
- **Seeded accounts, no public sign-up.** `pnpm seed:users` (`apps/worker/scripts/seed-users.ts`)
  creates or updates users from `name:password` arguments or `SEED_USERS` in `.env`, with
  `email_confirm: true` and a minimum password length of 8. It's idempotent: re-running sets the
  new password. Turn off "Allow new users to sign up" in Supabase.
- **The Worker does auth, the browser holds no Supabase key.**
  - `POST /api/auth/login {username, password}` returns `{accessToken, refreshToken, expiresAt, user}`.
  - `POST /api/auth/refresh {refreshToken}`.
  - `GET /api/auth/me`.

  The browser keeps the session in localStorage and refreshes it 60 s before expiry.
- **Every protected route verifies the token** (`devOnly` middleware) with Supabase
  `getClaims`. That check is local when the project uses asymmetric signing keys, otherwise a
  call to Supabase Auth. Results are cached for up to 60 s and never past `exp`. Tokens arrive
  as `Authorization: Bearer …`, or for the live WebSocket (where browsers can't send headers)
  as the subprotocol pair `dogtracker.bearer, <token>`; the handshake answers `dogtracker.bearer`.
- Local development without login stays as before: `LIVE_VIEW_UNAUTHENTICATED=true` plus a
  localhost hostname signs in as a `dev` user.

## Consequences

- Every signed-in user can see all devices and send commands. `device_members` roles
  (viewer/operator/owner), RLS-scoped reads and `audit_log` are the rest of phase 5.
- There is no in-app password reset: re-run `pnpm seed:users name:newpassword`.
- Login has no rate limit of its own; Supabase Auth's limits apply. Add a Worker-side limit
  before exposing the dashboard widely.
