// DOCUMENTOS QUE SALEN DE LA EMPRESA, LIMPIOS (4-sep-2026, barrido con el dueño).
//
// Cada documento tiene dos versiones: la de pantalla, que puede llevar todo el
// texto explicativo que ayude a operar, y la que sale hacia un tercero, que
// solo lleva lo que ese tercero necesita. El papel NUNCA cuenta cómo funciona
// el sistema por dentro; SÍ explica cómo se calcula lo que se cobra, porque el
// cliente tiene derecho a comprobarlo.
//
// Todo el texto que sale vive en src/lib/erp/doc-text.ts; las plantillas en
// src/lib/print-doc.ts. Esta prueba falla si vuelve una palabra interna a
// cualquiera de los dos, o si una pantalla arma su papel con texto propio.
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");
const sinComentarios = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:'"`])\/\/.*$/gm, "$1");
const slice = (code, from, to) => {
  const a = code.indexOf(from);
  assert.ok(a >= 0, `no encontré «${from}»`);
  const b = to ? code.indexOf(to, a) : code.length;
  assert.ok(b > a, `no encontré «${to}» después de «${from}»`);
  return code.slice(a, b);
};

// Palabras que hablan de cómo funciona el sistema por dentro, o que son
// instrucciones de pantalla. Ninguna puede salir de la empresa.
const PROHIBIDAS = [
  [/\bcompaq\b/i, "Compaq"],
  [/\bspread\b/i, "spread"],
  [/\btasa de costo\b/i, "tasa de costo"],
  [/\bajustes\b/i, "Ajustes"],
  [/\bbit[aá]cora\b/i, "bitácora"],
  [/\bkardex\b/i, "kardex"],
  [/\bumbral(es)?\b/i, "umbral"],
  [/\bmigraci[oó]n\b/i, "migración"],
  [/\btabla\b/i, "tabla"],
  [/\bexcel\b/i, "Excel"],
  [/\bpol[ií]tica\b/i, "política"],
  [/\btoca\b/i, "toca"],
  [/\bhaz clic\b/i, "haz clic"],
  [/\bpantalla\b/i, "pantalla"],
];

function limpio(texto, donde) {
  for (const [re, palabra] of PROHIBIDAS) {
    const m = texto.match(re);
    assert.ok(!m, `«${palabra}» aparece en ${donde}: …${texto.slice(Math.max(0, m?.index - 60), (m?.index ?? 0) + 60).replace(/\s+/g, " ")}…`);
  }
}

