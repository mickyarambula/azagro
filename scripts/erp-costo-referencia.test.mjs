import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

/**
 * Costo de referencia (migración 0016).
 *
 * products.cost es el promedio móvil del kardex y solo existe si la mercancía
 * entró a bodega. El brokeraje/directo nunca entra, así que esos productos se
 * quedaban en cero y una cotización a crédito calculaba $0 de financiamiento.
 *
 * Orden único (src/lib/erp/cost.ts): kardex > 0 → referencia > 0 → sin costo.
 * Copia de resolveCost y del candado assertCostForCredit.
 */
function resolveCost(i) {
  const avg = Number(i.avgCost) || 0;
  if (avg > 0) return { cost: avg, source: "kardex" };
  const ref = Number(i.refCost) || 0;
  if (ref > 0) return { cost: ref, source: "referencia" };
  return { cost: 0, source: "ninguno" };
}
function assertCostForCredit(rows, productIds, creditDays) {
  if (creditDays <= 0 || !productIds.length) return;
  const sinCosto = [];
  for (const id of [...new Set(productIds)]) {
    const p = rows.find((r) => r.id === id);
    if (!p) continue;
    if (resolveCost({ avgCost: p.cost, refCost: p.ref_cost }).cost <= 0) sinCosto.push(`${p.code} ${p.name}`);
  }
  if (sinCosto.length) {
    const uno = sinCosto.length === 1;
    throw new Error(
      `${uno ? "Producto" : "Productos"} ${sinCosto.join(", ")} sin costo. ` +
        `Pide a administración que capture el costo de referencia en la ficha del producto, o cotiza de contado.`,
    );
  }
}

const KARDEX = { id: 1, code: "P-1", name: "UREA", cost: "9500", ref_cost: "10000" };
const SOLO_REF = { id: 2, code: "P-2", name: "MAP DIRECTO", cost: "0", ref_cost: "10000" };
const SIN_NADA = { id: 3, code: "P-3", name: "PRODUCTO NUEVO", cost: "0", ref_cost: "0" };

test("el kardex manda: si hay promedio móvil, el costo de referencia no se usa", () => {
  const r = resolveCost({ avgCost: KARDEX.cost, refCost: KARDEX.ref_cost });
  assert.equal(r.cost, 9500);
  assert.equal(r.source, "kardex");
});

test("sin kardex se usa el costo de referencia", () => {
  const r = resolveCost({ avgCost: SOLO_REF.cost, refCost: SOLO_REF.ref_cost });
  assert.equal(r.cost, 10000);
  assert.equal(r.source, "referencia");
});

test("sin ninguno de los dos, el producto no tiene costo", () => {
  const r = resolveCost({ avgCost: SIN_NADA.cost, refCost: SIN_NADA.ref_cost });
  assert.equal(r.cost, 0);
  assert.equal(r.source, "ninguno");
});

test("un costo negativo o basura no cuenta como costo", () => {
  assert.equal(resolveCost({ avgCost: "-500", refCost: "0" }).source, "ninguno");
  assert.equal(resolveCost({ avgCost: null, refCost: undefined }).cost, 0);
  assert.equal(resolveCost({ avgCost: "no es número", refCost: "10000" }).source, "referencia");
});

test("candado: a crédito no se puede guardar una partida sin costo, y el mensaje nombra el producto", () => {
  const rows = [KARDEX, SOLO_REF, SIN_NADA];
  assert.throws(
    () => assertCostForCredit(rows, [1, 3], 90),
    (e) => {
      assert.match(e.message, /P-3 PRODUCTO NUEVO sin costo/);
      assert.match(e.message, /capture el costo de referencia/);
      assert.match(e.message, /o cotiza de contado/);
      return true;
    },
  );
});

test("candado: de contado sí se puede, no hay financiamiento que calcular", () => {
  assert.doesNotThrow(() => assertCostForCredit([SIN_NADA], [3], 0));
});

test("candado: con costo de referencia capturado ya deja cotizar a crédito", () => {
  assert.doesNotThrow(() => assertCostForCredit([SOLO_REF], [2], 150));
});

test("candado: si faltan varios, los nombra todos", () => {
  const otro = { id: 4, code: "P-4", name: "OTRO", cost: "0", ref_cost: "0" };
  assert.throws(
    () => assertCostForCredit([SIN_NADA, otro], [3, 4, 3], 60),
    /Productos P-3 PRODUCTO NUEVO, P-4 OTRO sin costo/,
  );
});

