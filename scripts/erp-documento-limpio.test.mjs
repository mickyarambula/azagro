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
    `Sobre la factura ${i.docName}: vence ${dateDMY(i.docDue)} · interés desde ${dateDMY(i.interestFrom)}.`,
    `Intereses moratorios al ${dateDMY(i.asOf)}: cargo original ${m(i.capital)} × tasa anual ${pctRate(i.annualRate)} × ${i.days} días vencidos desde el ${dateDMY(i.interestFrom)} / 360 = ${m(i.interestAccrued)}.`,
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
    docName: "FV-0002",
    docDue: "2027-01-01",
    interestFrom: "2027-01-31",
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
  assert.ok(t.startsWith("Sobre la factura FV-0002: vence 01/01/2027 · interés desde 31/01/2027."), "las dos fechas, iguales a las del estado de cuenta");
  assert.ok(t.includes("cargo original $156,849.85 × tasa anual 15.9% × 30 días vencidos desde el 31/01/2027 / 360 = $2,078.26"), t);
  assert.ok(t.includes("comisión 1% + FEGA 2.04% sobre el cargo original, una sola vez: $4,768.24"), t);
  assert.ok(t.includes("Total de esta factura: $6,846.50"), t);
  assert.ok(!t.includes("TIIE"), "la tasa se da como un solo número: no se descompone");
  limpio(t, "la explicación de la FI");
  // Segunda FI del mismo documento: dice qué ya se facturó antes.
  const t2 = interestInvoiceClientCalc({
    currency: "MXN", asOf: "2027-04-01", docName: "FV-0002", docDue: "2027-01-01", interestFrom: "2027-01-31", capital: 156849.85, annualRate: 0.159, days: 60,
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
  assert.ok(ec.includes("headers: statementPaperHeaders(withFx),"), "el papel tiene sus propias columnas (doc-text)");
  assert.ok(ec.includes("rows: rows.map((r) => statementPaperRow(r, cur, withFx)),"), "y sus propias celdas");
  assert.ok(ec.includes("totals: statementPaperTotals(rows, cur, withFx),"), "y su total");
  assert.ok(
    ec.includes('STATEMENT_PAPER_HEADERS.join(" | ")') && ec.includes('statementPaperRow(r, r.currency || "MXN", false).join(" | ")'),
    "el documento guardado es el mismo papel",
  );
  assert.ok(ec.includes("notes: statementNotes(ratesOf(st)),"), "las notas salen de doc-text");
  assert.ok(ec.includes("notes: CONSOLIDADO_NOTE,"), "el consolidado también");
  assert.ok(ec.includes('extra={[statementSendHeader(rates), ...rows.map((r) => statementSendLine(r))].join("\\n")}'), "el mensaje también, con la regla para comprobar cada renglón");
  assert.ok(ec.includes("TIIE a la fecha de interés +"), "la tasa se nombra por la fecha desde la que corre");
  assert.ok(!slice(ec, "function printStatement", "function Page").includes("Compaq"), "el papel ya no nombra Compaq");
  // La pantalla sí conserva su explicación completa y sus columnas: es para operar.
  const panel = slice(ec, "function StatementView", "Por producto — saldo pendiente");
  assert.ok(panel.includes("Toca el interés para ver el desglose."), "la instrucción de pantalla se queda en pantalla");
  assert.ok(panel.includes("spread ASR"), "y el porqué de la tasa de costo también, ahí sí");
  assert.ok(ec.includes('"Pronto pago (est.)",') && ec.includes('"Plazo",'), "en pantalla siguen Plazo y Pronto pago");
  assert.ok(ec.includes('r.sinMora ? "sin mora"') && ec.includes('r.sinPolitica ? "sin política"'), "y el motivo real de cada celda");
  const dt = src("src/lib/erp/doc-text.ts");
  assert.ok(!/pronto pago/i.test(sinComentarios(dt)), "ningún texto que sale menciona el pronto pago");
  assert.ok(dt.includes('export const PAPER_PENDING = "Pendiente de cálculo";'));
});

