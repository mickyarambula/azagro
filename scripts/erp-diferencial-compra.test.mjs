// EL DIFERENCIAL DE LA COMPRA DENTRO DE LA UTILIDAD DEL PEDIDO
// (Decisiones 87 y 88, 18-sep-2026 — transversal (i) de MODELO-NEGOCIO § 13.4).
//
// Hasta hoy la utilidad del pedido era
//   netProfit = margen + mora + fxIncome − financiero − descuento
// y `fxIncome` leía UNA sola columna: el `fx_result` de la factura de venta.
// Una compra en dólares pagada con pesos a otro tipo de cambio registraba su
// diferencial en la factura del PROVEEDOR — con el signo ya puesto — y la
// utilidad del pedido no lo restaba nunca. El número existía, estaba bien, y
// no lo leía nadie: `fx_result` del lado proveedor no aparecía en una sola
// pantalla del sistema.
//
// Aquí se fija: el camino único pedido → compra → factura del proveedor, que
// el término entre como campo PROPIO (no dentro de `fxIncome`), que sea del
// pedido entero (no repartido entre facturas de venta), y que el pedido sin
// compra ligada lo DIGA en vez de enseñar un cero mudo.
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
// 1. Un solo lugar donde se pregunta por la compra de un pedido
// ---------------------------------------------------------------------------
test("el camino pedido → compra → factura del proveedor vive en UNA función, no en una sexta copia", () => {
  const d = src("src/lib/erp/deal-supplier.ts");
  const q = fnBody(d, "supplierInvoicesOfDeal");
  assert.ok(q.includes("join purchase_orders po on po.name = i.origin and po.company_id = i.company_id"), "el amarre por texto, acotado por empresa");
  assert.ok(q.includes("and po.so_id = ${soId}"), "la liga del pedido con su compra");
  assert.ok(q.includes("and i.kind = 'supplier'"), "solo facturas del proveedor");
  assert.ok(q.includes("and coalesce(i.inv_class,'product') = 'product'"), "ni la mora ni el ajuste por TC: esos son documentos aparte");
  assert.ok(q.includes("and i.reverses_id is null") && q.includes("and i.state <> 'reversed'"), "ni una revertida ni su contraria (regla 5d)");
  // La prueba de erp-revertir-entrega cuenta las apariciones de una frase
  // literal en reports.ts. Esta consulta vive en OTRO archivo y con los
  // predicados en otro orden, a propósito: no debe alterar ese conteo.
  const r = src("src/lib/erp/reports.ts");
  assert.equal((r.match(/state <> 'reversed' and reverses_id is null/g) || []).length, 4, "el conteo de reports.ts no se movió");
});

test("el diferencial de la compra se LEE, nunca se calcula: el signo ya viene puesto del pago", () => {
  const d = fnBody(src("src/lib/erp/deal-supplier.ts"), "purchaseFxOfDeal");
  assert.ok(d.includes("facturas.reduce((s, f) => s + f.fxResult, 0)"), "suma lo que ya está escrito");
  assert.ok(!d.includes("fx_agreed") || !d.includes("- "), "no recalcula ningún diferencial");
  // Quien pone el signo es el pago, del lado proveedor: pérdida cuando se le
  // pagó de más (fx.ts, `fxResultDeltaFor`).
  const fx = src("src/lib/erp/fx.ts");
  assert.ok(fx.includes('kind === "supplier" ? r2(-fxDiff) : r2(fxDiff)'), "el signo del lado proveedor ya está invertido en el origen");
});

// ---------------------------------------------------------------------------
// 2. Campo propio, nunca dentro de fxIncome
// ---------------------------------------------------------------------------
test("va en campo PROPIO: sumarlo a fxIncome cambiaría el Panorama del CLIENTE sin tocar el Panorama", () => {
  const r = src("src/lib/erp/reports.ts");
  assert.ok(r.includes("const netProfit = margin + mora + fxIncome + fxCompra - finance - discount;"), "los dos diferenciales, cada uno por su lado");
  assert.ok(r.includes("const fxIncome = fv[0] ? Number(fv[0].fx_result) : 0;"), "fxIncome sigue siendo SOLO el de la factura de venta");
  // El Panorama agrega por razón social del CLIENTE leyendo `d.fxIncome`. Si
  // el diferencial del proveedor se hubiera metido ahí, aparecería como «Dif.
  // TC» de un cliente que no tuvo nada que ver, sin un solo cambio visible.
  assert.ok(r.includes("r.fx += d.fxIncome;"), "el Panorama sigue leyendo solo el del cliente");
  assert.ok(!r.includes("r.fx += d.fxIncome + d.fxCompra"), "y no se le coló el del proveedor");
});

