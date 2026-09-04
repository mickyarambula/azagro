// COMISIÓN Y FEGA OPCIONALES POR CLIENTE (3-sep-2026, prueba con el dueño).
//
// La política de mora ya se elige por documento (y por omisión según el grupo
// del cliente). Ahora esa política lleva dos interruptores: cobra comisión
// sí/no, cobra FEGA sí/no, porque se negocia distinto con cada cliente. Los
// PORCENTAJES siguen saliendo de Ajustes (comisión + FEGA, y la comisión que va
// dentro); la política solo dice cuál de las dos mitades se cobra.
//
// Nacen sin capturar (migración 0021) y no se les inventa valor: mientras no se
// contesten las dos preguntas, el estado de cuenta marca la fila y la factura
// de intereses se detiene.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

/** Copias de src/lib/erp/credit.ts. */
function splitFegaBundle(fegaRate, commissionRate) {
  const commission = Math.min(Math.max(0, commissionRate), Math.max(0, fegaRate));
  return { commission, fega: Math.max(0, fegaRate - commission), bundle: fegaRate };
}
function chargesCaptured(on) {
  return on != null && typeof on.commission === "boolean" && typeof on.fega === "boolean";
}
function chargeRates(fegaRate, commissionRate, on) {
  const split = splitFegaBundle(fegaRate, commissionRate);
  const commission = on.commission ? split.commission : 0;
  const fega = on.fega ? split.fega : 0;
  return { fegaRate: commission + fega, commissionRate: commission, fegaOnlyRate: fega };
}

// Ajustes: comisión + FEGA 3.04%, con 1% de comisión dentro (FEGA solo 2.04%).
const BUNDLE = 0.0304;
const COMISION = 0.01;
const round4 = (n) => Math.round(n * 10000) / 10000;

test("las dos: se cobra el paquete completo de Ajustes", () => {
  const t = chargeRates(BUNDLE, COMISION, { commission: true, fega: true });
  assert.equal(round4(t.fegaRate), 0.0304);
  assert.equal(round4(t.commissionRate), 0.01);
  assert.equal(round4(t.fegaOnlyRate), 0.0204);
});

test("solo comisión: se cobra la comisión, no el FEGA", () => {
  const t = chargeRates(BUNDLE, COMISION, { commission: true, fega: false });
  assert.equal(round4(t.fegaRate), 0.01);
  assert.equal(round4(t.commissionRate), 0.01);
  assert.equal(round4(t.fegaOnlyRate), 0);
});

test("solo FEGA: se cobra el FEGA, no la comisión", () => {
  const t = chargeRates(BUNDLE, COMISION, { commission: false, fega: true });
  assert.equal(round4(t.fegaRate), 0.0204);
  assert.equal(round4(t.commissionRate), 0);
  assert.equal(round4(t.fegaOnlyRate), 0.0204);
});

test("ninguna: el cargo no lleva comisión ni FEGA (el interés de mora no cambia)", () => {
  const t = chargeRates(BUNDLE, COMISION, { commission: false, fega: false });
  assert.equal(t.fegaRate, 0);
  assert.equal(t.commissionRate, 0);
  assert.equal(t.fegaOnlyRate, 0);
});

test("sobre un cargo real: 156,849.85 con y sin cada mitad", () => {
  const cargo = 156849.85;
  const r2 = (n) => Math.round(n * 100) / 100;
  assert.equal(r2(cargo * chargeRates(BUNDLE, COMISION, { commission: true, fega: true }).fegaRate), 4768.24);
  assert.equal(r2(cargo * chargeRates(BUNDLE, COMISION, { commission: true, fega: false }).fegaRate), 1568.5);
  assert.equal(r2(cargo * chargeRates(BUNDLE, COMISION, { commission: false, fega: true }).fegaRate), 3199.74);
  assert.equal(r2(cargo * chargeRates(BUNDLE, COMISION, { commission: false, fega: false }).fegaRate), 0);
});

test("sin capturar no es «no»: es una pregunta sin contestar", () => {
  assert.equal(chargesCaptured(null), false);
  assert.equal(chargesCaptured({ commission: null, fega: null }), false);
  assert.equal(chargesCaptured({ commission: true, fega: null }), false);
  assert.equal(chargesCaptured({ commission: null, fega: false }), false);
  assert.equal(chargesCaptured({ commission: false, fega: false }), true);
});

test("cableado: la migración 0021 deja los dos interruptores vacíos, sin default", () => {
  const m = src("migrations/0021_politica_comision_fega.sql");
  assert.ok(m.includes("add column if not exists charge_commission boolean"), "cobra comisión sí/no");
  assert.ok(m.includes("add column if not exists charge_fega boolean"), "cobra FEGA sí/no");
  assert.ok(!/default\s+(true|false)/i.test(m), "sin valor por omisión: la decisión es del dueño");
  assert.ok(!/update\s+credit_policies\s+set/i.test(m), "no se tocan las políticas que ya existían");
});