// Copia de statementPaperRow / statementPaperTotals (doc-text.ts).
const PAPER_DASH = "—";
const PAPER_PENDING = "Pendiente de cálculo";
const STATEMENT_PAPER_HEADERS = ["Serie", "Folio", "Fecha", "Vence", "Interés desde", "Cargo", "Abonos", "Saldo", "Fecha pago", "Días vencidos (desde interés)", "Interés s/ días", "Comisión + FEGA", "Total int+FEGA"];
function statementPaperRow(r, cur, withFx) {
  const money = (n) => moneyIn(n, cur);
  const interes = r.sinMora ? PAPER_DASH : !r.vencido ? "—" : r.sinTiie ? PAPER_PENDING : Math.abs(r.interes) > 0.009 ? money(r.interes) : "—";
  const pend = r.sinTiie || r.sinPolitica;
  const comision = r.sinMora ? PAPER_DASH : !r.vencido ? "—" : pend ? PAPER_PENDING : r.comisionFega > 0.009 ? money(r.comisionFega) : "—";
  const total = r.sinMora ? PAPER_DASH : !r.vencido ? "—" : pend ? PAPER_PENDING : Math.abs(r.totalFinanciero) > 0.009 ? money(r.totalFinanciero) : "—";
  const cells = [
    r.serie || "—", r.folio || r.name, dateDMY(r.date), dateDMY(r.due_date), r.sinMora ? PAPER_DASH : dateDMY(r.moraDue),
    money(r.cargo), r.abono ? money(r.abono) : "—", money(r.saldo),
    r.fechaPago ? dateDMY(r.fechaPago) : r.fechaAbono ? dateDMY(r.fechaAbono) : "—",
    r.sinMora ? PAPER_DASH : r.vencido ? String(r.daysVencidos) : `faltan ${r.diasPorVencer}`,
    interes, comision, total,
  ];
  if (withFx) cells.push(Math.abs(r.utCambiaria) > 0.009 ? money(r.utCambiaria) : "—");
  return cells;
}
function statementPaperTotals(rows, cur, withFx) {
  const sum = (f) => moneyIn(rows.reduce((s, r) => s + f(r), 0), cur);
  const cells = ["", "Total", "", "", "", sum((r) => r.cargo), sum((r) => r.abono), sum((r) => r.saldo), "", "", sum((r) => r.interes), sum((r) => r.comisionFega), sum((r) => r.totalFinanciero)];
  if (withFx) cells.push(sum((r) => r.utCambiaria));
  return cells;
}

test("el papel del estado de cuenta: dos fechas, sin Plazo, sin pronto pago, días ligados a la fecha de interés", () => {
  assert.ok(!STATEMENT_PAPER_HEADERS.includes("Plazo"), "Plazo armaba la confusión y no le sirve al cliente");
  assert.ok(!STATEMENT_PAPER_HEADERS.some((h) => /pronto pago/i.test(h)), "pronto pago solo en pantalla");
  assert.equal(STATEMENT_PAPER_HEADERS.indexOf("Interés desde"), STATEMENT_PAPER_HEADERS.indexOf("Vence") + 1, "las dos fechas, juntas");
  assert.ok(STATEMENT_PAPER_HEADERS.includes("Días vencidos (desde interés)"), "los días dicen desde cuál fecha se cuentan");
  const base = {
    serie: "FV", folio: "0002", name: "FV-0002", date: "2026-09-03", due_date: "2027-01-01", moraDue: "2027-01-31",
    cargo: 156849.85, abono: 0, saldo: 156849.85, fechaPago: null, fechaAbono: null,
    sinMora: false, sinTiie: false, sinPolitica: false, interes: 0, comisionFega: 0, totalFinanciero: 0, utCambiaria: 0,
  };
  // Antes de la fecha de interés: las dos fechas y cuántos días faltan para la segunda.
  const porVencer = statementPaperRow({ ...base, vencido: false, diasPorVencer: 150, daysVencidos: -150 }, "MXN", false);
  assert.equal(porVencer.length, STATEMENT_PAPER_HEADERS.length);
  assert.equal(porVencer[3], "01/01/2027");
  assert.equal(porVencer[4], "31/01/2027");
  assert.equal(porVencer[9], "faltan 150");
  assert.deepEqual(porVencer.slice(10, 13), ["—", "—", "—"]);
  // Vencida con interés: los días son desde la fecha de interés.
  const vencida = statementPaperRow({ ...base, vencido: true, diasPorVencer: 0, daysVencidos: 30, interes: 2078.26, comisionFega: 4768.24, totalFinanciero: 6846.5 }, "MXN", false);
  assert.equal(vencida[9], "30");
  assert.equal(vencida[10], "$2,078.26");
  assert.equal(vencida[12], "$6,846.50");
  // Vencida sin TIIE o sin política: «Pendiente de cálculo», ni guion ni cero.
  const sinTiie = statementPaperRow({ ...base, vencido: true, diasPorVencer: 0, daysVencidos: 30, sinTiie: true }, "MXN", false);
  assert.deepEqual(sinTiie.slice(10, 13), [PAPER_PENDING, PAPER_PENDING, PAPER_PENDING]);
  const sinPol = statementPaperRow({ ...base, vencido: true, diasPorVencer: 0, daysVencidos: 30, sinPolitica: true, interes: 2078.26 }, "MXN", false);
  assert.equal(sinPol[10], "$2,078.26", "el interés sí se sabe");
  assert.deepEqual(sinPol.slice(11, 13), [PAPER_PENDING, PAPER_PENDING], "comisión y FEGA no");
  // Sin mora: no hay fecha de interés, ni días, ni cargos — guion, no pendiente.
  const sinMora = statementPaperRow({ ...base, vencido: true, diasPorVencer: 0, daysVencidos: 40, sinMora: true }, "MXN", false);
  assert.equal(sinMora[4], PAPER_DASH);
  assert.equal(sinMora[9], PAPER_DASH);
  assert.deepEqual(sinMora.slice(10, 13), [PAPER_DASH, PAPER_DASH, PAPER_DASH]);
  // USD lleva una columna más, y el total tiene tantas celdas como encabezados.
  assert.equal(statementPaperRow({ ...base, vencido: false, diasPorVencer: 10, daysVencidos: -10, utCambiaria: 120 }, "USD", true).length, STATEMENT_PAPER_HEADERS.length + 1);
  const tot = statementPaperTotals([{ ...base, vencido: true, diasPorVencer: 0, daysVencidos: 30, interes: 2078.26, comisionFega: 4768.24, totalFinanciero: 6846.5 }], "MXN", false);
  assert.equal(tot.length, STATEMENT_PAPER_HEADERS.length);
  assert.equal(tot[12], "$6,846.50");
  for (const c of [...porVencer, ...vencida, ...sinTiie, ...sinMora, ...tot, ...STATEMENT_PAPER_HEADERS]) limpio(String(c), "una celda del papel");
});

