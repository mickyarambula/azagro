import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import {
  fixSsrExports,
  patchSsrCycle,
  patchSsrFacade,
  patchSetCookieDestructure,
  SSR_REL_DIR,
} from "./fix-ssr-exports.mjs";

const FACADE = `import "../_runtime.mjs";
import { a as getRequest, c as server_exports, i as createServerFn, n as createMiddleware, o as getServerFnById, r as createServerEntry, s as server_default, t as TSS_SERVER_FUNCTION } from "./ssr2.mjs";
var __exportAll = (all) => all;
export { getServerFnById as a, __exportAll as c, createServerEntry, server_default as default, TSS_SERVER_FUNCTION as i, createMiddleware as n, getRequest as o, createServerFn as r, ssr_exports as s, server_exports as t };
`;

const SSR2 = `import "../_runtime.mjs";
import { c as __exportAll$1 } from "./ssr.mjs";
export const s = { fetch() { return new Response("ok"); } };
export const a = 1, c = {}, i = 2, n = 3, o = 4, r = 5, t = 6;
var server_exports = __exportAll$1({ setCookie: () => null });
export { s as default, server_exports };
`;

const RUNTIME = `export const r = (all) => {
  const target = {};
  for (const name in all) target[name] = all[name];
  return target;
};
`;

test("patchSsrFacade defines the missing ssr_exports namespace", () => {
  const next = patchSsrFacade(FACADE);
  assert.match(next, /var ssr_exports = \{ default: server_default \};/);
  assert.match(next, /ssr_exports as s/);
  assert.equal(patchSsrFacade(next), next);
});

test("patchSsrCycle retargets __exportAll away from the facade", () => {
  const next = patchSsrCycle(SSR2);
  assert.match(next, /from "\.\.\/_runtime\.mjs"/);
  assert.doesNotMatch(next, /from "\.\/ssr\.mjs"/);
  assert.equal(patchSsrCycle(next), next);
});

test("patchSetCookieDestructure is idempotent and skips missing setCookie", () => {
  const src = `const { setCookie } = await import("@tanstack/react-start/server");
setCookie("a", "b");`;
  const next = patchSetCookieDestructure(src);
  assert.match(next, /typeof _m\.setCookie === "function"/);
  assert.equal(patchSetCookieDestructure(next), next);
});

test("fixSsrExports patches the vercel SSR output and the module links", async () => {
  const root = mkdtempSync(join(tmpdir(), "ssr-exports-"));
  const dir = join(root, SSR_REL_DIR);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, ".."), { recursive: true });
  writeFileSync(join(dir, "ssr.mjs"), FACADE);
  writeFileSync(join(dir, "ssr2.mjs"), SSR2);
  writeFileSync(join(dir, "..", "_runtime.mjs"), RUNTIME);

  const first = fixSsrExports(root);
  assert.deepEqual(first.patched.sort(), ["ssr.mjs", "ssr2.mjs"]);
  const second = fixSsrExports(root);
  assert.deepEqual(second.patched, []);

  const href = pathToFileURL(join(dir, "ssr.mjs")).href;
  const mod = await import(href);
  const service = mod.s?.default || mod.s;
  assert.equal(typeof service.fetch, "function");
  const res = service.fetch();
  assert.equal(res.status, 200);
});