test("es del PEDIDO entero, como los gastos y la mora: una sola vez, no repartido entre facturas de venta", () => {
  const r = src("src/lib/erp/reports.ts");
  const core = fnBody(r, "dealPnlCore");
  assert.ok(core.includes("const compraFx = opts.orderLevel"), "solo a nivel pedido, igual que orderExpenses y orderMora");
  const multi = fnBody(r, "computeDealPnlMulti");
  assert.ok(multi.includes("const compraFx = await purchaseFxOfDeal(sql, companyId, soId);"), "con N facturas se lee una sola vez");
  assert.ok(multi.includes("fxCompra: compraFx.fxCompra, compraLigada: compraFx.ligado"), "y entra por `order`, no por `parts`");
  const par = src("src/lib/erp/parciales.ts");
  assert.ok(par.includes("const fxCompra = order.fxCompra ?? 0;"), "mergeDealPnl lo recibe del pedido");
  assert.ok(par.includes("const netProfit = margin + order.mora + fxIncome + fxCompra - finance - discount;"), "y entra a la utilidad del pedido");
  // La utilidad POR FACTURA no lo lleva: repartirlo sería inventar una
  // proporción que ningún documento dice.
  assert.ok(
    par.includes("netProfit: r2(p.pnl.revenue - p.pnl.cogs - p.pnl.freightQuote - p.pnl.other + p.pnl.fxIncome - p.pnl.finance - p.pnl.discount),"),
    "la utilidad de cada factura queda byte a byte",
  );
});

// ---------------------------------------------------------------------------
// 3. El cero que hay que explicar (Decisión 88)
// ---------------------------------------------------------------------------
test("un pedido sin compra ligada lo DICE: no es que no haya diferencial, es que no se sabe cuál le toca", () => {
  const d = fnBody(src("src/lib/erp/deal-supplier.ts"), "purchaseFxOfDeal");
  assert.ok(d.includes("if (!ligado) return { ligado: false, fxCompra: 0, facturas: [] as DealSupplierInvoice[] };"), "el cero viene con su bandera");
  // Se pregunta por la ORDEN, no por la factura: una orden confirmada y aún
  // sin recibir ya liga al pedido aunque no haya nacido ninguna factura.
  const h = fnBody(src("src/lib/erp/deal-supplier.ts"), "dealHasPurchase");
  assert.ok(h.includes("from purchase_orders") && h.includes("so_id = ${soId}"), "la liga es la orden");
  assert.ok(h.includes("and state <> 'cancelled'"), "una orden cancelada no liga nada");
  const p = src("src/routes/sales.$orderId.tsx");
  assert.ok(p.includes("pnl.compraLigada === false &&"), "la pantalla lo enseña");
  assert.ok(p.includes("no tiene una orden de compra ligada"), "con esas palabras");
  assert.ok(p.includes("Posición cambiaria"), "y manda a donde sí se ve");
});

test("los dos diferenciales salen con nombre distinto en la tarjeta del pedido", () => {
  const p = src("src/routes/sales.$orderId.tsx");
  assert.ok(p.includes("Diferencial cambiario (cobro al cliente)"), "el del cobro");
  assert.ok(p.includes("Diferencial cambiario (pago al proveedor)"), "el del pago");
  assert.ok(!p.includes("`Diferencial cambiario: ${money(pnl.fxIncome)}"), "ya no hay uno sin apellido");
});

