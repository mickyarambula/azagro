// BLOQUE DE PARCIALES, paso 5 (PARCIALES.md § 8): devolución y P&L con N
// facturas. Decisión 52 (a cuál factura abona la devolución: se propone la
// factura donde viajó el producto, se pregunta si viajó en más de una) y
// Decisión 61 (el costo financiero de cada entrega corre desde SU entrega).
//
// azagro.ts / reports.ts no se importan directo en `node --test` (alias `@/`);
// se verifican por texto (fnBody/.includes). `mergeDealPnl` (parciales.ts) es
// puro y se prueba con números.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeDealPnl } from "../src/lib/erp/parciales.ts";

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

// ---------------------------------------------------------------------------
// Migración 0036: la liga NC → factura (Decisión 52), aditiva y nula.
// ---------------------------------------------------------------------------
test("migración 0036: invoices.applies_to_id, entero, nulo permitido, sin llave foránea, solo aditiva", () => {
  const m = src("migrations/0036_nc_aplica_a.sql");
  assert.ok(m.includes("alter table invoices add column if not exists applies_to_id integer;"));
  assert.ok(!/drop|rename|alter column|not null|references/i.test(m), "nada destructivo, nada obligatorio");
  assert.ok(src("migrations/README.md").includes("0036 = `invoices.applies_to_id`"), "documentada en migrations/README.md");
});

// ---------------------------------------------------------------------------
// (A) returnSale: ya no exige `done`, abona a la factura elegida (o la última
//     viva), y la NC guarda a cuál abonó.
// ---------------------------------------------------------------------------
test("returnSale: ya no exige pedido `done` — basta mercancía entregada sin devolver; cancelado/borrador siguen bloqueados", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "returnSale");
  assert.ok(!body.includes('so[0].state !== "done"'), "el gate por done se fue (con parciales un pedido con mercancía en casa del cliente puede seguir por entregar)");
  assert.ok(body.includes('if (so[0].state === "cancelled" || so[0].state === "draft") throw new Error('), "cancelado y borrador, no");
  assert.ok(body.includes("No hay nada entregado que devolver en este pedido."), "sin entregado, no");
  assert.ok(body.includes("const max = Number(src.qty_delivered) - Number(src.qty_returned);"), "el tope sigue siendo entregado − devuelto (acumulados, paso 3)");
});

test("returnSale: la factura a la que abona es la elegida (fvId) o la última viva — nunca una revertida ni una NC contraria", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "returnSale");
  assert.ok(body.includes("fvId: z.number().optional(),"), "fvId opcional: sin él, el camino de siempre");
  assert.ok(body.includes("where company_id = ${m.company_id} and id = ${data.fvId} and order_id = ${so[0].id}"), "la elegida tiene que ser de ESTE pedido");
  assert.equal((body.match(/and kind = 'customer' and name like 'FV-%' and state <> 'reversed' and reverses_id is null/g) || []).length, 1, "elegida: viva y de verdad FV");
  assert.ok(body.includes("and state <> 'reversed' and reverses_id is null\n          order by id desc limit 1"), "última viva: excluye revertidas explícito, no por flujo");
  assert.ok(body.includes("Esa factura no es una factura viva de este pedido."), "fvId ajeno o revertida → error, no silencio");
  // Aviso del revisor de dinero (16-sep): sin factura viva no hay venta que abonar — la NC sin factura no nace; el camino es la reversa.
  assert.ok(body.includes("no tiene factura viva: no hay venta que abonar. Si la mercancía regresó sin haberse facturado, revierte esa entrega"), "candado con salida: nombra la reversa de entrega (Decisión 38)");
  assert.ok(body.indexOf("no tiene factura viva") < body.indexOf("const ncName = await nextDocFolio("), "se detiene ANTES de nacer la NC y de mover inventario");
  assert.ok(body.includes("applied = Math.min(credit, Number(fv[0].residual));"), "el abono, igual que siempre (erp-devolucion-costo lo fija)");
});

test("returnSale: la NC guarda applies_to_id = la factura a la que abonó (aunque esté pagada y no haya abono), y lo dice en bitácora y en la respuesta", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "returnSale");
  assert.ok(body.includes("currency, order_id, inv_class, applies_to_id, created_by, circuit_code"), "columna nueva en el insert de la NC (antes de created_by: erp-circuitos fija que la lista termine en circuit_code)");
  assert.ok(body.includes("${fv[0]?.id ?? null}"), "nula si no hay factura viva");
  const iFv = body.indexOf("const fv = data.fvId != null");
  const iNc = body.indexOf("insert into invoices (");
  assert.ok(iFv > -1 && iFv < iNc, "la factura se elige ANTES de nacer la NC, para que la NC nazca ligada");
  assert.ok(body.includes("abona a ${fv[0].name}${data.fvId != null ? \" (elegida)\" : \"\"}"), "bitácora: a cuál, y si fue elegida a mano");
  assert.ok(body.includes("fv: fv[0]?.name ?? null,"), "y la respuesta la nombra");
});