test("cableado: el estado de cuenta obedece los interruptores del documento", () => {
  const ops = src("src/lib/erp/ops.ts");
  const live = ops.slice(ops.indexOf("export const getLiveStatement"), ops.indexOf("export async function issueMoraInvoice"));
  assert.ok(live.includes("const polMap = await creditPolicyMap(sql, cid);"), "se leen las políticas de la empresa");
  assert.ok(live.includes("const politica = polMap.get(inv.policy_code) ?? null;"), "cada factura usa la política con la que nació");
  assert.ok(live.includes("chargeRates(pol.fegaRate, pol.commissionRate, cobra)"), "los porcentajes siguen siendo los de Ajustes");
  assert.ok(live.includes("const sinPolitica = vencido && cobraInteres && cobra == null;"), "sin capturar se marca la fila");
  assert.ok(live.includes("fegaRate: tasas.fegaRate,"), "computeMora / computeStatementLine reciben la tasa efectiva");
  assert.ok(!live.includes("fegaRate: pol.fegaRate,"), "ya nadie cobra el paquete completo a ciegas");
  const ec = src("src/routes/statements.tsx");
  assert.ok(ec.includes('r.sinPolitica ? "sin política"'), "la columna dice «sin política» en vez de un número inventado");
});

test("cableado: la factura de intereses se detiene si la política no está capturada", () => {
  const ops = src("src/lib/erp/ops.ts");
  const fi = ops.slice(ops.indexOf("export async function issueMoraInvoice"), ops.indexOf("export const invoiceLiveMora"));
  assert.ok(fi.includes("if (!chargesCaptured(politica)) {"), "sin los dos interruptores no se emite la FI");
  assert.ok(fi.includes("throw new Error(missingChargesMessage("), "y se avisa con el mensaje único");
  assert.ok(fi.includes("const tasas = chargeRates(pol.fegaRate, pol.commissionRate, cobra);"), "la FI cobra la tasa efectiva de su política");
  assert.ok(fi.includes("fegaRate: tasas.fegaRate,"), "moraBilling recibe esa tasa");
  assert.ok(fi.includes("política ${politica.name}: comisión ${cobra.commission"), "el cálculo guardado dice qué política se aplicó");
});

test("cableado: cambiar una política es de administrador y queda en bitácora", () => {
  const ops = src("src/lib/erp/ops.ts");
  const save = ops.slice(ops.indexOf("export const saveCreditPolicy"), ops.indexOf("export const saveTiie"));
  assert.ok(save.includes("await assertAdmin(sql, context.userId);"), "solo administrador");
  assert.ok(save.includes('action: "politica-cobro"'), "cada cambio va a Bitácora");
  assert.ok(save.includes('const dime = (v: boolean | null) => (v == null ? "sin capturar" : v ? "sí" : "no");'), "anterior → nuevo, con «sin capturar» si no había");
  const st = src("src/routes/settings.tsx");
  assert.ok(st.includes("Políticas de cobro (comisión y FEGA por cliente)"), "Ajustes tiene el panel");
  assert.ok(st.includes('<option value="">sin capturar</option>'), "una política sin capturar se ve vacía, no en «no»");
  assert.ok(st.includes("saveCreditPolicy({ data: { code, commission: e.commission === \"si\", fega: e.fega === \"si\" } })"), "se guardan las dos respuestas juntas");
});

// ---------------------------------------------------------------------------
// «SIN MORA» APAGA EL INTERÉS (3-sep-2026, decisión del dueño).
//
// Hasta hoy la política NONE «Sin mora» no la leía nadie para el interés: la
// mora corría igual con cualquier política, y solo los dos interruptores nuevos
// la consultaban. Ahora sí apaga el interés del documento — es su nombre y su
// única función. Un documento SIN política capturada no entra aquí: ese caso se
// marca «sin política» y se detiene, no se convierte en "sin mora" solo.
// ---------------------------------------------------------------------------

/** Copias de src/lib/erp/credit.ts. */
const NO_MORA_POLICY = "NONE";
function policyChargesInterest(code) {
  return (code || "") !== NO_MORA_POLICY;
}
const YEAR_DAYS = 360;
function daysBetween(from, to) {
  return Math.round((Date.parse(to.slice(0, 10) + "T00:00:00") - Date.parse(from.slice(0, 10) + "T00:00:00")) / 86400000);
}
function computeMora(input) {
  const end = input.paidDate && input.paidDate < input.asOf ? input.paidDate : input.asOf;
  const daysOverdue = Math.max(0, daysBetween(input.dueDate, end));
  const annualRate = input.tiieAtDue + input.spread;
  const cobraInteres = input.chargesInterest !== false;
  const interest = daysOverdue > 0 && cobraInteres ? (input.capital * annualRate * daysOverdue) / YEAR_DAYS : 0;
  const fega = daysOverdue > 0 && !input.fegaAlreadyCharged ? input.capital * input.fegaRate : 0;
  return { daysOverdue, annualRate, interest, fega, mora: interest + fega };
}

