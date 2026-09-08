// Sesión de recotizar (hallazgo 4, SESIÓN D, 7-sep-2026): la cotización
// vencida o rechazada era un callejón sin salida. Este archivo fija:
// 1) los cuatro casos del candado nuevo (quoteStillBlocks);
// 2) que la vigencia se capture por cotización, propuesta de Ajustes;
// 3) el camino (b) — nace una cotización nueva, la vieja se conserva — para
//    solicitud (quoteFromRequest) y para cotización directa (duplicateQuote),
//    con las tasas de HOY, nunca copiadas.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

function fnBody(source, name) {
  const start = source.indexOf(`export const ${name} `);
  assert.notEqual(start, -1, `No existe export const ${name}`);
  const rest = source.slice(start + 10);
  const next = rest.search(/\nexport /);
  return next === -1 ? rest : rest.slice(0, next);
}

// ---------------------------------------------------------------------------
// 1) Copia literal de quoteStillBlocks (request-lock.ts) — los cuatro casos.
// ---------------------------------------------------------------------------
function quoteStillBlocks(state, validUntil, today) {
  if (state === "accepted" || state === "partial") return true;
  if (state === "rejected" || state === "cancelled") return false;
  return validUntil >= today;
}

test("candado — viva (draft/sent, vigente): bloquea", () => {
  assert.equal(quoteStillBlocks("draft", "2026-09-20", "2026-09-07"), true);
  assert.equal(quoteStillBlocks("sent", "2026-09-20", "2026-09-07"), true);
  // El mismo día de la vigencia todavía cuenta como vigente.
  assert.equal(quoteStillBlocks("sent", "2026-09-07", "2026-09-07"), true);
});

test("candado — rechazada: libera, sin importar la vigencia", () => {
  assert.equal(quoteStillBlocks("rejected", "2026-12-31", "2026-09-07"), false);
  assert.equal(quoteStillBlocks("rejected", "2026-01-01", "2026-09-07"), false);
});

test("candado — vencida sin decidir (draft/sent, valid_until < hoy): libera", () => {
  assert.equal(quoteStillBlocks("draft", "2026-08-01", "2026-09-07"), false);
  assert.equal(quoteStillBlocks("sent", "2026-09-06", "2026-09-07"), false);
});

test("candado — cancelada (BLOQUE DE DESHACER paso 1, Decisión 18): libera igual que rechazada, sin importar la vigencia", () => {
  assert.equal(quoteStillBlocks("cancelled", "2026-12-31", "2026-09-07"), false);
  assert.equal(quoteStillBlocks("cancelled", "2026-01-01", "2026-09-07"), false);
});

test("candado — aceptada: NUNCA libera, pase lo que pase con la vigencia (ya es un pedido)", () => {
  assert.equal(quoteStillBlocks("accepted", "2020-01-01", "2026-09-07"), true, "aceptada hace 6 años sigue bloqueando");
  assert.equal(quoteStillBlocks("accepted", "2099-01-01", "2026-09-07"), true);
  // Parcial: ya generó pedido para parte de la partida — misma regla que aceptada.
  assert.equal(quoteStillBlocks("partial", "2020-01-01", "2026-09-07"), true, "parcial hace 6 años sigue bloqueando");
});

// ---------------------------------------------------------------------------
// 2) Cableado: el candado real usa esta misma función, en los tres lugares
//    que hoy la necesitan (solicitud, RFQ del proveedor, y el guardián de
//    quoteFromRequest que evita duplicar mientras la cotización siga viva).
// ---------------------------------------------------------------------------
test("cableado: request-lock.ts exporta quoteStillBlocks y lo usan assertRequestOpen y assertRfqOpen", () => {
  const lock = src("src/lib/erp/request-lock.ts");
  assert.ok(lock.includes("export function quoteStillBlocks(state: string, validUntil: string, today: string): boolean"), "falta exportar la función");
  assert.ok(fnBody2(lock, "assertRequestOpen").includes("quoteStillBlocks("), "assertRequestOpen debe usarla");
  assert.ok(fnBody2(lock, "assertRfqOpen").includes("quoteStillBlocks("), "assertRfqOpen debe usarla");
  // Las dos consultan estado y vigencia de la cotización ligada, no solo su existencia.
  assert.ok(lock.includes("q.state as quote_state, q.valid_until::text as quote_valid_until"), "assertRequestOpen necesita estado y vigencia");
  function fnBody2(source, name) {
    const start = source.indexOf(`export async function ${name}(`);
    assert.notEqual(start, -1, `No existe ${name} en request-lock.ts`);
    const rest = source.slice(start);
    const next = rest.slice(1).search(/\nexport /);
    return next === -1 ? rest : rest.slice(0, next + 1);
  }
});

