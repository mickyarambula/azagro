// GRUPO ALTOS #12-#17 (permisos y contexto), 17-sep-2026.
//
// #12: listNotifications exponía el digest completo de cartera a cualquier
// rol activo — getAlertDigest ya lo ocultaba (acl.credit), listNotifications
// no. #13: listCustomerPOs no validaba módulo ni cartera propia. #14: getOrder
// (el documento más visitado) no filtraba por cartera propia aunque listOrders
// sí. #15: listRequests/getRequest ignoraban por completo cartera propia.
// #16/#17: useAccess() llamado en la misma función que renderiza <AppShell>
// (que provee su contexto) siempre ve el valor por omisión — el selector de
// circuito nunca era editable ni para admin, y "+ Alta" no aparecía para nadie.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

function fnBody(source, name) {
  const markers = [`export const ${name} `, `export async function ${name}(`, `export function ${name}(`, `async function ${name}(`, `function ${name}(`];
  const start = markers.map((m) => source.indexOf(m)).find((i) => i !== -1);
  assert.notEqual(start, undefined, `No existe ${name}`);
  const rest = source.slice(start);
  const next = rest.slice(10).search(/\n(export )?(async )?function |\nexport const /);
  return next === -1 ? rest : rest.slice(0, next + 10);
}

test("#12: listNotifications aplica el mismo candado que getAlertDigest (acl.credit) — no solo status='active'", () => {
  const body = fnBody(src("src/lib/erp/alerts.ts"), "listNotifications");
  assert.ok(body.includes("const me = await activeMember(sql, context.userId);"));
  assert.ok(body.includes("and (${me.acl.credit} <> 'none' or kind <> 'due')"), "sin permiso de cartera, el digest de vencimientos no viaja");
});

test("#13: listCustomerPOs exige sales:view y filtra cartera propia, como listOrders/listQuotes", () => {
  const body = fnBody(src("src/lib/erp/cpo.ts"), "listCustomerPOs");
  assert.ok(body.includes('await assertCan(sql, context.userId, "sales", "view");'));
  assert.ok(body.includes("const me = await activeMember(sql, context.userId);"));
  assert.ok(body.includes("and (${me.own_only} = false or p.seller_id = ${context.userId} or p.seller_id is null)"));
});

test("#14: getOrder filtra cartera propia — con el id/URL, ya no se ve el pedido de otro vendedor", () => {
  const body = fnBody(src("src/lib/erp/orders.ts"), "getOrder");
  assert.ok(body.includes("const own = await activeMember(sql, context.userId);"));
  assert.ok(body.includes("and (${own.own_only} = false or exists (") && body.includes("select 1 from partners pp where pp.id = sales_orders.partner_id"), "candado por SQL, antes de que exista para quien no debe verlo");
});

test("#15: listRequests y getRequest filtran cartera propia, igual que listQuotes/listOrders", () => {
  const src2 = src("src/lib/erp/requests.ts");
  assert.equal((src2.match(/and \(\$\{me\.own_only\} = false or p\.seller_id = \$\{context\.userId\} or p\.seller_id is null\)/g) || []).length, 2, "una vez en listRequests, otra en getRequest");
});

test("#16 y #17: AccessGate resuelve useAccess() DENTRO de AppShell donde la misma función lo renderiza", () => {
  const gate = src("src/components/access-gate.tsx");
  assert.ok(gate.includes("export function AccessGate({ children }: { children: (access: AccessState) => ReactNode }) {"));
  const quotes = src("src/routes/quotes.tsx");
  assert.equal((quotes.match(/<AccessGate>/g) || []).length, 2, "los dos selectores de circuito");
  const products = src("src/routes/products.tsx");
  assert.ok(products.includes('can("products", "edit") && tab === "catalogo" && (')); 
  assert.ok(!products.includes('const canEdit = can("products", "edit");'), "ya no se calcula fuera de AppShell");
  const partners = src("src/routes/partners.tsx");
  assert.ok(partners.includes('can("partners", "edit") && ('));
  assert.ok(!partners.includes('const canEdit = can("partners", "edit");'), "ya no se calcula fuera de AppShell");
});