test("returnProposal (Decisión 52): por producto, cuánto facturó cada FV y cuánto ya se devolvió de ella (por applies_to_id); propone la única que cubre todo; si más de una o ninguna, pregunta", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "returnProposal");
  assert.ok(body.includes('assertCan(sql, context.userId, "sales", "view")'), "solo lectura");
  assert.ok(body.includes("group by il.invoice_id, il.product_id"), "lo facturado, por factura y producto");
  assert.ok(body.includes("group by i.applies_to_id, il.product_id"), "lo devuelto, por factura a la que abonó");
  assert.ok(body.includes("available: Math.max(0, Number(x.qty) - ret)"), "disponible = facturado − devuelto de ESA factura");
  assert.ok(body.includes("const candidates = data.lines.length ? invoices.filter(covers) : [];"), "candidatas: las que cubren TODO lo que se devuelve");
  assert.ok(body.includes("candidates.length === 1 ? candidates[0]!.id : null"), "una sola → propuesta; si no, null");
  assert.ok(body.includes("const ask = invoices.length > 1 && candidates.length !== 1;"), "más de una o ninguna → se pregunta");
  assert.ok(body.includes("viajó en más de una factura: elige a cuál abonar"), "y se dice por qué");
  assert.ok(body.includes("sin liga a factura (de antes de la migración 0036)"), "una NC vieja sin liga se reporta, no se adivina");
});

test("ficha del pedido: la devolución también con pedido parcial; con 2+ facturas vivas pide elegir (propuesta prellenada) y no manda sin elección", () => {
  const so = src("src/routes/sales.$orderId.tsx");
  assert.ok(so.includes('{canEdit && (state === "done" || state === "confirmed") && sold.some((l) => num(l.qty_delivered) - num(l.qty_returned) > 0.0001) && ('), "la tarjeta aparece con pedido parcial");
  assert.ok(so.includes("returnProposal({ data: { soId: id, lines } })"), "pide la propuesta");
  assert.ok(so.includes("setRetFv((cur) => (cur != null && r.invoices.some((i) => i.id === cur) ? cur : r.proposedId))"), "prellena con la propuesta sin pisar una elección válida");
  assert.ok(so.includes("Este pedido tiene varias facturas: elige a cuál abona la devolución."), "sin elección no manda");
  assert.ok(so.includes("fvId: liveFvs.length > 1 ? (retFv ?? undefined) : undefined"), "con una sola factura no manda fvId: el camino de siempre");
  assert.ok(so.includes("propuesta: aquí viajó lo que se devuelve"), "la opción propuesta se nombra");
  assert.ok(so.includes('"pagada: el crédito quedaría abierto, no bajaría saldo"'), "y cada opción dice su saldo — elegir una pagada se ve antes, no en el mensaje final (aviso del revisor)");
});

// ---------------------------------------------------------------------------
// (B) computeDealPnl: el camino de una entrega intacto; el nuevo, por factura.
// ---------------------------------------------------------------------------
test("computeDealPnl: la consulta de la última FV (fijada por erp-revertir-entrega) sigue byte a byte, y decide el camino: 2+ FV vivas o una FV parcial con evento → por factura", () => {
  const r = src("src/lib/erp/reports.ts");
  const body = fnBody(r, "computeDealPnl");
  assert.ok(body.includes("and kind = 'customer' and name like 'FV-%'\n      and state <> 'reversed'\n    order by id desc limit 1"), "la consulta vieja, intacta");
  assert.ok(body.includes("let multi = fvsAll.length > 1;"), "2+ facturas vivas");
  assert.ok(body.includes("fvsAll[0]!.event_ref != null") && body.includes("multi = Number(q[0]?.invoiced ?? 0) < Number(q[0]?.ordered ?? 0) - 0.0001;"), "una sola FV parcial (con evento) también");
  assert.ok(body.includes("if (multi) return computeDealPnlMulti(sql, companyId, soId, fvsAll);"));
  assert.ok(body.includes("const core = await dealPnlCore(sql, companyId, soId, { fv: fv[0], orderLevel: true });"), "una entrega: el motor de siempre con la misma FV");
  assert.ok(body.includes("multi: false as const"), "y se dice que no es por factura");
});