const VENCIDA = {
  capital: 156849.85,
  dueDate: "2027-01-31",
  asOf: "2027-03-02", // 30 días vencida
  tiieAtDue: 0.069,
  spread: 0.09,
  fegaAlreadyCharged: false,
};

test("«Sin mora» (NONE) no genera interés; cualquier otra política sí", () => {
  assert.equal(policyChargesInterest("NONE"), false);
  assert.equal(policyChargesInterest("GRUPO_SL"), true);
  assert.equal(policyChargesInterest("ESTANDAR"), true);
  // Sin política capturada NO es "sin mora": se marca y se detiene aparte.
  assert.equal(policyChargesInterest(""), true);
  assert.equal(policyChargesInterest(null), true);
});

test("el documento con «Sin mora» sale en cero, aunque lleve 30 días vencido", () => {
  const conMora = computeMora({ ...VENCIDA, fegaRate: 0.0304, chargesInterest: true });
  assert.equal(conMora.daysOverdue, 30);
  assert.equal(Math.round(conMora.interest * 100) / 100, Math.round(((156849.85 * 0.159 * 30) / 360) * 100) / 100);
  // Con NONE: la 0022 la deja en comisión no · FEGA no, así que la tasa efectiva
  // es 0 y el interés se apaga por la política.
  const sinMora = computeMora({ ...VENCIDA, fegaRate: 0, chargesInterest: false });
  assert.equal(sinMora.daysOverdue, 30, "los días vencidos se siguen viendo");
  assert.equal(sinMora.interest, 0);
  assert.equal(sinMora.fega, 0);
  assert.equal(sinMora.mora, 0);
});

test("cableado: «Sin mora» apaga interés, comisión, FEGA, TIIE y pronto pago", () => {
  const credit = src("src/lib/erp/credit.ts");
  assert.ok(credit.includes('export const NO_MORA_POLICY = "NONE";'), "un solo lugar dice cuál es la política sin mora");
  assert.ok(credit.includes("const cobraInteres = input.chargesInterest !== false;"), "el motor recibe el interruptor");
  const ops = src("src/lib/erp/ops.ts");
  const live = ops.slice(ops.indexOf("export const getLiveStatement"), ops.indexOf("export async function issueMoraInvoice"));
  assert.ok(live.includes("const cobraInteres = policyChargesInterest(inv.policy_code);"), "cada fila lee la política del documento");
  assert.ok(live.includes("chargesInterest: cobraInteres,"), "y se lo pasa a computeMora / computeStatementLine");
  assert.ok(live.includes("const tasas = cobra && cobraInteres"), "sin mora tampoco hay comisión ni FEGA");
  assert.ok(live.includes("const bono = productDoc && cobraInteres && tiieIssuePick"), "sin financiamiento no hay bonificación de pronto pago");
  const fi = ops.slice(ops.indexOf("export async function issueMoraInvoice"), ops.indexOf("export const invoiceLiveMora"));
  assert.ok(fi.includes("if (!policyChargesInterest(inv[0].policy_code)) {"), "la FI no se emite para un documento sin mora");
  const ec = src("src/routes/statements.tsx");
  assert.ok(ec.includes('r.sinMora ? "sin mora"'), "la columna lo dice, no imprime un cero mudo");
  const car = src("src/routes/credit.tsx");
  assert.ok(car.includes("const cobraInteres = policyChargesInterest(inv.policy_code);"), "la vista previa del cobro enseña la misma cuenta");
});

// ---------------------------------------------------------------------------
// EL CORTE COMPAQ ENTRA CON POLÍTICA ELEGIDA (3-sep-2026, decisión del dueño).
//
// Las facturas importadas nacían con el `default 'NONE'` de la columna, es
// decir «Sin mora»: un valor por omisión que decide dinero. Ahora la política se
// pide en la pantalla y sin ella no se pega nada.
// ---------------------------------------------------------------------------
test("cableado: el importador pide la política y no acepta una que no existe", () => {
  const cut = src("src/lib/erp/cutover.ts");
  const apply = cut.slice(cut.indexOf("export const applyOpenInvoices"), cut.indexOf("async function logImportFailure"));
  assert.ok(
    apply.includes('z.object({ csv: z.string().min(3), policyCode: z.string().min(1) })'),
    "el servidor exige la política, no la supone",
  );
  assert.ok(apply.includes("select code, name from credit_policies where company_id = ${companyId} and code = ${data.policyCode}"), "y valida que exista");
  assert.ok(apply.includes("opening_paid, policy_code, created_by"), "la factura importada guarda su política");
  assert.ok(apply.includes("${data.policyCode}, ${context.userId}"), "la elegida, no la de la columna");
  assert.ok(apply.includes("política de cobro ${pol[0].name}"), "queda en bitácora con qué política entró");
  const page = src("src/routes/importar.tsx");
  assert.ok(page.includes("Política de cobro de estos saldos"), "la pantalla la pide");
  assert.ok(page.includes('<option value="">Elige la política…</option>'), "nace vacía, sin proponer una");
  assert.ok(page.includes("disabled={busy || !csvInv.trim() || !policyCode}"), "sin elegirla no se pega nada");
});