// ---------------------------------------------------------------------------
// 4. Lo que este bloque cerró de paso
// ---------------------------------------------------------------------------
test("el esquema se declara en la migración: ni computeDealPnl ni el Panorama corren alter table por llamada", () => {
  const r = src("src/lib/erp/reports.ts");
  assert.ok(!r.includes("await sql`alter table"), "cero sentencias de esquema en el camino del P&L");
  const mig = src("migrations/0045_esquema_declarado.sql");
  assert.ok(mig.includes("alter table purchase_orders add column if not exists so_id integer;"), "la liga del pedido con su compra, declarada");
  assert.ok(mig.includes("alter table purchase_orders add column if not exists fulfill_kind text not null default 'inventory';"), "y el tipo de surtido");
  assert.ok(mig.includes("create index if not exists po_so_idx on purchase_orders (company_id, so_id);"), "índice por donde se camina en bucle");
  assert.ok(mig.includes("create index if not exists inv_origin_idx on invoices (company_id, kind, origin);"), "y el del amarre por texto");
});

test("el Panorama y el Excel cuadran por columnas: si la utilidad lleva el término, la tabla lo enseña", () => {
  // El revisor lo atrapó: `r.fx` agrega por razón social del CLIENTE y la
  // utilidad ya incluye `fxCompra`. Sin columna propia, la fila de un cliente
  // bajaba 5,000 pesos sin que nada visible lo explicara.
  const r = src("src/lib/erp/reports.ts");
  assert.ok(r.includes("r.fxCompra += d.fxCompra ?? 0;"), "el Panorama agrega el del proveedor aparte");
  assert.ok(r.includes("fxCompra: sum((r) => r.fxCompra),"), "y su total");
  assert.ok(r.includes("fxCompra: d.fxCompra ?? 0,"), "listDealPnl lo publica para el Excel");
  const p = src("src/routes/reportes.tsx");
  assert.ok(p.includes('Dif. TC cobro') && p.includes('Dif. TC pago'), "dos columnas con nombre, no una sumada");
  assert.ok(p.includes("{money(r.fxCompra ?? 0)}"), "la fila");
  assert.ok(p.includes("{money(pano.totales.fxCompra ?? 0)}"), "el total");
  assert.ok(p.includes('"Dif. TC pago", "Utilidad final"'), "y el Excel, justo antes de la utilidad que la incluye");
});

test("el ajuste por TC a favor de Azagro ya cuenta: nace con saldo negativo y ningún total lo sumaba", () => {
  const body = fnBody(src("src/lib/erp/reports.ts"), "getUpcomingPayable");
  assert.ok(body.includes("and abs(residual) > 0.009"), "entra restando lo que se le debe a ese proveedor");
  // El ATC nace con `-fxDiff`: si a Azagro le sobró pagar, nace negativo.
  assert.ok(src("src/lib/erp/ops.ts").includes("${-fxDiff}, ${-fxDiff}"), "el documento nace con el signo contrario al diferencial");
  // Y el mismo arreglo en el otro lector: las alertas y el correo lo dejaban fuera.
  assert.ok(src("src/lib/erp/alerts.ts").includes("abs(i.residual) > 0.009"), "las alertas también lo cuentan");
});