// ---------------------------------------------------------------------------
// Cableado
// ---------------------------------------------------------------------------
test("cableado: la migración agrega la columna sin romper lo que ya existe", () => {
  const sql = src("migrations/0016_costo_referencia.sql");
  assert.ok(sql.includes("alter table products add column if not exists ref_cost numeric(14,4) not null default 0"), "columna con default 0");
  assert.ok(!/drop\s+(table|column)/i.test(sql), "una migración de este tipo no borra nada");
  const cost = src("src/lib/erp/cost.ts");
  assert.ok(cost.includes("alter table products add column if not exists ref_cost"), "y el código se pone al día solo si la base viene de antes");
});

test("cableado: el orden del costo está en un solo lugar y lo usan todos", () => {
  const cost = src("src/lib/erp/cost.ts");
  assert.ok(cost.includes("export function resolveCost("), "un solo resolvedor");
  const fn = cost.slice(cost.indexOf("export function resolveCost"), cost.indexOf("export function costSourceLabel"));
  assert.ok(fn.indexOf("avgCost") < fn.indexOf("refCost"), "primero el kardex, después la referencia");
  for (const file of ["src/lib/erp/ops.ts", "src/lib/azagro.ts", "src/lib/erp/reports.ts"]) {
    assert.ok(src(file).includes("resolveCost("), `${file} usa el resolvedor, no su propio coalesce`);
  }
  // La ruta de solicitud con RFQ no se toca: ahí el costo es el del ganador.
  assert.ok(!src("src/lib/erp/rfq.ts").includes("resolveCost"), "el RFQ sigue con el precio del proveedor ganador");
  assert.ok(!src("src/lib/erp/requests.ts").includes("resolveCost"), "la solicitud tampoco cambia");
});

test("cableado: el candado corre en el servidor al crear y al revisar cotizaciones", () => {
  const ops = src("src/lib/erp/ops.ts");
  const crear = ops.slice(ops.indexOf("export const createQuote"), ops.indexOf("export const reviseQuote"));
  assert.ok(crear.includes("await assertCostForCredit(sql, cid, data.lines.map((l) => l.productId), plazo)"), "candado al crear");
  assert.ok(crear.includes('const plazo = (data.priceOffer ?? "both") === "cash" ? 0 : data.creditDays'), "de contado no aplica");
  assert.ok(crear.indexOf("assertCostForCredit") < crear.indexOf("insert into quotes"), "se valida antes de escribir");
  const revisar = ops.slice(ops.indexOf("export const reviseQuote"), ops.indexOf("export const decideQuote"));
  assert.ok(revisar.includes("await assertCostForCredit(sql, cid, data.lines.map((l) => l.productId), plazoRev)"), "candado al revisar");
  assert.ok(revisar.indexOf("assertCostForCredit") < revisar.indexOf("update quotes"), "también antes de escribir");
});

test("cableado: solo el administrador ve y captura el costo de referencia, con bitácora", () => {
  const az = src("src/lib/azagro.ts");
  const save = az.slice(az.indexOf("export const saveProduct"), az.indexOf("export const nextProductCode"));
  assert.ok(save.includes('if (data.ref_cost !== undefined && me.role !== "admin")'), "candado de rol en el SERVIDOR");
  assert.ok(save.includes("Solo un administrador puede capturar el costo de referencia"), "mensaje claro");
  assert.ok(save.includes("data.ref_cost < 0"), "validación de valor en el servidor");
  assert.ok(save.includes("cambios.push(`costo de referencia ${Number(before[0].ref_cost)} → ${data.ref_cost}`)"), "bitácora con valor anterior y nuevo");
  assert.ok(save.includes("ref_cost = coalesce(${data.ref_cost ?? null}, ref_cost)"), "si no viene, no se pisa lo capturado");

  const get = az.slice(az.indexOf("export const getProduct"), az.indexOf("export const listInventory"));
  assert.ok(get.includes('ref_cost: me.role === "admin" ? rows[0].ref_cost : "0"'), "nadie más lo ve");
  assert.ok(get.includes("cost_source: used.source"), "la ficha sabe de cuál de las dos vías viene el costo");

  const ficha = src("src/components/product-form.tsx");
  assert.ok(ficha.includes("canEditRefCost && ("), "el campo solo se dibuja para quien puede");
  assert.ok(ficha.includes("Costo de referencia"), "con su etiqueta");
  assert.ok(ficha.includes("Costo que está usando el sistema:"), "y muestra cuál de los dos se está usando");
  const route = src("src/routes/products.$productId.tsx");
  assert.ok(route.includes("canEditRefCost={refCostOk}"), "la ficha respeta lo que dijo el servidor");
  assert.ok(route.includes("saveProduct({ data: refCostOk ? { ...form, id } : { ...rest, id } })"), "quien no puede, ni lo manda");
});
