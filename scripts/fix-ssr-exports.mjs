/**
 * Nitro + Rolldown (Vite 8.2) emits an SSR facade that re-exports an undeclared
 * `ssr_exports` binding and a circular ssr.mjs ↔ ssr2.mjs import. `vite build`
 * exits 0; every request then 500s with:
 *
 *   SyntaxError: Export 'ssr_exports' is not defined in module
 *
 * Upstream: TanStack/router#8031, nitrojs/nitro#4533, rolldown/rolldown#10734.
 * Patch the Vercel function output after Nitro writes it. Idempotent.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SSR_REL_DIR = ".vercel/output/functions/__server.func/_ssr";

export function ssrOutputDir(root = process.cwd()) {
  return join(root, SSR_REL_DIR);
}

function localDefaultName(src) {
  const fromExport = src.match(/\b([A-Za-z_$][\w$]*)\s+as default\b/);
  if (fromExport) return fromExport[1];
  return "server_default";
}

export function patchSsrFacade(src) {
  if (!src.includes("ssr_exports as s")) return src;
  if (/^(?:var|let|const)\s+ssr_exports\b/m.test(src)) return src;
  const local = localDefaultName(src);
  return src.replace(
    /export \{([^}]*\bssr_exports as s\b[^}]*)\};/,
    `var ssr_exports = { default: ${local} };\nexport {$1};`,
  );
}

export function patchSsrCycle(src) {
  return src.replace(
    /import\s*\{\s*c as (__exportAll(?:\$\d+)?)\s*\}\s*from\s*["']\.\/ssr\.mjs["'];/,
    `import { r as $1 } from "../_runtime.mjs";`,
  );
}

export function patchSetCookieDestructure(src) {
  if (!src.includes('const { setCookie } = await import("@tanstack/react-start/server")')
    && !src.includes("const { setCookie } = await import('@tanstack/react-start/server')")) {
    return src;
  }
  return src.replace(
    /const\s*\{\s*setCookie\s*\}\s*=\s*await import\(["']@tanstack\/react-start\/server["']\);/g,
    `let setCookie; try { const _m = await import("@tanstack/react-start/server"); setCookie = _m && typeof _m.setCookie === "function" ? _m.setCookie : null; } catch { setCookie = null; } if (!setCookie) return;`,
  );
}

export function patchBetterAuthCookies(root = process.cwd()) {
  const p = join(root, "node_modules/better-auth/dist/integrations/tanstack-start.mjs");
  if (!existsSync(p)) return false;
  const orig = readFileSync(p, "utf8");
  const next = patchSetCookieDestructure(orig);
  if (next === orig) return false;
  writeFileSync(p, next);
  return true;
}

export function fixSsrExports(root = process.cwd()) {
  const patched = [];
  if (patchBetterAuthCookies(root)) patched.push("better-auth-cookies");

  const dir = ssrOutputDir(root);
  if (!existsSync(dir)) return { patched };

  const ssrPath = join(dir, "ssr.mjs");
  if (existsSync(ssrPath)) {
    const orig = readFileSync(ssrPath, "utf8");
    const next = patchSetCookieDestructure(patchSsrFacade(orig));
    if (next !== orig) {
      writeFileSync(ssrPath, next);
      patched.push("ssr.mjs");
    }
  }

  const ssr2Path = join(dir, "ssr2.mjs");
  if (existsSync(ssr2Path)) {
    const orig = readFileSync(ssr2Path, "utf8");
    const next = patchSetCookieDestructure(patchSsrCycle(orig));
    if (next !== orig) {
      writeFileSync(ssr2Path, next);
      patched.push("ssr2.mjs");
    }
  }

  return { patched };
}

export function fixSsrExportsPlugin() {
  return {
    name: "app-builder:fix-ssr-exports",
    buildStart() {
      patchBetterAuthCookies();
    },
    configureServer() {
      patchBetterAuthCookies();
    },
    closeBundle: {
      sequential: true,
      order: "post",
      handler() {
        const { patched } = fixSsrExports();
        if (patched.length) {
          console.log(`[app-builder] patched SSR facade (${patched.join(", ")})`);
        }
      },
    },
  };
}

const isCli =
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isCli) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const { patched } = fixSsrExports(root);
  if (patched.length) {
    console.log(`patched ${patched.join(", ")}`);
  } else {
    console.log("SSR facade already valid (or output missing)");
  }
}