test("dealPnlCore: el motor de siempre recibe la FV por parámetro; por factura, la cantidad es lo que ESA factura facturó; gastos y mora solo a nivel pedido", () => {
  const r = src("src/lib/erp/reports.ts");
  const core = fnBody(r, "dealPnlCore");
  assert.ok(core.includes("const fv: DealFvRow[] = opts.fv ? [opts.fv] : [];"), "fv[0] sigue siendo la misma variable de siempre");
  assert.ok(core.includes("const qty = opts.qtyByProduct ? (opts.qtyByProduct.get(l.product_id) ?? 0) : Number(l.qty);"), "cantidad por factura, o la partida completa");
  assert.ok(core.includes("const expenses = opts.orderLevel ? await orderExpenses(sql, companyId, soId) : [];"), "gastos una sola vez");
  assert.ok(core.includes("opts.orderLevel ? await orderMora(sql, companyId, soId) : { mora: 0, moraPendiente: 0 }"), "mora una sola vez");
  // El motor no cambió: las fórmulas que fijan otras pruebas siguen aquí.
  assert.ok(core.includes("const landed = cogs + freight + other;"), "costo puesto (regla 8)");
  assert.ok(core.includes("supplierCost: financialDays > 0 ? landed : 0,"), "Capa 1 sobre el costo puesto");
  assert.ok(core.includes("const financialDays = snap.financialDays ?? (fv[0] ? fv[0].credit_days : so[0].credit_days);"), "los días de ESA factura (Decisión 61 por construcción)");
  assert.ok(!core.includes("order by id desc limit 1"), "el core no vuelve a elegir factura");
});

test("computeDealPnlMulti: una pasada del motor por factura con lo que facturó, gastos y mora del pedido una vez, lo sin facturar aparte, y mergeDealPnl suma", () => {
  const r = src("src/lib/erp/reports.ts");
  const body = fnBody(r, "computeDealPnlMulti");
  assert.ok(body.includes("select product_id, sum(qty)::text as qty from invoice_lines where invoice_id = ${f.id} and product_id is not null group by product_id"), "lo que facturó ESA factura");
  assert.ok(body.includes("pnl: await dealPnlCore(sql, companyId, soId, { fv: f, qtyByProduct, orderLevel: false })"), "el motor de siempre, por factura, sin gastos ni mora");
  assert.ok(body.includes("const expenses = await orderExpenses(sql, companyId, soId);") && body.includes("const { mora, moraPendiente } = await orderMora(sql, companyId, soId);"), "una sola vez");
  assert.ok(body.includes(".filter((r) => r.qty > 0.0001);"), "lo sin facturar (pedido − facturado), solo si hay");
  assert.ok(body.includes("return mergeDealPnl("), "la suma es pura y probada con números");
  // Decisión 99: por el mismo import entra `freightOfDeal`, la regla que evita
  // que el flete se cuente dos veces. Las dos viven en el módulo puro.
  assert.ok(r.includes('import { freightOfDeal, mergeDealPnl, type DealExpense } from "@/lib/erp/parciales";'));
});

// ---------------------------------------------------------------------------
// mergeDealPnl con números: dos facturas de un pedido de 20 (10 + 10), cada
// una con sus propios días (Decisión 61): la suma no es "la última × 2".
// ---------------------------------------------------------------------------
function line(over) {
  return {
    productId: 1, code: "ALB01", name: "COFACTOR", qty: 10, uom: "LTS", saleUnit: 150, sale: 1500, costUnit: 80, costSource: "OC",
    cogs: 800, freightUnit: 0, freight: 0, other: 0, landed: 800, finance: 0, commission: 0, layer1: 0, layer2: 0, margin: 700, marginPct: 46.67,
    disbursed: 0, financierFinance: 0, lineCost: 0, protection: 0, revenueLine: 1500, excluded: false, excludeReason: null, ...over,
  };
}
function part(name, over, lineOver) {
  const l = line(lineOver);
  return {
    invoice: { id: 1, name, eventRef: "ENV/0001", date: "2026-10-01", amount: 1500, residual: 1500, paidDate: null, ...over.invoice },
    pnl: {
      name: "PV-0001", currency: "MXN", creditDays: 60, circuit: "ASR", financingBase: "costo_comision", clientPrice: 1500, disbursed: 0, financierFinance: 0,
      commissionRate: 0.01, costRate: null, collectionRate: null, spread: 0.04, lineCost: l.finance, protection: 0, financeRate: 0.11, tiieIssue: 0.07, tiieDate: "2026-10-01",
      financialDays: 60, daysExceeded: 0, lines: [l], revenue: l.revenueLine, cogs: l.cogs, freightQuote: 0, other: 0,
      commission: l.commission, layer1: l.layer1, layer2: l.layer2, finance: l.finance, financeBase: l.landed, discount: 0, fxIncome: 0, ...over.pnl,
    },
  };
}
const orderNone = { expenses: [], mora: 0, moraPendiente: 0, uninvoiced: [] };