// Copia de paperOfferOf (quotes.tsx): un solo precio en el papel.
function paperOfferOf(q) {
  if (q.accepted_offer === "cash" || q.accepted_offer === "credit") return q.accepted_offer;
  const quoted = q.price_offer || "both";
  if (quoted === "cash" || quoted === "credit") return quoted;
  return q.credit_days ? "credit" : "cash";
}

test("la cotización imprime un solo precio: el aceptado; si no, el cotizado; si se cotizaron los dos, el del plazo", () => {
  assert.equal(paperOfferOf({ price_offer: "both", accepted_offer: "cash", credit_days: 150 }), "cash", "lo que aceptó el cliente manda");
  assert.equal(paperOfferOf({ price_offer: "both", accepted_offer: "credit", credit_days: 150 }), "credit");
  assert.equal(paperOfferOf({ price_offer: "cash", accepted_offer: null, credit_days: 150 }), "cash", "se cotizó solo contado");
  assert.equal(paperOfferOf({ price_offer: "credit", accepted_offer: null, credit_days: 150 }), "credit");
  assert.equal(paperOfferOf({ price_offer: "both", accepted_offer: null, credit_days: 150 }), "credit", "dos cotizados, sin aceptar: el del plazo");
  assert.equal(paperOfferOf({ price_offer: "both", accepted_offer: null, credit_days: 0 }), "cash", "sin plazo no hay crédito que imprimir");
});

test("cableado: cotización, pedido, guía", () => {
  const q = src("src/routes/quotes.tsx");
  assert.ok(q.includes("notes: quoteNotes({ notes: qrow.notes, deliveryTo: qrow.delivery_to }),"));
  assert.ok(q.includes('expedienteFor(trail, "cliente"),'));
  assert.ok(q.includes("const offer = paperOfferOf(qrow);"), "un solo precio en el papel: el de la oferta acordada");
  assert.ok(!slice(q, "async function printQuote", "return (").includes("Imp. contado"), "nunca los dos");
  assert.ok(q.includes("paperOfferLabel(offer, qrow.credit_days),"), "con sus días si es a crédito");
  assert.ok(q.includes("unitPrice: paperUnit(l),"), "y el mensaje lleva ese mismo precio único");
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
  assert.ok(fi.includes("docDue: inv[0].due_date,") && fi.includes("interestFrom: moraDue,"), "con las dos fechas de la factura, para que cuadre con el estado de cuenta");
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
