import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";
// @ts-expect-error JS plugin alongside the TS vite config
import { grokPwaPlugin } from "./scripts/grok-pwa-plugin.mjs";
// @ts-expect-error JS plugin alongside the TS vite config
import { appEnvPlugin } from "./scripts/app-env-plugin.mjs";
// @ts-expect-error JS plugin alongside the TS vite config
import { fixSsrExportsPlugin } from "./scripts/fix-ssr-exports.mjs";
import { isMigrationFile } from "./scripts/migration-plan.mjs";

/** The files `src/lib/db.ts` globs — same directory, same non-recursive scope. */
function hasGlobbedMigrations(root: string): boolean {
  try {
    return readdirSync(join(root, "migrations")).some(isMigrationFile);
  } catch {
    return false;
  }
}

/**
 * Finish PGLite bootstrap during dev-server setup (before traffic). Vite awaits
 * async `configureServer` hooks. Production: `src/lib/db` kicks `ensureDbReady`
 * on import.
 *
 * Do not await the migrate pass here: `getSql()` already shares the same
 * promise, so the first query waits, but HTML/JS can start transforming.
 */
function pgliteBootstrapPlugin(): Plugin {
  return {
    name: "app-builder:pglite-bootstrap",
    apply: "serve",
    async configureServer(server) {
      if (!hasGlobbedMigrations(server.config.root)) return;
      try {
        const mod = (await server.ssrLoadModule("/src/lib/db.ts")) as {
          ensureDbReady?: () => Promise<void>;
        };
        if (typeof mod.ensureDbReady === "function") {
          void mod.ensureDbReady().catch((err) => {
            console.error("[app-builder] DB bootstrap failed:", err);
          });
        }
      } catch (err) {
        console.error("[app-builder] DB bootstrap failed:", err);
        throw err;
      }
    },
  };
}

/**
 * Live-preview OAuth popup — handled HERE so the agent never has to create a
 * `/auth/popup` route (and cannot break it by scaffolding a React page that
 * paints the full app shell in the popup).
 *
 * `signIn` (client.ts) opens `/auth/popup?providerId=…` in a top-level window.
 * This middleware runs before TanStack Start, calls `handleAuthPopupRequest`,
 * and returns the 302 / completion HTML. Deployed apps do not use the popup
 * (full-page OAuth redirect), so `apply: "serve"` is enough.
 */
function authPopupPlugin(): Plugin {
  return {
    name: "app-builder:auth-popup",
    apply: "serve",
    configureServer(server) {
      // Register immediately (not in a returned post-hook) so we run BEFORE
      // TanStack Start / the SPA HTML fallback. A model-authored
      // `src/routes/auth/popup.tsx` React page must never win this path.
      server.middlewares.use(async (req, res, next) => {
        try {
          const rawUrl = req.url ?? "";
          const pathOnly = rawUrl.split("?", 1)[0] ?? "";
          if (pathOnly !== "/auth/popup") {
            next();
            return;
          }
          if ((req.method ?? "GET").toUpperCase() !== "GET") {
            res.statusCode = 405;
            res.setHeader("content-type", "text/plain; charset=utf-8");
            res.end("Method Not Allowed");
            return;
          }

          const host = String(
            req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost:8080",
          );
          const proto = String(
            req.headers["x-forwarded-proto"] ??
              ((req.socket as { encrypted?: boolean } | undefined)?.encrypted ? "https" : "http"),
          );
          const requestHeaders = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (value === undefined) continue;
            if (Array.isArray(value)) {
              for (const v of value) requestHeaders.append(key, v);
            } else {
              requestHeaders.set(key, value);
            }
          }
          // Ensure Host is the public preview host so Better Auth's dynamic
          // baseURL / redirect_uri match the popup origin.
          if (!requestHeaders.has("host")) requestHeaders.set("host", host);

          const request = new Request(`${proto}://${host}${rawUrl}`, {
            method: "GET",
            headers: requestHeaders,
          });

          const mod = (await server.ssrLoadModule("/src/lib/auth/popup.server.ts")) as {
            handleAuthPopupRequest: (req: Request) => Promise<Response>;
          };
          const response = await mod.handleAuthPopupRequest(request);

          res.statusCode = response.status;
          // Preserve multiple Set-Cookie headers (OAuth state + session).
          const setCookies =
            typeof response.headers.getSetCookie === "function"
              ? response.headers.getSetCookie()
              : [];
          response.headers.forEach((value, key) => {
            if (key.toLowerCase() === "set-cookie") return;
            res.setHeader(key, value);
          });
          for (const cookie of setCookies) {
            res.appendHeader("set-cookie", cookie);
          }
          const body = Buffer.from(await response.arrayBuffer());
          res.end(body);
        } catch (err) {
          console.error("[app-builder] /auth/popup handler failed:", err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("content-type", "text/plain; charset=utf-8");
            res.end("auth popup failed");
          }
        }
      });
    },
  };
}

/** PascalCase icon → lucide `dist/esm/icons/*.js` file (BarChart3 → bar-chart-3). */
export function lucideIconFile(name: string) {
  const file = name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z])([0-9])/g, "$1-$2")
    .toLowerCase();
  return `lucide-react/dist/esm/icons/${file}.js`;
}

