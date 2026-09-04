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
  assert.ok(ec.includes('r.sinPolitica ? pend("sin política")'), "la columna dice «sin política» en vez de un número inventado (en pantalla; el papel dice «Pendiente de cálculo»)");
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
  assert.ok(ec.includes('r.sinMora ? nada("sin mora")'), "la columna lo dice en pantalla, no imprime un cero mudo (el papel pone guion: no hay nada que cobrar)");
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

// ---------------------------------------------------------------------------
// QUIÉN ESTÁ EN CADA POLÍTICA (panel de Ajustes, 3-sep-2026).
//
// Saber que hay 14 clientes en Estándar no sirve para negociar: hay que saber
// QUIÉNES son, para decidir uno por uno si les toca el 3.04%. La política vive
// en el documento, no en el cliente, así que se cuenta sobre las facturas de
// mercancía con saldo abierto — la misma población del estado de cuenta.
//
// Copia de src/lib/erp/policy-usage.ts.
// ---------------------------------------------------------------------------
const round2 = (n) => Math.round(n * 100) / 100;
const CURRENCY_ORDER = ["MXN", "USD"];
const SIN_POLITICA = "";
function currencyRank(cur) {
  const i = CURRENCY_ORDER.indexOf(cur);
  return i < 0 ? CURRENCY_ORDER.length : i;
}
function sortCurrencies(list) {
  return list.sort((a, b) => currencyRank(a.currency) - currencyRank(b.currency) || a.currency.localeCompare(b.currency));
}
function addMoney(list, currency, invoices, saldo) {
  const prev = list.find((m) => m.currency === currency);
  if (prev) {
    prev.invoices += invoices;
    prev.saldo += saldo;
  } else {
    list.push({ currency, invoices, saldo });
  }
}
function saldoTotalOrden(c) {
  return c.byCurrency.reduce((s, m) => s + m.saldo, 0);
}
function groupPolicyUsage(rows, policies) {
  const byCode = new Map(policies.map((p) => [p.code, p]));
  const buckets = new Map();
  const clients = new Map();
  const bucket = (code) => {
    let b = buckets.get(code);
    if (!b) {
      const pol = byCode.get(code);
      b = {
        code,
        name: code === SIN_POLITICA ? "Sin política capturada" : (pol?.name ?? code),
        captured: code !== SIN_POLITICA,
        commission: pol?.commission ?? null,
        fega: pol?.fega ?? null,
        chargesInterest: code === SIN_POLITICA ? true : policyChargesInterest(code),
        clients: 0,
        invoices: 0,
        byCurrency: [],
        clientsList: [],
      };
      buckets.set(code, b);
      clients.set(code, new Map());
    }
    return b;
  };
  for (const p of policies) bucket(p.code);
  bucket(SIN_POLITICA);
  for (const r of rows) {
    const pol = byCode.get(r.policyCode);
    const key = pol && chargesCaptured(pol) ? r.policyCode : SIN_POLITICA;
    const b = bucket(key);
    b.invoices += r.invoices;
    addMoney(b.byCurrency, r.currency || "MXN", r.invoices, r.saldo);
    const map = clients.get(key);
    let c = map.get(r.partnerId);
    if (!c) {
      c = { id: r.partnerId, code: r.partnerCode, name: r.partnerName, group: r.groupName, invoices: 0, byCurrency: [], policyCodes: [] };
      map.set(r.partnerId, c);
    }
    c.invoices += r.invoices;
    addMoney(c.byCurrency, r.currency || "MXN", r.invoices, r.saldo);
    const etiqueta = r.policyCode || "(sin política)";
    if (!c.policyCodes.includes(etiqueta)) c.policyCodes.push(etiqueta);
  }
  const out = [...buckets.values()];
  for (const b of out) {
    const list = [...clients.get(b.code).values()];
    for (const c of list) {
      sortCurrencies(c.byCurrency);
      for (const m of c.byCurrency) m.saldo = round2(m.saldo);
      c.policyCodes.sort();
    }
    list.sort((a, b2) => saldoTotalOrden(b2) - saldoTotalOrden(a) || a.name.localeCompare(b2.name, "es"));
    b.clientsList = list;
    b.clients = list.length;
    sortCurrencies(b.byCurrency);
    for (const m of b.byCurrency) m.saldo = round2(m.saldo);
  }
  const orden = new Map(policies.map((p, i) => [p.code, i]));
  return out.sort(
    (a, b) => (a.code === SIN_POLITICA ? 1 : 0) - (b.code === SIN_POLITICA ? 1 : 0) ||
      (orden.get(a.code) ?? 0) - (orden.get(b.code) ?? 0),
  );
}

