/**
 * Creates or updates dashboard users (ADR 0010). Idempotent: an existing user gets the new
 * password. Run from the repo root:
 *
 *   pnpm seed:users                              # users from SEED_USERS in .env
 *   pnpm seed:users udara:S3cret-pass            # or name:password pairs as arguments
 *   pnpm seed:users --admin admin:S3cret-pass    # --admin marks the next pair as admin
 *
 * SEED_USERS format: `name:password` pairs separated by spaces, e.g. `admin:Pass-1234 udara:x…`.
 * SEED_ADMINS: usernames that get the admin role (every privilege), e.g. `admin`.
 * The role lives in `app_metadata.role`, which only the secret key can write. A user that isn't
 * listed as admin keeps whatever role it already has.
 * Needs SUPABASE_URL and SUPABASE_SECRET_KEY (the same .env the Worker uses).
 */
import { createClient } from "@supabase/supabase-js";
import { USERNAME_DOMAIN, usernameToEmail, type Role } from "../src/auth/username.js";

const MIN_PASSWORD = 8;

function parsePairs(items: string[]): { username: string; password: string }[] {
  return items.map((item) => {
    const i = item.indexOf(":");
    if (i <= 0) throw new Error(`"${item.split(":")[0]}…" must look like name:password`);
    const username = item.slice(0, i).trim().toLowerCase();
    const password = item.slice(i + 1);
    if (!usernameToEmail(username)) {
      throw new Error(
        `invalid username "${username}": 3-32 of a-z 0-9 . _ - (start with a letter/digit)`,
      );
    }
    if (password.length < MIN_PASSWORD) {
      throw new Error(`password for "${username}" must be at least ${MIN_PASSWORD} characters`);
    }
    return { username, password };
  });
}

async function main() {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!url || !key) throw new Error("set SUPABASE_URL and SUPABASE_SECRET_KEY in .env");

  const words = (text: string | undefined) => (text ?? "").split(/[\s,]+/).filter(Boolean);
  const admins = new Set(words(process.env.SEED_ADMINS).map((u) => u.toLowerCase()));
  const args: string[] = [];
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i]!;
    if (arg !== "--admin") {
      args.push(arg);
      continue;
    }
    const next = process.argv[++i];
    if (!next) throw new Error("--admin needs a name:password pair after it");
    admins.add(next.slice(0, next.indexOf(":")).trim().toLowerCase());
    args.push(next);
  }
  const source = args.length ? args : words(process.env.SEED_USERS);
  if (source.length === 0) {
    throw new Error("no users: pass name:password arguments or set SEED_USERS in .env");
  }
  const users = parsePairs(source);

  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  // Existing dashboard users by email (paged; dashboards have few users).
  const existing = new Map<string, string>();
  for (let page = 1; ; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listing users failed: ${error.message}`);
    for (const u of data.users)
      if (u.email?.endsWith(`@${USERNAME_DOMAIN}`)) existing.set(u.email, u.id);
    if (data.users.length < 200) break;
  }

  for (const { username, password } of users) {
    const email = usernameToEmail(username)!;
    const id = existing.get(email);
    const admin = admins.has(username);
    const role: Role = admin ? "admin" : "user";
    const { error } = id
      ? await db.auth.admin.updateUserById(id, {
          password,
          // Only promote here; never silently demote an existing admin.
          ...(admin ? { app_metadata: { role } } : {}),
        })
      : await db.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: { username },
          app_metadata: { role },
        });
    if (error) throw new Error(`${username}: ${error.message}`);
    console.log(`${id ? "updated" : "created"} ${username}${admin ? " (admin)" : ""}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
