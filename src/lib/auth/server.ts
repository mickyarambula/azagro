/**
 * Self-hosted Better Auth for THIS app (server-only).
 *
 * Sign-in has two methods: Google (Better Auth's native `socialProviders`,
 * using this app's OWN Google OAuth client — no third-party broker) and local
 * email/password. To enable local email/password, flip the flag in
 * `./email-password` only (see auth skill).
 *
 * The app runs its own Better Auth at `/api/auth/*`, so the session cookie
 * stays on this app's own origin.
 *
 * Modes:
 *   - Configured (production, e.g. Vercel): the deployer sets `BETTER_AUTH_URL`
 *     (this app's public URL), `BETTER_AUTH_SECRET`, `DATABASE_URL` (Postgres),
 *     and — for Google sign-in — `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`
 *     (from Google Cloud Console, see the auth skill / AUDITORIA.md). Real
 *     sessions persist in Postgres.
 *   - Local dev (`npm run dev`, no `DATABASE_URL`): falls back to the app's
 *     embedded PGLite DB and an auto-generated, process-stable secret, so
 *     email/password works with zero setup. Google also works locally if you
 *     add `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` to a local `.env` file
 *     (see `.env.example`) — the same Google OAuth client can list both the
 *     production and `http://localhost:8080` redirect URIs.
 *   - Off (`VITE_AUTH_ENABLED=false`, the shipped default): no providers;
 *     `requireUserId` resolves a dev user with no database configured, and
 *     throws fail-closed once `DATABASE_URL` is set (see `verify.server.ts`).
 *
 * NEVER import this from client code — it pulls in `pg` + server-only Better
 * Auth internals. The client uses `@/lib/auth/client`; components read the
 * user via `@/lib/auth/use-current-user`; server functions get a verified id
 * via `@/lib/auth/middleware`.
 */
import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { getCookie } from "@tanstack/react-start/server";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { ensureDbReady, getPglite } from "../db";
import { emailAndPasswordEnabled } from "./email-password";
import { pgliteDialect } from "./pglite-dialect";

// Kick (and share) PGLite bootstrap as soon as the auth server module loads.
void ensureDbReady();

/**
 * Local-dev secret must outlive module reloads: PGLite (and its session rows)
 * is stored on `globalThis`, so an HMR re-eval of this file must NOT mint a
 * new signing secret or every existing session becomes invalid mid-dev.
 * Process restart clears both the secret and PGLite together.
 */
const globalAuthRef = globalThis as typeof globalThis & {
  __azagroAuthDevSecret__?: string;
};
function devAuthSecret(): string {
  globalAuthRef.__azagroAuthDevSecret__ ??= randomBytes(32).toString("hex");
  return globalAuthRef.__azagroAuthDevSecret__;
}

/** Read an env var, treating empty/whitespace as unset. */
const env = (key: string): string | undefined => {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
};

// Explicit off-switch. Set `VITE_AUTH_ENABLED=false` to force auth off
// everywhere (dev user). Unset or anything else means auth is on.
const authDisabled = env("VITE_AUTH_ENABLED") === "false";

// This app's own Google OAuth client (Google Cloud Console → Credentials).
// Real Google sign-in requires BOTH to be set; without them the Google button
// still renders but fails when clicked (email/password keeps working).
const googleClientId = env("GOOGLE_CLIENT_ID");
const googleClientSecret = env("GOOGLE_CLIENT_SECRET");
const googleConfigured = Boolean(googleClientId && googleClientSecret);

/**
 * True when SOME real sign-in method is active (auth is enforced, not the
 * dev-user fallback). Email/password is a real method on its own, so this
 * does not require Google to be configured.
 */
export const authConfigured = !authDisabled && (emailAndPasswordEnabled || googleConfigured);

// This app's own Better Auth origin. Deployed apps (Vercel, etc.) MUST set
// `BETTER_AUTH_URL` to their public URL (e.g. `https://azagro.vercel.app`) —
// without it, Better Auth falls back to the local dev origin and every
// deployed sign-in fails with "Invalid origin". Local `npm run dev` always
// runs on port 8080 (see `vite.config.ts`), so that's the fallback.
const explicitBaseURL = env("BETTER_AUTH_URL");
const LOCAL_DEV_ORIGINS: string[] = [
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "http://[::1]:8080",
];
const baseURL = explicitBaseURL ?? "http://localhost:8080";