// ---------------------------------------------------------------------------
// Copias de src/lib/erp/doc-text.ts
// ---------------------------------------------------------------------------
const SERIES = { cliente: ["SOL", "COT", "PV", "FV"], proveedor: ["SC", "OC"] };
function dealLineFor(line, audience) {
  if (!line) return "";
  const keep = SERIES[audience];
  const visible = (folio) => keep.some((s) => folio.toUpperCase().startsWith(`${s}-`));
  return line
    .split("→")
    .map((group) => group.split("·").map((f) => f.trim()).filter((f) => f && visible(f)).join(" · "))
    .filter(Boolean)
    .join(" → ");
}
function expedienteFor(line, audience) {
  const l = dealLineFor(line, audience);
  return l ? `Expediente ${l}` : "";
}
function invoiceLineLabel(i) {
  const origin = (i.origin || "").trim();
  if (i.invClass === "interest") return `Intereses moratorios de ${origin.replace(/^Mora\s+/i, "") || "la factura"}`;
  if (i.invClass === "fx") return `Ajuste por tipo de cambio de ${origin.replace(/^Ajuste TC\s+/i, "") || "la factura"}`;
  if (/^PV-/i.test(origin)) return `Mercancía según pedido ${origin}`;
  if (/^OC-/i.test(origin)) return `Mercancía según orden ${origin}`;
  return `Saldo de factura ${i.name}`;
}
const moneyIn = (n, cur = "MXN") => new Intl.NumberFormat("es-MX", { style: "currency", currency: cur === "USD" ? "USD" : "MXN", maximumFractionDigits: 2 }).format(n);
const dateDMY = (iso) => { const [y, m, d] = iso.slice(0, 10).split("-"); return `${d}/${m}/${y}`; };
const pctRate = (n) => `${(Math.max(0, n) * 100).toFixed(4).replace(/\.?0+$/, "")}%`;
function splitFegaBundle(fegaRate, commissionRate) {
  const commission = Math.min(Math.max(0, commissionRate), Math.max(0, fegaRate));
  return { commission, fega: Math.max(0, fegaRate - commission), bundle: fegaRate };
}
function interestInvoiceClientCalc(i) {
  const cur = i.currency || "MXN";
  const m = (n) => moneyIn(n, cur);
  const lines = [
    `Intereses moratorios al ${dateDMY(i.asOf)}: cargo original ${m(i.capital)} × tasa anual ${pctRate(i.annualRate)} × ${i.days} días vencidos / 360 = ${m(i.interestAccrued)}.`,
  ];
  if (i.interestBefore > 0.009) lines.push(`Ya facturado en documentos anteriores: ${m(i.interestBefore)}. En esta factura: ${m(i.interestNew)}.`);
  if (i.fegaNew > 0.009) {
    const split = splitFegaBundle(i.fegaRate, i.commissionRate);
    const partes = [split.commission > 0 ? `comisión ${pctRate(split.commission)}` : "", split.fega > 0 ? `FEGA ${pctRate(split.fega)}` : ""].filter(Boolean);
    lines.push(`${partes.join(" + ")} sobre el cargo original, una sola vez: ${m(i.fegaNew)}.`);
  }
  lines.push(`Total de esta factura: ${m(i.interestNew + i.fegaNew)}.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// El texto que sale, palabra por palabra
// ---------------------------------------------------------------------------
test("doc-text.ts no lleva ninguna palabra interna (sin contar comentarios)", () => {
  limpio(sinComentarios(src("src/lib/erp/doc-text.ts")), "src/lib/erp/doc-text.ts");
});

test("las plantillas de print-doc.ts tampoco", () => {
  limpio(sinComentarios(src("src/lib/print-doc.ts")), "src/lib/print-doc.ts");
});

test("cada pantalla arma su papel solo con doc-text: ni una nota propia con palabra interna", () => {
  const ec = src("src/routes/statements.tsx");
  limpio(sinComentarios(slice(ec, "function printStatement", "function printConsolidado")), "el papel del estado de cuenta");
  limpio(sinComentarios(slice(ec, "function printConsolidado", "function Page")), "el consolidado");
  limpio(sinComentarios(slice(ec, "<SendButton", "/>")), "el mensaje del estado de cuenta");
  const q = src("src/routes/quotes.tsx");
  limpio(sinComentarios(slice(q, "printHtml(", "return (")), "el papel de la cotización");
  const pv = src("src/routes/sales.$orderId.tsx");
  limpio(sinComentarios(slice(pv, 'title: "Pedido de venta"', "{error &&")), "el pedido de venta y su mensaje");
  limpio(sinComentarios(slice(pv, "guiaSheet({", "Imprimir / PDF")), "la guía de carga");
  const oc = src("src/routes/purchases.tsx");
  limpio(sinComentarios(slice(oc, 'title: "Orden de compra"', "o.state !== \"done\"")), "la orden de compra y su mensaje");
  const cr = src("src/routes/credit.tsx");
  limpio(sinComentarios(slice(cr, "const audience =", "Documento\n")), "el papel de la factura");
  const rfq = src("src/routes/rfq.$rfqId.tsx");
  limpio(sinComentarios(slice(rfq, "<SendButton", "/>")), "la solicitud de cotización al proveedor");
  const sol = src("src/routes/solicitudes.$solicitudId.tsx");
  limpio(sinComentarios(slice(sol, 'title="Solicitud de cotización"', "/>")), "la solicitud de cotización desde la solicitud");
  const al = src("src/lib/erp/alerts.ts");
  limpio(sinComentarios(slice(al, "export const sendPaymentReminder", "export const sendPartnerReminders")), "el recordatorio de pago");
});

// ---------------------------------------------------------------------------
// Expediente: al cliente SOL/COT/PV/FV, al proveedor SC/OC, nunca cruzados
// ---------------------------------------------------------------------------
const CADENA = "SOL-0001 → SC-0002 · SC-0003 → COT-0004 → PV-0005 → OC-0006 · OC-0007 → FV-0008 · FP-0009";

test("el cliente no ve que se fue con proveedores; el proveedor no ve el pedido del cliente", () => {
  assert.equal(dealLineFor(CADENA, "cliente"), "SOL-0001 → COT-0004 → PV-0005 → FV-0008");
  assert.equal(dealLineFor(CADENA, "proveedor"), "SC-0002 · SC-0003 → OC-0006 · OC-0007");
  assert.equal(expedienteFor(CADENA, "cliente"), "Expediente SOL-0001 → COT-0004 → PV-0005 → FV-0008");
  // Sin nada visible no se imprime la palabra "Expediente" con nada atrás.
  assert.equal(expedienteFor("SC-0002 → OC-0006", "cliente"), "");
  assert.equal(expedienteFor("", "proveedor"), "");
  assert.equal(expedienteFor(null, "proveedor"), "");
  // COT no es OC, SOL no es SC: el filtro es por serie completa.
  assert.equal(dealLineFor("COT-0001 → OC-0002", "proveedor"), "OC-0002");
  assert.equal(dealLineFor("SOL-0001 → SC-0002", "cliente"), "SOL-0001");
  // El folio de Compaq de un saldo importado no es de ninguna serie: no sale en la cadena.
  assert.equal(dealLineFor("PV-0001 → A-292", "cliente"), "PV-0001");
});

// ---------------------------------------------------------------------------
// Factura: el origen interno se traduce, nunca se imprime tal cual
// ---------------------------------------------------------------------------
test("la partida de la factura dice lo que el tercero entiende", () => {
  assert.equal(invoiceLineLabel({ name: "A-292", origin: "Corte Compaq" }), "Saldo de factura A-292");
  assert.equal(invoiceLineLabel({ name: "FV-0002", origin: "PV-0002" }), "Mercancía según pedido PV-0002");
  assert.equal(invoiceLineLabel({ name: "FP-0001", origin: "OC-0004" }), "Mercancía según orden OC-0004");
  assert.equal(invoiceLineLabel({ name: "FI-0007", origin: "Mora FV-0002", invClass: "interest" }), "Intereses moratorios de FV-0002");
  assert.equal(invoiceLineLabel({ name: "ATC-0001", origin: "Ajuste TC FV-0003", invClass: "fx" }), "Ajuste por tipo de cambio de FV-0003");
  for (const l of [
    invoiceLineLabel({ name: "A-292", origin: "Corte Compaq" }),
    invoiceLineLabel({ name: "FI-0007", origin: "Mora FV-0002", invClass: "interest" }),
  ]) limpio(l, "la partida de la factura");
});

// ---------------------------------------------------------------------------
// La factura de intereses explica su cuenta: fórmula y cifras, no de dónde sale la tasa
// ---------------------------------------------------------------------------
test("la FI dice cargo × tasa × días / 360 y la comisión/FEGA, sin decir de dónde sale la tasa", () => {
  const t = interestInvoiceClientCalc({
    currency: "MXN",
    asOf: "2027-03-02",
    capital: 156849.85,
    annualRate: 0.159,
    days: 30,
    interestAccrued: 2078.26,
    interestBefore: 0,
    interestNew: 2078.26,
    fegaRate: 0.0304,
    commissionRate: 0.01,
    fegaNew: 4768.24,
  });
  assert.ok(t.includes("cargo original $156,849.85 × tasa anual 15.9% × 30 días vencidos / 360 = $2,078.26"), t);
  assert.ok(t.includes("comisión 1% + FEGA 2.04% sobre el cargo original, una sola vez: $4,768.24"), t);
  assert.ok(t.includes("Total de esta factura: $6,846.50"), t);
  assert.ok(!t.includes("TIIE"), "la tasa se da como un solo número: no se descompone");
  limpio(t, "la explicación de la FI");
  // Segunda FI del mismo documento: dice qué ya se facturó antes.
  const t2 = interestInvoiceClientCalc({
    currency: "MXN", asOf: "2027-04-01", capital: 156849.85, annualRate: 0.159, days: 60,
    interestAccrued: 4156.52, interestBefore: 2078.26, interestNew: 2078.26, fegaRate: 0.0304, commissionRate: 0.01, fegaNew: 0,
  });
  assert.ok(t2.includes("Ya facturado en documentos anteriores: $2,078.26. En esta factura: $2,078.26."), t2);
  assert.ok(!t2.includes("FEGA"), "sin FEGA nuevo no se menciona");
  assert.ok(t2.includes("Total de esta factura: $2,078.26"), t2);
});

// ---------------------------------------------------------------------------
// Cableado: cada papel y cada mensaje lee de doc-text, y lo viejo se fue
// ---------------------------------------------------------------------------
test("cableado: estado de cuenta", () => {
  const ec = src("src/routes/statements.tsx");
  assert.ok(ec.includes("rows: rows.map((r) => rowCells(r, cur, withFx, true)),"), "el papel usa las celdas en modo papel");
  assert.ok(ec.includes('rowCells(r, r.currency || "MXN", false, true).join(" | ")'), "y el documento guardado también");
  assert.ok(ec.includes("const why = (t: string) => (paper ? PAPER_DASH : t);"), "en pantalla el motivo, en papel el guion");
  assert.ok(ec.includes("notes: statementNotes(ratesOf(st)),"), "las notas salen de doc-text");
  assert.ok(ec.includes("notes: CONSOLIDADO_NOTE,"), "el consolidado también");
  assert.ok(ec.includes('extra={[statementSendHeader(rates), ...rows.map((r) => statementSendLine(r))].join("\\n")}'), "el mensaje también, con la regla para comprobar cada renglón");
  assert.ok(!slice(ec, "function printStatement", "function Page").includes("Compaq"), "el papel ya no nombra Compaq");
  // La pantalla sí conserva su explicación completa: es para operar.
  const panel = slice(ec, "function StatementView", "Por producto — saldo pendiente");
  assert.ok(panel.includes("Toca el interés para ver el desglose."), "la instrucción de pantalla se queda en pantalla");
  assert.ok(panel.includes("spread ASR"), "y el porqué de la tasa de costo también, ahí sí");
});

test("cableado: cotización, pedido, guía", () => {
  const q = src("src/routes/quotes.tsx");
  assert.ok(q.includes("notes: quoteNotes({ notes: qrow.notes, deliveryTo: qrow.delivery_to }),"));
  assert.ok(q.includes('expedienteFor(trail, "cliente"),'));
  const papel = slice(q, "printHtml(", "return (");
  assert.ok(!papel.includes("financiamiento incluido"), "el cliente ve dos precios; la diferencia la entiende solo");
  assert.ok(!papel.includes("Mora no entra aquí"), "eso es lenguaje nuestro (la ayuda de pantalla sí puede decirlo)");
  const pv = src("src/routes/sales.$orderId.tsx");
  assert.ok(pv.includes('expedienteFor(trail, "cliente")'));
  assert.ok(!slice(pv, "guiaSheet({", "Imprimir / PDF").includes("expediente:"), "la guía no lleva la cadena de folios");
});

test("cableado: orden de compra y solicitud de cotización al proveedor", () => {
  const oc = src("src/routes/purchases.tsx");
  assert.ok(oc.includes('expedienteFor([o.rfq_name, o.so_name, o.name].filter(Boolean).join(" → "), "proveedor"),'), "al proveedor solo SC/OC");
  assert.ok(oc.includes("notes: PURCHASE_ORDER_NOTE,"));
  assert.ok(!oc.includes("Documento al proveedor"), "sin etiquetas para nosotros mismos");
  const dt = src("src/lib/erp/doc-text.ts");
  assert.ok(dt.includes('export const RFQ_MESSAGE = "Favor de cotizar estas partidas y responder precio por unidad.";'), "el texto exacto del dueño");
  assert.ok(!dt.includes("reposición de inventario"), "nunca decimos para qué compramos");
  assert.ok(src("src/routes/rfq.$rfqId.tsx").includes("extra={RFQ_MESSAGE}"));
  assert.ok(src("src/routes/solicitudes.$solicitudId.tsx").includes("extra={rfqMessage(deliveryNote)}"));
});

test("cableado: factura y factura de intereses", () => {
  const cr = src("src/routes/credit.tsx");
  assert.ok(cr.includes("left: invoiceLineLabel({ name: r.name, origin: r.origin, invClass: r.inv_class }),"), "la partida se traduce");
  assert.ok(!cr.includes("left: r.origin || r.name"), "el origen interno ya no se imprime tal cual");
  assert.ok(cr.includes("const expediente = expedienteFor(trail, audience);"), "expediente filtrado según quién recibe");
  assert.ok(cr.includes('totalLabel: "Saldo",'));
  assert.ok(cr.includes("r.calc_client || interestInvoiceFallback("), "la FI explica su cuenta; las viejas, lo que tienen guardado");
  const ops = src("src/lib/erp/ops.ts");
  const fi = slice(ops, "export async function issueMoraInvoice", "export const invoiceLiveMora");
  assert.ok(fi.includes("const calcClient = interestInvoiceClientCalc({"), "la explicación se escribe el día que se emite");
  assert.ok(fi.includes("created_by, calc, calc_client, int_part, fega_part"), "y se guarda en la FI");
  assert.ok(src("src/lib/erp/stock.ts").includes("add column if not exists calc_client text not null default ''"));
  assert.ok(existsSync(join(root, "migrations/0023_fi_explicacion_cliente.sql")), "la columna también va en migración para producción");
  assert.ok(src("src/lib/azagro.ts").includes("coalesce(i.calc_client, '') as calc_client"), "Cartera la trae para imprimirla");
});

test("cableado: el ajuste por tipo de cambio imprime su fórmula, y esa fórmula es limpia", () => {
  const cr = src("src/routes/credit.tsx");
  assert.ok(cr.includes("? fxAdjustmentNote(r.calc)"), "el ATC explica su cuenta");
  const ops = src("src/lib/erp/ops.ts");
  const plantilla = slice(ops, "const calc = `${usdApplied.toFixed(2)} USD", ";");
  limpio(plantilla, "la cuenta guardada del ajuste por tipo de cambio");
  assert.ok(plantilla.includes("TC pagado") && plantilla.includes("pactado"), "USD × (TC pagado − TC pactado)");
});