/**
 * Named `lucide-react` imports pull the 1 MB barrel in Vite's dep optimizer.
 * Rewrite to per-icon ESM so the first page only loads the icons it draws.
 * Do not use `resolve.alias` for this — an alias object replaces `@/*` paths.
 */
export function rewriteLucideImports(code: string): string | null {
  if (!code.includes("lucide-react")) return null;
  const re = /import\s*\{([^}]+)\}\s*from\s*['"]lucide-react['"]\s*;?/g;
  let hit = false;
  const next = code.replace(re, (_m, inner: string) => {
    hit = true;
    const lines: string[] = [];
    for (const raw of inner.split(",")) {
      const spec = raw.replace(/\/\/.*$/, "").trim();
      if (!spec || spec.startsWith("type ")) continue;
      const [exported, alias] = spec.split(/\s+as\s+/).map((s) => s.trim());
      if (!exported || !/^[A-Za-z][A-Za-z0-9]*$/.test(exported)) continue;
      const local = alias || exported;
      lines.push(`import ${local} from "${lucideIconFile(exported)}";`);
    }
    return lines.join("\n");
  });
  return hit ? next : null;
}

function lucideDirectPlugin(): Plugin {
  return {
    name: "app-builder:lucide-direct",
    enforce: "pre",
    transform(code, id) {
      if (id.includes("node_modules")) return;
      if (!/\.[cm]?[jt]sx?$/.test(id.split("?", 1)[0] ?? "")) return;
      const next = rewriteLucideImports(code);
      if (!next) return;
      return { code: next, map: null };
    },
  };
}

const FIRST_CLIENT = [
  "./src/router.tsx",
  "./src/routeTree.gen.ts",
  "./src/routes/__root.tsx",
  "./src/routes/index.tsx",
  "./src/routes/login.tsx",
  "./src/components/app-shell.tsx",
  "./src/components/brand.tsx",
  "./src/components/erp.tsx",
  "./src/components/alerts-bell.tsx",
  "./src/lib/auth/provider.tsx",
  "./src/lib/auth/gates.tsx",
  "./src/lib/auth/client.ts",
  "./src/lib/auth/use-current-user.ts",
  "./src/lib/auth/middleware.ts",
  "./src/lib/nav.ts",
  "./src/lib/theme.ts",
  "./src/lib/utils.ts",
  "./src/lib/access.tsx",
  "./src/lib/error-component.tsx",
  "./src/lib/azagro.ts",
  "./src/lib/erp/acl.ts",
  "./src/lib/erp/alerts.ts",
  "./src/lib/erp/users.ts",
  "./src/styles.css",
];

const FIRST_SSR = [
  "./src/router.tsx",
  "./src/routeTree.gen.ts",
  "./src/routes/__root.tsx",
  "./src/routes/index.tsx",
  "./src/routes/login.tsx",
  "./src/lib/db.ts",
];

// `0.0.0.0:8080` is the live-preview contract — don't change host/port.
// The dev server starts once `src/router.tsx` and `src/routes/` exist — see
// AGENTS.md § "First scaffold".
export default defineConfig(({ command, isPreview }) => ({
  server: {
    host: "0.0.0.0",
    port: 8080,
    strictPort: true,
    warmup: {
      clientFiles: FIRST_CLIENT,
      ssrFiles: FIRST_SSR,
    },
  },
  optimizeDeps: {
    holdUntilCrawlEnd: false,
    // lucide-react barrel is excluded: lucideDirectPlugin rewrites to per-icon
    // files. Including the package here would still prebundle ~1 MB of icons.
    exclude: ["lucide-react"],
    include: [
      "react",
      "react-dom",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "clsx",
      "tailwind-merge",
      "zod",
      "@tanstack/react-router",
      "better-auth/react",
      "better-auth/client/plugins",
    ],
  },
  preview: {
    host: "127.0.0.1",
    port: 8081,
    strictPort: true,
  },
  resolve: { tsconfigPaths: true },
  plugins: [
    lucideDirectPlugin(),
    pgliteBootstrapPlugin(),
    // Before tanstackStart so /auth/popup never falls through to the SPA.
    authPopupPlugin(),
    // Dev-only /__app-env, read by scripts/check-auth-invariant.mjs.
    appEnvPlugin(),
    // PWA head + ?install=1 tutorial page; runs before Start/Nitro.
    grokPwaPlugin(),
    tailwindcss(),
    tanstackStart(),
    ...(command === "build" || isPreview
      ? [
          nitro({
            preset: "vercel",
            // Auto-registers server/middleware/* (the PWA install page +
            // manifest + head-tag middleware). Nitro v3 defaults serverDir to
            // false, so removing this silently unwires /?install=1 on deploys.
            serverDir: "./server",
          }),
          // Rolldown SSR facade re-exports undeclared `ssr_exports` (Nitro#4533).
          fixSsrExportsPlugin(),
        ]
      : []),
    viteReact(),
  ],
}));