test("mergeDealPnl: dos facturas iguales suman venta, costo y margen; el costo financiero de cada una viene de SUS días (Decisión 61), no del último × 2", () => {
  // FV1: 60 días, costo financiero 8.00 + 14.67 = 22.67 sobre 800. FV2: 30 días (salió después): 8.00 + 7.33 = 15.33.
  const a = part("FV-0001", { invoice: { id: 1 } }, { commission: 8, layer1: 14.67, finance: 22.67, lineCost: 22.67 });
  const b = part("FV-0002", { invoice: { id: 2, name: "FV-0002", eventRef: "ENV/0002", date: "2026-10-31" }, pnl: { financialDays: 30 } }, { commission: 8, layer1: 7.33, finance: 15.33, lineCost: 15.33 });
  const m = mergeDealPnl([a, b], orderNone);
  assert.equal(m.multi, true);
  assert.equal(m.revenue, 3000);
  assert.equal(m.cogs, 1600);
  assert.equal(m.margin, 1400);
  assert.equal(m.finance, 38, "22.67 + 15.33: cada factura con sus días — con el camino viejo sería 22.67 × 2 = 45.34");
  assert.equal(m.netProfit, 1400 - 38);
  assert.equal(m.lines.length, 1, "un renglón por producto");
  assert.equal(m.lines[0].qty, 20);
  assert.equal(m.lines[0].costUnit, 80, "unitario ponderado");
  assert.deepEqual(m.invoices.map((i) => [i.name, i.financialDays, i.finance, i.netProfit]), [["FV-0001", 60, 22.67, 1500 - 800 - 22.67], ["FV-0002", 30, 15.33, 1500 - 800 - 15.33]]);
  assert.equal(m.financialDays, 30, "los escalares del pedido son los de la última factura, como siempre; el detalle va en `invoices`");
});

test("mergeDealPnl: 'cuánto se ha cobrado' mira TODAS las facturas — la primera cobrada y la segunda no = 50%, no 0%", () => {
  const a = part("FV-0001", { invoice: { id: 1, residual: 0, paidDate: "2026-11-15" } }, {});
  const b = part("FV-0002", { invoice: { id: 2, name: "FV-0002", residual: 1500 } }, {});
  const m = mergeDealPnl([a, b], orderNone);
  assert.equal(m.paidRatio, 0.5);
  assert.equal(m.fullyPaid, false);
  assert.equal(m.utilidadProporcional, m.netProfit * 0.5);
  assert.equal(m.utilidadCaja, 0, "en caja solo cuando TODAS están cobradas");
  const c = part("FV-0002", { invoice: { id: 2, name: "FV-0002", residual: 0 } }, {});
  assert.equal(mergeDealPnl([a, c], orderNone).fullyPaid, true);
  assert.equal(mergeDealPnl([a, c], orderNone).utilidadCaja, mergeDealPnl([a, c], orderNone).utilidadRealizada);
});