// Las tres políticas tal como las deja la migración 0022.
const CAPTURADAS = [
  { code: "ESTANDAR", name: "Estándar", commission: false, fega: false },
  { code: "GRUPO_SL", name: "Grupo SL", commission: true, fega: true },
  { code: "NONE", name: "Sin mora", commission: false, fega: false },
];
const fila = (o) => ({ groupName: "", currency: "MXN", invoices: 1, ...o });
const USO = [
  fila({ policyCode: "GRUPO_SL", partnerId: 1, partnerCode: "CL0001", partnerName: "SL AGRICOLA", groupName: "Grupo SL", invoices: 3, saldo: 470549.55 }),
  fila({ policyCode: "GRUPO_SL", partnerId: 2, partnerCode: "CL0002", partnerName: "AGRICOLA PREMIER", groupName: "Grupo SL", invoices: 1, saldo: 130000 }),
  fila({ policyCode: "ESTANDAR", partnerId: 3, partnerCode: "CL0010", partnerName: "PRODUCTOR DEL VALLE", invoices: 2, saldo: 88000 }),
  // El mismo cliente, en dos monedas y en dos políticas.
  fila({ policyCode: "ESTANDAR", partnerId: 1, partnerCode: "CL0001", partnerName: "SL AGRICOLA", groupName: "Grupo SL", currency: "USD", invoices: 1, saldo: 12000 }),
  fila({ policyCode: "NONE", partnerId: 4, partnerCode: "CL0020", partnerName: "CONTADO MOSTRADOR", invoices: 1, saldo: 5000 }),
];

test("cada política cuenta sus clientes, sus facturas y su saldo por moneda", () => {
  const uso = groupPolicyUsage(USO, CAPTURADAS);
  const de = (code) => uso.find((u) => u.code === code);
  assert.deepEqual(uso.map((u) => u.code), ["ESTANDAR", "GRUPO_SL", "NONE", ""], "el renglón sin capturar va al final");
  assert.equal(de("GRUPO_SL").clients, 2);
  assert.equal(de("GRUPO_SL").invoices, 4);
  assert.deepEqual(de("GRUPO_SL").byCurrency, [{ currency: "MXN", invoices: 4, saldo: 600549.55 }]);
  // Estándar: dos clientes, y su saldo NO mezcla monedas.
  assert.equal(de("ESTANDAR").clients, 2);
  assert.deepEqual(de("ESTANDAR").byCurrency, [
    { currency: "MXN", invoices: 2, saldo: 88000 },
    { currency: "USD", invoices: 1, saldo: 12000 },
  ]);
  // «Sin mora» se ve como lo que es.
  assert.equal(de("NONE").chargesInterest, false);
  assert.equal(de("GRUPO_SL").chargesInterest, true);
});

test("un cliente con documentos de dos políticas aparece en las dos", () => {
  const uso = groupPolicyUsage(USO, CAPTURADAS);
  const sl = (code) => uso.find((u) => u.code === code).clientsList.find((c) => c.code === "CL0001");
  assert.ok(sl("GRUPO_SL"), "sale en Grupo SL");
  assert.ok(sl("ESTANDAR"), "y también en Estándar");
  assert.deepEqual(sl("ESTANDAR").byCurrency, [{ currency: "USD", invoices: 1, saldo: 12000 }]);
  // El que más debe, primero: es con quien se negocia.
  assert.deepEqual(
    uso.find((u) => u.code === "GRUPO_SL").clientsList.map((c) => c.code),
    ["CL0001", "CL0002"],
  );
});