// Origins Better Auth accepts on credentialed POSTs (sign-up/sign-in, etc.).
// Missing entries here surface as FORBIDDEN "Invalid origin". Local loopback
// variants are always trusted (email/password in dev never breaks); the
// production origin is trusted only once `BETTER_AUTH_URL` is set.
const trustedOrigins: string[] = explicitBaseURL
  ? [explicitBaseURL, ...LOCAL_DEV_ORIGINS]
  : LOCAL_DEV_ORIGINS;

const databaseUrl = env("DATABASE_URL");

// Real Postgres when `DATABASE_URL` is set (deployed apps), else the app's
// embedded PGLite (local dev) via a Kysely dialect — so Better Auth persists to
// the SAME DB as app data, including email/password users. Both use the Better
// Auth schema from `migrations/auth/0001_auth.sql`, copied into `migrations/`
// when the app turns sign-in on.
const database = databaseUrl
  ? new Pool({ connectionString: databaseUrl })
  : { dialect: pgliteDialect(() => getPglite()), type: "postgres" as const };

/** Session token cookie name. */
export const SESSION_TOKEN_COOKIE = "__Host-azagro-auth.session_token";

export const auth = betterAuth({
  baseURL,
  // Deployed apps set BETTER_AUTH_SECRET. Local dev: process-stable secret on
  // globalThis so HMR doesn't invalidate PGLite-backed sessions (see above).
  secret: env("BETTER_AUTH_SECRET") ?? devAuthSecret(),
  database,

  // CSRF / origin check for credentialed auth POSTs (email sign-up/sign-in, …).
  // See `trustedOrigins` construction above — must cover the production origin
  // AND local loopback variants, or clients get "Invalid origin".
  trustedOrigins,

  // Google sign-in with this app's OWN OAuth client — only registered when
  // both env vars are present, so an unconfigured deploy just omits the button
  // path server-side too (the client still renders it; clicking fails cleanly).
  ...(googleConfigured
    ? { socialProviders: { google: { clientId: googleClientId!, clientSecret: googleClientSecret! } } }
    : {}),

  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["google"],
      // Don't gate linking a Google identity onto the local user's
      // email-verified state — there's no manual verification flow here.
      requireLocalEmailVerified: false,
    },
  },

  // Cache the session in the short-lived signed `session_data` cookie so reads
  // (incl. the client's `/get-session`) skip the DB — this shrinks the "loading"
  // window and reduces auth flicker.
  session: { cookieCache: { enabled: true, maxAge: 300 } },

  // Local email/password — toggled only via `./email-password` (not a plugin).
  ...(emailAndPasswordEnabled ? { emailAndPassword: { enabled: true } } : {}),

  // `__Host-` prefixed cookies: the browser REFUSES any same-named cookie that
  // carries a `Domain` attribute, so `__Host-` requires Secure + Path=/ + no
  // Domain. Better Auth otherwise uses `__Secure-` (which permits Domain), so
  // we drop its auto prefix (`useSecureCookies: false`) and set Secure + the
  // names ourselves. (Browsers allow Secure cookies on `http://localhost`, so
  // local dev still works.)
  advanced: {
    useSecureCookies: false,
    defaultCookieAttributes: { secure: true, sameSite: "lax", path: "/" },
    cookies: {
      session_token: { name: SESSION_TOKEN_COOKIE },
      session_data: { name: "__Host-azagro-auth.session_data" },
      account_data: { name: "__Host-azagro-auth.account_data" },
      dont_remember: { name: "__Host-azagro-auth.dont_remember" },
    },
  },

  plugins: [
    // Accept `Authorization: Bearer <session-token>` as an alternative to the
    // cookie. The hook only fires when an Authorization header is present, so
    // the normal cookie path is unaffected.
    bearer(),

    // Bridges Better Auth's Set-Cookie into TanStack Start responses. MUST be
    // last so it runs after every other plugin's hooks.
    tanstackStartCookies(),
  ],
});

export function readSessionToken(): string | null {
  return getCookie(SESSION_TOKEN_COOKIE) ?? null;
}