test("mergeDealPnl: gastos y mora del pedido entran UNA vez (no por factura); pronto pago y diferencial cambiario, los de cada factura sumados", () => {
  const a = part("FV-0001", { invoice: { id: 1 }, pnl: { discount: 5, fxIncome: 2 } }, {});
  const b = part("FV-0002", { invoice: { id: 2, name: "FV-0002" }, pnl: { discount: 3, fxIncome: -1 } }, {});
  const gastos = [{ id: 1, name: "Flete local", class: "pedido", amount: 100 }, { id: 2, name: "Maniobras", class: "otro", amount: 40 }];
  const m = mergeDealPnl([a, b], { expenses: gastos, mora: 50, moraPendiente: 20, uninvoiced: [] });
  // Decisión 99: un gasto SIN marcar no es el flete —se llame como se llame—,
  // así que cuenta como costo aparte. Antes entraba a `freight` y de ahí al
  // margen; ahora entra a `other` y de ahí al margen: la cubeta se movió, el
  // margen es el mismo número que daba antes, al centavo.
  assert.equal(m.freight, 0, "no se cotizó flete y ningún gasto está marcado como tal");
  assert.equal(m.freightSource, "cotizado");
  assert.equal(m.other, 140, "los dos gastos del pedido, una vez cada uno");
  assert.equal(m.margin, 3000 - 1600 - 100 - 40, "el margen no se movió: ningún costo se perdió al mover las cubetas");
  // Y marcándolo, el mismo gasto pasa a ser el flete SIN cambiar el margen:
  // sigue restando una vez, nada más que por el renglón que le toca.
  const marcado = mergeDealPnl([a, b], { expenses: [{ ...gastos[0], isFreight: true }, gastos[1]], mora: 50, moraPendiente: 20, uninvoiced: [] });
  assert.equal(marcado.freight, 100);
  assert.equal(marcado.freightSource, "real");
  assert.equal(marcado.other, 40);
  assert.equal(marcado.margin, m.margin, "marcar un gasto como flete no puede mover la utilidad");
  assert.equal(m.discount, 8);
  assert.equal(m.fxIncome, 1);
  assert.equal(m.mora, 50);
  assert.equal(m.netProfit, m.margin + 50 + 1 - 0 - 8);
  assert.equal(m.utilidadRealizada, m.netProfit - 20);
  assert.equal(m.expenses.length, 2);
});

test("mergeDealPnl: un producto que solo viajó en una factura aparece con la cantidad de esa factura; lo sin facturar se reporta aparte; una partida excluida en una factura queda excluida", () => {
  const a = part("FV-0001", { invoice: { id: 1 } }, {});
  const b = part("FV-0002", { invoice: { id: 2, name: "FV-0002" } }, { productId: 2, code: "ALB02", name: "ADHERES", qty: 5, sale: 750, cogs: 0, landed: 0, margin: 0, revenueLine: 750, excluded: true, excludeReason: "sin costo" });
  // La FV-0002 también lleva el producto 1 con cantidad 0 (no viajó en ella): no debe duplicar el renglón.
  b.pnl.lines.push(line({ qty: 0, sale: 0, cogs: 0, landed: 0, margin: 0, revenueLine: 0 }));
  const m = mergeDealPnl([a, b], { ...orderNone, uninvoiced: [{ productId: 1, code: "ALB01", name: "COFACTOR", uom: "LTS", qty: 10 }] });
  assert.deepEqual(m.lines.map((l) => [l.productId, l.qty, l.excluded]), [[1, 10, false], [2, 5, true]]);
  assert.equal(m.excluded.n, 1);
  assert.equal(m.excluded.venta, 750);
  assert.deepEqual(m.excluded.motivos, ["sin costo"]);
  assert.equal(m.revenue, 1500, "la excluida no entra a la venta");
  assert.deepEqual(m.uninvoiced, [{ productId: 1, code: "ALB01", name: "COFACTOR", uom: "LTS", qty: 10 }]);
});

test("mergeDealPnl: protección y costo real de la línea (lineal) — null si alguna factura no tiene tasa de costo, suma si todas la tienen", () => {
  const a = part("FV-0001", { invoice: { id: 1 }, pnl: { financingBase: "costo_margen" } }, { lineCost: 10, protection: 2 });
  const b = part("FV-0002", { invoice: { id: 2, name: "FV-0002" }, pnl: { financingBase: "costo_margen" } }, { lineCost: null, protection: null });
  assert.equal(mergeDealPnl([a, b], orderNone).protection, null);
  assert.equal(mergeDealPnl([a, b], orderNone).lineCost, null);
  const c = part("FV-0002", { invoice: { id: 2, name: "FV-0002" }, pnl: { financingBase: "costo_margen" } }, { lineCost: 4, protection: 1 });
  assert.equal(mergeDealPnl([a, c], orderNone).lineCost, 14);
  assert.equal(mergeDealPnl([a, c], orderNone).protection, 3);
});

test("ficha del pedido: con P&L por factura enseña una fila por factura (días, TIIE, venta, costo financiero, cobrado, utilidad) y lo sin facturar", () => {
  const so = src("src/routes/sales.$orderId.tsx");
  assert.ok(so.includes("{pnl.multi ? ("));
  assert.ok(so.includes("suma factura por factura") && so.includes("Decisión 61"), "lo explica");
  assert.ok(so.includes("{money(i.amount - i.residual)} / {money(i.amount)}"), "cobrado / total, por factura");
  assert.ok(so.includes("Sin facturar todavía (fuera del cálculo)"), "lo pendiente no se finge");
});