test("una política sin capturar no cuenta para ella: sus documentos se detienen y salen aparte", () => {
  const aMedias = [
    { code: "ESTANDAR", name: "Estándar", commission: null, fega: null },
    { code: "GRUPO_SL", name: "Grupo SL", commission: true, fega: true },
    { code: "NONE", name: "Sin mora", commission: false, fega: false },
  ];
  const uso = groupPolicyUsage(USO, aMedias);
  const est = uso.find((u) => u.code === "ESTANDAR");
  const sin = uso.find((u) => u.code === "");
  assert.equal(est.clients, 0, "no se le cuentan clientes a una política que no contesta las dos preguntas");
  assert.equal(est.invoices, 0);
  assert.equal(sin.clients, 2, "esos clientes se ven donde importa: los que se detienen al cobrar");
  assert.equal(sin.invoices, 3);
  assert.deepEqual(sin.byCurrency, [
    { currency: "MXN", invoices: 2, saldo: 88000 },
    { currency: "USD", invoices: 1, saldo: 12000 },
  ]);
  // Y el detalle dice qué código traen, para saber a quién capturarle qué.
  assert.deepEqual(sin.clientsList.find((c) => c.code === "CL0001").policyCodes, ["ESTANDAR"]);
  // Los renglones no se traslapan: nada se cuenta dos veces.
  const facturas = uso.reduce((s, u) => s + u.invoices, 0);
  assert.equal(facturas, USO.reduce((s, r) => s + r.invoices, 0));
});

test("con todo capturado el renglón que importa queda vacío, y se muestra igual", () => {
  const uso = groupPolicyUsage(USO, CAPTURADAS);
  const sin = uso.find((u) => u.code === "");
  assert.equal(sin.clients, 0);
  assert.equal(sin.invoices, 0);
  assert.deepEqual(sin.byCurrency, []);
  assert.equal(sin.name, "Sin política capturada");
  // Y una política sin nadie también sale, con su cero.
  const vacia = groupPolicyUsage([], CAPTURADAS);
  assert.deepEqual(vacia.map((u) => u.code), ["ESTANDAR", "GRUPO_SL", "NONE", ""]);
  assert.deepEqual(vacia.map((u) => u.clients), [0, 0, 0, 0]);
});

test("cableado: el panel es solo lectura, solo administrador, y sobre saldo abierto de mercancía", () => {
  const ops = src("src/lib/erp/ops.ts");
  const fn = ops.slice(ops.indexOf("export const creditPolicyUsage"), ops.indexOf("export const saveCreditPolicy"));
  assert.ok(fn.includes('createServerFn({ method: "GET" })'), "solo lectura");
  assert.ok(fn.includes("await assertAdmin(sql, context.userId);"), "solo administrador");
  assert.ok(!fn.includes("update ") && !fn.includes("insert "), "no escribe nada");
  assert.ok(fn.includes("and i.kind = 'customer'"), "solo cartera de clientes");
  assert.ok(fn.includes("and coalesce(i.inv_class, 'product') = 'product'"), "mercancía: la mora y el ajuste de TC no se negocian");
  assert.ok(fn.includes("and i.residual > 0.009"), "solo lo que sigue debiendo");
  const st = src("src/routes/settings.tsx");
  assert.ok(st.includes("Quién está en cada política"), "el panel vive junto a las tres políticas de cobro");
  assert.ok(st.includes('{role === "admin" && ('), "no se pinta para otro rol");
  assert.ok(st.includes("setOpenPolicy(abierto ? null : key)"), "cada renglón se abre para ver quiénes son");
  assert.ok(st.includes("moneyIn(m.saldo, m.currency)"), "cada saldo en su moneda, nunca sumadas");
});