test("cableado: quoteFromRequest solo bloquea duplicar si la cotización ligada sigue viva", () => {
  const req = src("src/lib/erp/requests.ts");
  const body = fnBody(req, "quoteFromRequest");
  assert.ok(body.includes("quoteStillBlocks(ex[0].state, ex[0].valid_until, today)"), "el guardián debe consultar quoteStillBlocks");
  assert.ok(body.includes('"quotes", "edit"'), "sigue exigiendo permiso");
  // Registro de a qué cotización reemplaza, para que quede en bitácora.
  assert.ok(body.includes("reemplaza a ${previousQuote.name}"), "la bitácora debe decir qué cotización reemplazó");
});

// ---------------------------------------------------------------------------
// 3) Vigencia: se captura por cotización (createQuote ya lo hacía;
//    quoteFromRequest y la pantalla directa dejaron de escribir 15 en código).
// ---------------------------------------------------------------------------
test("vigencia: nadie escribe 15 en el servidor ni en las pantallas — sale de Ajustes", () => {
  const req = src("src/lib/erp/requests.ts");
  const ops = src("src/lib/erp/ops.ts");
  const quotesUi = src("src/routes/quotes.tsx");
  const solUi = src("src/routes/solicitudes.$solicitudId.tsx");
  for (const [label, s] of [["requests.ts", req], ["ops.ts", ops], ["quotes.tsx", quotesUi], ["solicitudes.$solicitudId.tsx", solUi]]) {
    assert.ok(!/addDays\([^,]+,\s*15\)/.test(s), `${label}: no debe quedar un addDays(..., 15)`);
  }
  assert.ok(fnBody(req, "quoteFromRequest").includes("validUntil: z.string()"), "quoteFromRequest debe recibir la vigencia capturada");
  assert.ok(quotesUi.includes('const [validUntil, setValidUntil] = useState("");'), "la pantalla directa nace vacía, no con un 15");
  assert.ok(quotesUi.includes("s.quoteValidityDays > 0 ? addDays(todayMx(), s.quoteValidityDays)"), "la pantalla directa propone de Ajustes");
  assert.ok(solUi.includes("s.quoteValidityDays > 0 ? addDays(hoy, s.quoteValidityDays)"), "la solicitud también propone de Ajustes");
});

test("Ajustes: quoteValidityDays vive en POLICY_FIELDS, sin default, y se guarda/lee en company_settings", () => {
  const ops = src("src/lib/erp/ops.ts");
  assert.ok(ops.includes('["quoteValidityDays", "vigencia de cotización (días)"]'), "falta en POLICY_FIELDS");
  assert.ok(ops.includes("quote_validity_days integer"), "falta la columna (migración/ensure)");
  assert.ok(ops.includes("quoteValidityDays: num(r?.quote_validity_days)"), "readPolicy debe leerla, nula si no está capturada");
  assert.ok(ops.includes("quoteValidityDays: z.number().int().positive().max(365)"), "saveSettings debe validarla");
  assert.ok(ops.includes("quote_validity_days = excluded.quote_validity_days"), "el UPDATE debe guardarla");
  const mig = src("migrations/0028_vigencia_cotizacion.sql");
  assert.ok(mig.includes("alter table company_settings add column if not exists quote_validity_days integer"), "migración 0028");
  assert.ok(!/quote_validity_days integer not null default/.test(mig), "sin NOT NULL ni default: nace vacía como todo lo demás (regla 9)");
  const settingsUi = src("src/routes/settings.tsx");
  assert.ok(settingsUi.includes('quoteValidityDays: null'), "el formulario nace sin valor de respaldo");
  assert.ok(settingsUi.includes('numInput("quoteValidityDays")'), "falta el campo en la pantalla de Ajustes");
});

// ---------------------------------------------------------------------------
// 4) duplicateQuote: solo cotizaciones DIRECTAS y MUERTAS; tasas de HOY, no
//    copiadas; márgenes, cliente, productos y cantidades sí se heredan; la
//    vieja se conserva intacta (no se borra, no se sobreescribe).
// ---------------------------------------------------------------------------
test("duplicateQuote: rechaza cotizaciones ligadas a solicitud y cotizaciones todavía vivas", () => {
  const ops = src("src/lib/erp/ops.ts");
  const body = fnBody(ops, "duplicateQuote");
  assert.ok(body.includes("if (old[0].request_id)"), "debe rechazar cotizaciones con solicitud");
  assert.ok(body.includes("vuelve a la solicitud y cotiza de nuevo"), "mensaje debe mandar a la solicitud");
  assert.ok(body.includes("quoteStillBlocks(old[0].state, old[0].valid_until, today)"), "debe usar el mismo candado");
  assert.ok(body.includes("sigue vigente"), "mensaje debe explicar por qué no se puede duplicar");
});