// ---------------------------------------------------------------------------
// 5. CON NÚMEROS, no con palabras. El revisor de dinero lo pidió así: una
//    prueba que fije la frase se rompe si cambias el orden de las palabras,
//    pero NO si te equivocas de signo. `mergeDealPnl` es puro, así que el
//    término nuevo se puede medir de verdad.
// ---------------------------------------------------------------------------
function linea(over = {}) {
  return {
    productId: 1, code: "ALB01", name: "COFACTOR", uom: "LTS", qty: 10, sale: 1500, revenueLine: 1500,
    cogs: 800, freight: 0, other: 0, landed: 800, costUnit: 80, saleUnit: 150, margin: 700, marginPct: 46.67,
    commission: 8, layer1: 14.67, layer2: 0, finance: 22.67, lineCost: 22.67, protection: 0,
    disbursed: 0, financierFinance: 0, fxSpread: 0, excluded: false, excludeReason: null, ...over,
  };
}
function parte(name, over = {}) {
  const l = linea();
  return {
    invoice: { id: 1, name, eventRef: "ENV/0001", date: "2026-10-01", amount: 1500, residual: 1500, paidDate: null, ...(over.invoice ?? {}) },
    pnl: {
      name: "PV-0001", currency: "MXN", creditDays: 60, circuit: "ASR", financingBase: "costo_comision", clientPrice: 1500,
      disbursed: 0, financierFinance: 0, commissionRate: 0.01, costRate: null, collectionRate: null, spread: 0.04,
      lineCost: 22.67, protection: 0, financeRate: 0.11, tiieIssue: 0.07, tiieDate: "2026-10-01", financialDays: 60,
      daysExceeded: 0, lines: [l], revenue: 1500, cogs: 800, freightQuote: 0, other: 0,
      commission: 8, layer1: 14.67, layer2: 0, finance: 22.67, financeBase: 800, discount: 0, fxIncome: 0,
      ...(over.pnl ?? {}),
    },
  };
}
const SIN_ORDEN = { expenses: [], mora: 0, moraPendiente: 0, uninvoiced: [] };

test("NÚMEROS: pagarle al proveedor 5,000 de más baja la utilidad del pedido exactamente 5,000", () => {
  // Compra de 10,000 USD pactada a 18.00 (factura de $180,000) y pagada a
  // 18.50 (salen $185,000): el diferencial nace en la factura del proveedor
  // como −5,000 y de ahí se lee. El signo ya viene puesto del pago.
  const base = mergeDealPnl([parte("FV-0001")], SIN_ORDEN);
  const conPerdida = mergeDealPnl([parte("FV-0001")], { ...SIN_ORDEN, fxCompra: -5000, compraLigada: true });
  assert.equal(base.netProfit, 677.33, "1500 − 800 − 22.67");
  assert.equal(conPerdida.netProfit, -4322.67, "la misma utilidad, 5,000 abajo");
  assert.equal(Math.round((base.netProfit - conPerdida.netProfit) * 100) / 100, 5000);
  assert.equal(conPerdida.fxCompra, -5000, "y se publica para que la pantalla lo enseñe");
  assert.equal(conPerdida.compraLigada, true);
});

test("NÚMEROS: pagarle 5,000 de menos SUBE la utilidad lo mismo — el signo no está invertido", () => {
  const conGanancia = mergeDealPnl([parte("FV-0001")], { ...SIN_ORDEN, fxCompra: 5000, compraLigada: true });
  assert.equal(conGanancia.netProfit, 5677.33, "677.33 + 5,000");
  assert.equal(conGanancia.fxCompra, 5000);
});

test("NÚMEROS: con DOS facturas de venta el diferencial de la compra entra UNA sola vez", () => {
  const a = parte("FV-0001", { invoice: { id: 1 } });
  const b = parte("FV-0002", { invoice: { id: 2, name: "FV-0002", eventRef: "ENV/0002" } });
  const m = mergeDealPnl([a, b], { ...SIN_ORDEN, fxCompra: -5000, compraLigada: true });
  // Dos facturas: venta 3,000 − costo 1,600 − financiero 45.34 = 1,354.66.
  assert.equal(m.netProfit, 1354.66 - 5000, "los 5,000 se restan una vez, no dos");
  assert.equal(m.fxCompra, -5000);
  // Y la utilidad POR FACTURA no lo lleva: repartirlo sería inventar una proporción.
  assert.equal(m.invoices[0].netProfit, 677.33);
  assert.equal(m.invoices[1].netProfit, 677.33);
  assert.equal(m.invoices[0].netProfit + m.invoices[1].netProfit, 1354.66, "las dos suman la utilidad SIN el diferencial del pedido");
});

test("NÚMEROS: un pedido sin compra ligada no mueve la utilidad, y lo dice", () => {
  const m = mergeDealPnl([parte("FV-0001")], SIN_ORDEN);
  assert.equal(m.fxCompra, 0);
  assert.equal(m.compraLigada, false, "el cero viene con su bandera: la pantalla explica por qué");
  assert.equal(m.netProfit, 677.33, "byte a byte igual que antes del cambio");
});
