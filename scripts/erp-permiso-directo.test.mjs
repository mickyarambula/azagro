// GRUPO ALTOS #26 (Decisión 74, 17-sep-2026): en directo/brokeraje, entregar
// FACTURA al cliente y hace nacer la deuda con el proveedor en el mismo acto
// (Decisión 29) — eso es facturar, y "deliver" (Decisión 48) no factura ni
// edita. deliverSale exige "sales: edit" además de "deliver", pero SOLO
// cuando la ruta del pedido es supplier/asr; en bodega propia nada cambia.
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

test("deliverSale trae route_kind antes de decidir el permiso, y el candado va DESPUÉS de conocerlo (no antes, no adivinado)", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "deliverSale");
  const iSelect = body.indexOf("coalesce(route_kind,'own') as route_kind from sales_orders");
  const iGate = body.indexOf('if (so[0].route_kind === "supplier" || so[0].route_kind === "asr")');
  assert.ok(iSelect !== -1 && iGate !== -1 && iSelect < iGate, "el candado lee route_kind del pedido, no lo supone");
  const iDeliver = body.indexOf('await assertCan(sql, context.userId, "sales", "deliver");');
  assert.ok(iDeliver !== -1 && iDeliver < iGate, "deliver se pide siempre, primero; edit solo si aplica");
});

test("cableado: la pantalla deshabilita 'Entregar y facturar (directo)' sin permiso de editar, y explica por qué", () => {
  const ui = src("src/routes/sales.$orderId.tsx");
  assert.ok(ui.includes("disabled={busy || (form.routeKind !== \"own\" && !canEdit)}"), "el botón se apaga sin edit, solo en directo/brokeraje");
  assert.ok(ui.includes("hace falta permiso para facturar (editar en Ventas). Pide que alguien con ese permiso confirme la entrega."), "el aviso dice qué falta y qué hacer");
  // Bodega propia no se toca: sigue con canDeliver solo.
  assert.ok(ui.includes('{canDeliver && state === "confirmed" && ('), "el botón lo ve quien tiene deliver; el candado de edit es aparte, solo en directo");
});

test("la Decisión 74 vive en DECISIONES.md con la consecuencia (quién puede confirmar en directo) y la regla 5f de CLAUDE.md la nombra", () => {
  assert.match(src("DECISIONES.md"), /DECISIÓN 74 — En directo\/brokeraje, «Entregar y facturar» exige el permiso de facturar/);
});
