// BLOQUE DE PARCIALES, paso 3.1 (Decisión 48, camino (a) de ESTADO.md H4e):
// nace el nivel "deliver" ("solo entregar") — almacén entrega, recibe y
// devuelve, pero NO factura ni edita el pedido.
//
// Por texto (fnBody/.includes), como todas las pruebas de acl.ts/azagro.ts.
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

test("AclLevel gana el nivel deliver, entre view y edit", () => {
  const acl = src("src/lib/erp/acl.ts");
  assert.ok(acl.includes('export type AclLevel = "none" | "view" | "deliver" | "edit";'));
});

test("assertCan: need=deliver pasa con deliver o edit; need=edit sigue exigiendo edit estricto", () => {
  const body = fnBody(src("src/lib/erp/acl.ts"), "assertCan");
  assert.ok(body.includes('if (need === "deliver" && have !== "deliver" && have !== "edit")'), "deliver: deliver o edit");
  assert.ok(body.includes('if (need === "edit" && have !== "edit")'), "edit: solo edit (almacén no factura ni edita)");
  assert.match(body, /sin permiso de entregar\/recibir/, "el rechazo lo dice en bitácora");
});

test("can() del cliente: misma regla que el servidor", () => {
  const shell = src("src/components/app-shell.tsx");
  assert.ok(shell.includes('if (need === "deliver") return have === "deliver" || have === "edit";'));
});

test("plantilla de almacén: sales y purchases en deliver, no en edit", () => {
  const acl = src("src/lib/erp/acl.ts");
  const start = acl.indexOf('if (role === "almacen") {');
  const block = acl.slice(start, start + 500);
  assert.ok(block.includes('sales: "deliver"'), "ventas: solo entregar");
  assert.ok(block.includes('purchases: "deliver"'), "compras: solo recibir");
  assert.ok(block.includes('inventory: "edit"'), "inventario sigue completo (traslados, ajustes)");
});

test("los tres movimientos de mercancía exigen deliver (edit lo incluye); facturar y editar el pedido siguen en edit", () => {
  const az = src("src/lib/azagro.ts");
  for (const fn of ["receivePurchase", "returnSale"]) {
    const body = fnBody(az, fn);
    assert.ok(body.includes(`"deliver")`), `${fn} pide deliver`);
    assert.ok(!body.includes('"sales", "edit")') && !body.includes('"purchases", "edit")'), `${fn} ya no pide edit`);
  }
  assert.ok(fnBody(az, "createSale").includes('"sales", "edit")'), "crear pedido: edit");
  assert.ok(fnBody(az, "createPurchase").includes('"purchases", "edit")'), "crear OC: edit");
  const orders = src("src/lib/erp/orders.ts");
  assert.ok(fnBody(orders, "changeOrderTerm").includes('"sales", "edit")'), "cambiar plazo (dinero): edit");
});

// Decisión 74 (17-sep-2026, con OK del dueño — hallazgo #26): en directo/
// brokeraje entregar FACTURA en el mismo acto (Decisión 29); eso ya no es
// "solo mover mercancía" y deliverSale pide edit para esa rama. En bodega
// propia sigue exigiendo solo deliver: la FV se emite después (invoiceDelivery).
test("deliverSale: bodega propia solo exige deliver; directo/brokeraje exige también edit (Decisión 74)", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "deliverSale");
  assert.ok(body.includes('await assertCan(sql, context.userId, "sales", "deliver");'), "siempre pide deliver, primero");
  assert.ok(body.includes('if (so[0].route_kind === "supplier" || so[0].route_kind === "asr") {\n      await assertCan(sql, context.userId, "sales", "edit");\n    }'), "solo directo/brokeraje exige edit, después de conocer la ruta");
});

test("users.ts acepta guardar el nivel deliver; users.tsx lo ofrece solo en Ventas y Compras y lo pinta", () => {
  const users = src("src/lib/erp/users.ts");
  assert.ok(users.includes('z.enum(["none", "view", "deliver", "edit"])'), "el validator de updateMember lo admite");
  const ui = src("src/routes/users.tsx");
  assert.ok(ui.includes('id === "sales" || id === "purchases"'), "la cuarta opción solo donde significa algo");
  assert.ok(ui.includes('opt === "deliver" ? "Entregar"'), "etiqueta");
  assert.ok(ui.includes('if (level === "deliver")'), "LevelChip la pinta");
});