test("duplicateQuote: las tasas se resuelven de HOY, nunca se leen de la cotización vieja", () => {
  const ops = src("src/lib/erp/ops.ts");
  const body = fnBody(ops, "duplicateQuote");
  // El SELECT de la cotización vieja no trae tiie/spread/commission_rate: si
  // los trajera, sería tentador copiarlos en vez de recalcular.
  const oldSelectEnd = body.indexOf("from quotes where id = ${data.quoteId}");
  const oldSelect = body.slice(0, oldSelectEnd);
  for (const forbidden of ["tiie", "spread", "commission_rate", "cost_rate", "collection_rate"]) {
    assert.ok(!oldSelect.includes(forbidden), `el SELECT de la cotización vieja no debe traer ${forbidden}`);
  }
  // Las tasas nuevas salen de la tabla de hoy (priceRateFor / tiieTableOf), no de old[0].
  assert.ok(body.includes("priceRateFor(sql, cid, terms, today)"), "lineal: tasa de cobro de hoy");
  assert.ok(body.includes("nearestRate(await tiieTableOf(sql, cid), today)"), "ASR: TIIE de hoy");
  assert.ok(!body.includes("old[0].tiie") && !body.includes("old[0].spread"), "nunca copia tiie/spread de la vieja");
});

test("duplicateQuote: hereda cliente, productos, cantidades y márgenes de la cotización vieja", () => {
  const ops = src("src/lib/erp/ops.ts");
  const body = fnBody(ops, "duplicateQuote");
  assert.ok(body.includes("old[0].partner_id"), "mismo cliente");
  assert.ok(body.includes("select ql.product_id, p.code, ql.qty::text"), "mismos productos y cantidades");
  assert.ok(body.includes('marginOf(l, "cash")') && body.includes('marginOf(l, "credit")'), "mismos márgenes (cash y credit)");
  // El costo SÍ se resuelve de nuevo (kardex/referencia de hoy, como cualquier
  // cotización nueva) — no se copia el costo congelado de la cotización vieja.
  assert.ok(body.includes("const costoDe = (productId: number)"), "el costo se resuelve de nuevo, no se copia");
});

test("duplicateQuote: nace borrador nuevo, con folio propio; la vieja no se toca", () => {
  const ops = src("src/lib/erp/ops.ts");
  const body = fnBody(ops, "duplicateQuote");
  assert.ok(body.includes("'draft'"), "nace borrador, no se envía sola");
  assert.ok(body.includes("`COT-${String((n[0]?.c ?? 0) + 1).padStart(4, \"0\")}`"), "folio nuevo, propio conteo");
  assert.ok(!/update quotes set/.test(body), "no debe tocar la cotización vieja con un UPDATE");
  assert.ok(!/delete from quotes/.test(body), "no debe borrar la cotización vieja");
  assert.ok(body.includes("Duplicada de ${old[0].name}"), "la bitácora/nota debe decir de cuál viene");
});

// ---------------------------------------------------------------------------
// 5) Pantalla: la solicitud distingue viva/rechazada/vencida; la cotización
//    directa ofrece "Duplicar" solo cuando aplica (muerta y sin solicitud).
// ---------------------------------------------------------------------------
test("pantalla de la solicitud: quoteDead se calcula con quoteStillBlocks y libera el candado", () => {
  const ui = src("src/routes/solicitudes.$solicitudId.tsx");
  assert.ok(ui.includes("const quoteDead = Boolean(quote) && !quoteStillBlocks(quote!.state, quote!.valid_until, todayMx());"), "quoteDead debe usar quoteStillBlocks");
  assert.ok(ui.includes('quoteFromRequest({') && ui.includes("validUntil,"), "el botón de cotizar debe mandar la vigencia capturada");
  assert.ok(ui.includes('{quoteDead ? "Cotizar de nuevo" : "Crear y enviar cotización al cliente"}'), "el botón debe cambiar de texto cuando la vieja murió");
});

test("pantalla de cotizaciones: Duplicar solo para cotizaciones directas muertas", () => {
  const ui = src("src/routes/quotes.tsx");
  assert.ok(
    ui.includes('!qrow.request_name && (qrow.state === "rejected" || qrow.state === "cancelled" || expired)'),
    "el botón debe filtrar directa + muerta (rechazada, cancelada o vencida — BLOQUE DE DESHACER paso 0)",
  );
  assert.ok(ui.includes("duplicateQuote({ data: { quoteId: qrow.id } })"), "debe llamar duplicateQuote");
});

// ---------------------------------------------------------------------------
// 6) Los mensajes que antes prometían un camino que no existía ahora dicen
//    lo cierto: no más "Renegocia o emite otra cotización".
// ---------------------------------------------------------------------------
test("los mensajes de vigencia vencida ya no prometen 'renegocia'", () => {
  const ops = src("src/lib/erp/ops.ts");
  const quotesUi = src("src/routes/quotes.tsx");
  assert.ok(!ops.includes("Renegocia o emite otra cotización"), "ops.ts: mensaje viejo debe desaparecer");
  assert.ok(!quotesUi.includes("Renegocia o emite otra cotización"), "quotes.tsx: mensaje viejo debe desaparecer");
});
