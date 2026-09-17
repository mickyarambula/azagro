// NACIMIENTO DEL CRÉDITO — grupo A de la auditoría (AUDITORIA.md § 3),
// Decisiones 68 y 69, 17-sep-2026. Tres hallazgos que son el mismo problema en
// tres capas y se arreglan en un solo bloque, en el orden #4 → #2 → #1:
//
//   #4  un pedido a Fecha / Cosecha nacía con credit_days = 0 aunque venciera a
//       200 días: computeDues copiaba los días del formulario. Ahora los deriva
//       de la fecha (una sola fuente) y la 0040 repara los que ya nacieron así,
//       de sus propias fechas, nunca de Ajustes.
//   #2  «Sin mora» era el valor por omisión del pedido directo (pantalla y
//       columna) y el servidor no validaba nada. Ahora la política se elige o el
//       pedido no nace: una sola regla (`saleTermsError`) para los cuatro caminos.
//   #1  el cobro bonificaba pronto pago sin mirar la política y rellenaba el
//       plazo con Ajustes (`credit_days || pol.creditDays`). Ahora consulta la
//       política como el estado de cuenta y con 0 días no bonifica nada.
//
// Copias verbatim (como erp-cartera y erp-politica-cobro): si cambia el motor,
// actualiza aquí y piensa por qué.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pendingMigrations } from "./migration-plan.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "migrations");
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
// Copias verbatim de credit.ts y order-terms.ts
// ---------------------------------------------------------------------------
const YEAR_DAYS = 360;
const NO_MORA_POLICY = "NONE";
function daysBetween(from, to) {
  const a = Date.parse(from.slice(0, 10) + "T00:00:00");
  const b = Date.parse(to.slice(0, 10) + "T00:00:00");
  return Math.round((b - a) / 86400000);
}
function addDays(iso, days) {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
function earlyPayBonus(input) {
  const lived = daysBetween(input.issueDate, input.payDate);
  const rate = input.tiieAtIssue + input.costSpread;
  if (lived >= input.thresholdDays) {
    return { applies: false, lived, days: 0, rate, bonus: 0 };
  }
  const days = Math.max(0, input.financialDays - lived);
  const bonus = Math.round(((Math.max(0, input.cargo) * rate * days) / YEAR_DAYS) * 100) / 100;
  return { applies: days > 0, lived, days, rate, bonus };
}
function computeDues(input) {
  const date = input.date.slice(0, 10);
  if (input.termKind === "contado") {
    return { invoiceDays: 0, creditDays: 0, invoiceDue: date, creditDue: date };
  }
  if (input.termKind === "date") {
    const invoiceDue = (input.invoiceDue || date).slice(0, 10);
    const creditDue = (input.creditDue || input.invoiceDue || date).slice(0, 10);
    return {
      invoiceDays: Math.max(0, daysBetween(date, invoiceDue)),
      creditDays: Math.max(0, daysBetween(date, creditDue)),
      invoiceDue,
      creditDue,
    };
  }
  if (input.termKind === "harvest") {
    if (!input.creditDue) throw new Error("En cosecha hay que indicar la fecha de crédito / mora");
    const invoiceDue = (input.invoiceDue || addDays(date, input.invoiceDays)).slice(0, 10);
    const creditDue = input.creditDue.slice(0, 10);
    return {
      invoiceDays: Math.max(0, daysBetween(date, invoiceDue)),
      creditDays: Math.max(0, daysBetween(date, creditDue)),
      invoiceDue,
      creditDue,
    };
  }
  const invoiceDays = input.invoiceDays;
  const creditDays = input.creditDays || invoiceDays;
  return {
    invoiceDays,
    creditDays,
    invoiceDue: addDays(date, invoiceDays),
    creditDue: addDays(date, creditDays),
  };
}
function saleTermsError(input) {
  const code = (input.policyCode ?? "").trim();
  const credit = input.creditDays > 0;
  if (!code) {
    return credit
      ? "Elige la política de cobro del pedido: en ventas a crédito siempre hay mora, y la política dice a qué tasa."
      : "Elige la política de cobro del pedido: de contado es «Sin mora».";
  }
  if (!input.policies.includes(code)) {
    return `La política de cobro «${code}» no existe en el catálogo. Elige una de Ajustes → Políticas de cobro.`;
  }
  if (credit && code === NO_MORA_POLICY) {
    return "En ventas a crédito siempre hay mora: «Sin mora» es solo para contado. Elige la política de cobro que corresponde al cliente.";
  }
  if (!credit && code !== NO_MORA_POLICY) {
    return "Un pedido de contado no genera mora: su política de cobro es «Sin mora». Si la venta es a crédito, captura el plazo.";
  }
  return null;
}

test("las copias siguen siendo el motor (order-terms.ts)", () => {
  const ot = src("src/lib/erp/order-terms.ts");
  assert.equal((ot.match(/creditDays: Math\.max\(0, daysBetween\(date, creditDue\)\),/g) || []).length, 2, "Fecha y Cosecha derivan los días de la fecha");
  assert.equal((ot.match(/invoiceDays: Math\.max\(0, daysBetween\(date, invoiceDue\)\),/g) || []).length, 2);
  assert.ok(!ot.includes("creditDays: input.creditDays,"), "ya no se copian los días del formulario en Fecha/Cosecha");
  for (const msg of [
    "en ventas a crédito siempre hay mora, y la política dice a qué tasa.",
    "de contado es «Sin mora».",
    "no existe en el catálogo. Elige una de Ajustes → Políticas de cobro.",
    "«Sin mora» es solo para contado. Elige la política de cobro que corresponde al cliente.",
    "Un pedido de contado no genera mora: su política de cobro es «Sin mora».",
  ]) assert.ok(ot.includes(msg), `mensaje: ${msg}`);
  assert.ok(ot.includes("if (credit && code === NO_MORA_POLICY)") && ot.includes("if (!credit && code !== NO_MORA_POLICY)"), "contado ⇔ Sin mora, en las dos direcciones");
});

// ---------------------------------------------------------------------------
// #4 — los días salen de la fecha, una sola fuente
// ---------------------------------------------------------------------------
test("#4 computeDues: cosecha a 200 días devuelve 200 aunque el formulario mande 0 (o 150)", () => {
  for (const creditDays of [0, 150]) {
    const d = computeDues({ date: "2026-09-16", termKind: "harvest", invoiceDays: 90, creditDays, invoiceDue: "2026-12-15", creditDue: "2027-04-04" });
    assert.equal(d.creditDays, 200, "credit_due − fecha, no lo que traiga el formulario");
    assert.equal(d.invoiceDays, 90, "invoice_due − fecha");
    assert.equal(d.creditDue, "2027-04-04");
  }
  const sinFactura = computeDues({ date: "2026-09-16", termKind: "harvest", invoiceDays: 120, creditDays: 0, creditDue: "2027-04-04" });
  assert.equal(sinFactura.invoiceDue, "2027-01-14", "sin fecha de factura, arranca de los días capturados…");
  assert.equal(sinFactura.invoiceDays, 120, "…y los días son los mismos por las dos vías");
});

test("#4 computeDues: Fecha deriva igual; con la fecha en el mismo día es contado (0), y nunca negativo", () => {
  const d = computeDues({ date: "2026-09-16", termKind: "date", invoiceDays: 0, creditDays: 0, invoiceDue: "2026-11-15", creditDue: "2027-03-15" });
  assert.deepEqual(d, { invoiceDays: 60, creditDays: 180, invoiceDue: "2026-11-15", creditDue: "2027-03-15" });
  const hoy = computeDues({ date: "2026-09-16", termKind: "date", invoiceDays: 150, creditDays: 150, invoiceDue: "2026-09-16", creditDue: "2026-09-16" });
  assert.equal(hoy.creditDays, 0, "credit_days = 0 es contado y nada más — no se rellena con 150");
  const atras = computeDues({ date: "2026-09-16", termKind: "date", invoiceDays: 0, creditDays: 0, invoiceDue: "2026-09-01", creditDue: "2026-09-01" });
  assert.equal(atras.creditDays, 0, "una fecha atrás no da días negativos (validateDueDates la rechaza aparte)");
});

test("#4 computeDues: contado y credit_days no cambian ni un byte", () => {
  assert.deepEqual(computeDues({ date: "2026-09-16", termKind: "contado", invoiceDays: 120, creditDays: 150 }), { invoiceDays: 0, creditDays: 0, invoiceDue: "2026-09-16", creditDue: "2026-09-16" });
  assert.deepEqual(computeDues({ date: "2026-09-16", termKind: "credit_days", invoiceDays: 120, creditDays: 150 }), { invoiceDays: 120, creditDays: 150, invoiceDue: "2027-01-14", creditDue: "2027-02-13" });
});

// ---------------------------------------------------------------------------
// #2 — la regla única: se elige, y cuadra con el plazo
// ---------------------------------------------------------------------------
const CATALOGO = ["ESTANDAR", "GRUPO_SL", "NONE"];

test("#2 saleTermsError: a crédito sin política, o con «Sin mora», no nace", () => {
  assert.match(saleTermsError({ creditDays: 120, policyCode: "", policies: CATALOGO }), /Elige la política de cobro/);
  assert.match(saleTermsError({ creditDays: 120, policyCode: null, policies: CATALOGO }), /siempre hay mora/);
  assert.match(saleTermsError({ creditDays: 120, policyCode: "NONE", policies: CATALOGO }), /«Sin mora» es solo para contado/);
  assert.match(saleTermsError({ creditDays: 120, policyCode: "INVENTADA", policies: CATALOGO }), /no existe en el catálogo/);
  assert.equal(saleTermsError({ creditDays: 120, policyCode: "ESTANDAR", policies: CATALOGO }), null);
  assert.equal(saleTermsError({ creditDays: 1, policyCode: "GRUPO_SL", policies: CATALOGO }), null, "un día ya es crédito");
});

test("#2 saleTermsError: de contado la política es «Sin mora» y solo esa (Decisión 69 a)", () => {
  assert.equal(saleTermsError({ creditDays: 0, policyCode: "NONE", policies: CATALOGO }), null);
  assert.match(saleTermsError({ creditDays: 0, policyCode: "ESTANDAR", policies: CATALOGO }), /contado no genera mora/);
  assert.match(saleTermsError({ creditDays: 0, policyCode: "", policies: CATALOGO }), /de contado es «Sin mora»/);
  assert.match(saleTermsError({ creditDays: 0, policyCode: "NONE", policies: ["ESTANDAR"] }), /no existe en el catálogo/, "aunque sea NONE, tiene que estar en el catálogo");
});

test("#2 cableado: los cuatro nacimientos pasan por guardSaleTerms, y nadie escribe 'NONE' por omisión", () => {
  const guard = src("src/lib/erp/sale-terms.ts");
  assert.ok(guard.includes("assertSaleTerms({ ...input, policies: await creditPolicyCodes(sql, companyId) });"), "el guard lee el catálogo y llama la regla pura");
  const orders = src("src/lib/erp/orders.ts");
  assert.ok(fnBody(orders, "saveOrder").includes("await guardSaleTerms(sql, companyId, { creditDays: dues.creditDays, policyCode: data.policyCode });"), "saveOrder (alta y edición, borrador incluido)");
  assert.ok(orders.includes("coalesce(policy_code,'') as policy_code, oc_cliente, price_mode,"), "getOrder no finge NONE cuando está vacía");
  const az = src("src/lib/azagro.ts");
  const cs = fnBody(az, "createSale");
  assert.ok(cs.includes("await guardSaleTerms(sql, m.company_id, { creditDays: 0, policyCode: NO_MORA_POLICY });"), "createSale: contado, misma regla");
  assert.ok(cs.includes("'contado', ${NO_MORA_POLICY})"), "createSale escribe plazo y política, no los hereda de la columna");
  const ops = src("src/lib/erp/ops.ts");
  const dq = fnBody(ops, "decideQuote");
  assert.ok(dq.includes(`const policyCode = days > 0 ? (grp[0]?.group_name === "Grupo SL" ? "GRUPO_SL" : "ESTANDAR") : "NONE";`), "la regla por grupo sigue tal cual (erp-dos-precios la congela; el #21 es otro tema)");
  assert.ok(dq.includes("await guardSaleTerms(sql, cid, { creditDays: dues.creditDays, policyCode });"), "…pero el resultado pasa por la misma regla");
  const cpo = src("src/lib/erp/cpo.ts");
  assert.ok(cpo.includes("z.object({ cpoId: z.number(), locationId: z.number(), policyCode: z.string().min(1) })"), "OC del cliente: la política se pide al convertir (Decisión 69 b)");
  assert.ok(cpo.includes("await guardSaleTerms(sql, companyId, { creditDays: plazo, policyCode: data.policyCode });"));
  assert.ok(cpo.includes("'own', ${data.policyCode}, ${cpo[0].customer_po_number}") && !cpo.includes("'own', 'NONE'"), "y ya no se escribe 'NONE' en el insert");
  assert.ok(cpo.includes("return { pos, lines, customers, products, policies };"), "la pantalla recibe el catálogo");
  assert.ok(src("src/routes/cpo.tsx").includes("policyCode: policyByRow[row.id] ?? \"\"") && src("src/routes/cpo.tsx").includes("disabled={!policyByRow[row.id]}"), "botón apagado hasta elegir");
});

test("#2 cableado: changeOrderTerm sigue contado ⇔ Sin mora, y el diálogo de cobro no le inventa mora a una NC/FI/ATC", () => {
  const cot = fnBody(src("src/lib/erp/orders.ts"), "changeOrderTerm");
  assert.ok(cot.includes('const policyAfter = dues.creditDays > 0 ? (so[0].policy_code === NO_MORA_POLICY ? "" : so[0].policy_code) : NO_MORA_POLICY;'), "a contado → Sin mora; a crédito una Sin mora se vacía (nunca se elige por la persona)");
  assert.ok(cot.includes("policy_code = ${policyAfter},"), "…y se guarda con rastro en bitácora");
  const car = src("src/routes/credit.tsx");
  assert.ok(car.includes('if (inv.inv_class !== "product") {') && car.includes("Este documento no es una factura de producto: no genera interés de mora."), "NC/FI/ATC nacen sin política desde la 0040: la vista previa no calcula mora sobre ellas");
});

test("#2 cableado: la FV hereda la política tal cual y se detiene si está vacía; el ensure ya no trae default", () => {
  const az = src("src/lib/azagro.ts");
  assert.ok(!az.includes('policy_code ?? "NONE"'), "la FV ya no rellena con «Sin mora»");
  assert.ok(az.includes("const policyCode = (so[0].policy_code ?? \"\").trim();") && az.includes("no tiene política de cobro capturada: captúrala en el pedido antes de facturar."), "sin política capturada no se factura");
  assert.ok(az.includes("${so[0].invoice_days ?? 0}, ${so[0].credit_days ?? 0}, ${policyCode},"), "y va a la FV");
  assert.ok(!az.includes("default 'NONE'"), "ningún ensure vuelve a poner el default");
  assert.equal((az.match(/add column if not exists policy_code text`/g) || []).length, 2, "las dos columnas, sin default");
});

test("#2 cableado: el formulario arranca vacío a crédito, pone «Sin mora» de contado y apaga la opción que no aplica", () => {
  const nuevo = src("src/routes/sales.nuevo.tsx");
  assert.ok(nuevo.includes('policyCode: "",'), "pedido directo nuevo: sin política puesta");
  assert.ok(!nuevo.includes('p.code === "NONE"'), "ya no busca NONE para preseleccionarla");
  assert.ok(src("src/routes/sales.$orderId.tsx").includes('policyCode: o.policy_code || "",'), "la ficha tampoco finge NONE");
  const form = src("src/components/order-form.tsx");
  assert.ok(form.includes('<option value="">Elige la política de cobro</option>'), "opción vacía en el select");
  assert.ok(form.includes("const off = credit ? p.code === NO_MORA_POLICY : p.code !== NO_MORA_POLICY;"), "a crédito «Sin mora» apagada; de contado solo ella");
  const defaults = fnBody(form, "applyPartnerDefaults");
  assert.ok(defaults.includes("policyCode: NO_MORA_POLICY,"), "cliente de contado → Sin mora");
  assert.ok(defaults.includes('form.policyCode === NO_MORA_POLICY ? "" : form.policyCode'), "cliente a crédito: si venía Sin mora, se vacía para que elija");
  assert.equal((form.match(/policyCode: form\.policyCode === NO_MORA_POLICY \? "" : form\.policyCode/g) || []).length, 2, "cambiar el plazo a crédito también vacía «Sin mora» (credit_days; Fecha y Cosecha comparten rama)");
});

// ---------------------------------------------------------------------------
// #1 — el cobro consulta la política y no rellena el plazo
// ---------------------------------------------------------------------------
test("#1 cableado: applyInvoicePayment lee la política, la respeta y no rellena credit_days con Ajustes", () => {
  const ops = src("src/lib/erp/ops.ts");
  const pay = fnBody(ops, "applyInvoicePayment");
  assert.ok(pay.includes("coalesce(policy_code,'') as policy_code, circuit_code, state from invoices"), "el SELECT trae la política");
  assert.ok(pay.includes("policyChargesInterest(inv[0].policy_code) && inv[0].credit_days > 0"), "sin mora o sin plazo no hay bonificación (y no se pide TIIE)");
  assert.ok(pay.includes("financialDays: inv[0].credit_days,"), "los días de ESTE documento");
  assert.ok(!ops.includes("|| pol.creditDays"), "ningún lector rellena el plazo con Ajustes — ni el cobro ni el estado de cuenta");
  const live = ops.slice(ops.indexOf("export const getLiveStatement"), ops.indexOf("export async function issueMoraInvoice"));
  assert.ok(live.includes("financialDays: inv.credit_days,"), "el estado de cuenta usa el mismo número que el cobro");
});

test("#1 números: con credit_days = 0 la bonificación es 0 aunque pague al día 5; con 200 días de cosecha bonifica SUS días", () => {
  const contado = earlyPayBonus({ cargo: 100000, issueDate: "2026-09-01", payDate: "2026-09-06", thresholdDays: 120, financialDays: 0, tiieAtIssue: 0.069, costSpread: 0.04 });
  assert.equal(contado.applies, false);
  assert.equal(contado.bonus, 0, "antes: 0 || 150 → $4,390.28 regalados (AUDITORIA #1)");
  const cosecha = earlyPayBonus({ cargo: 100000, issueDate: "2026-09-01", payDate: "2026-09-06", thresholdDays: 120, financialDays: 200, tiieAtIssue: 0.069, costSpread: 0.04 });
  assert.equal(cosecha.days, 195, "200 de SU plazo − 5 vividos, no 150 − 5 de Ajustes");
  assert.equal(cosecha.bonus, Math.round(((100000 * 0.109 * 195) / 360) * 100) / 100);
});

// ---------------------------------------------------------------------------
// Migración 0040 — funcional en PGlite
// ---------------------------------------------------------------------------
async function dbHasta0039() {
  const db = new PGlite();
  for (const { name, path } of pendingMigrations(readdirSync(dir), [])) {
    if (name.startsWith("0040")) continue;
    await db.exec(readFileSync(join(dir, path), "utf8"));
  }
  await db.exec(`insert into companies (id, name, join_code, created_by) values (1, 'Azagro', 'AZ1', 'u1')`);
  await db.exec(`insert into partners (id, company_id, code, name, is_customer, payment_days) values (10, 1, 'CL1', 'Cliente', true, 90)`);
  await db.exec(`insert into locations (id, company_id, code, name) values (5, 1, 'BOD', 'Bodega')`);
  return db;
}
const m40 = () => readFileSync(join(dir, readdirSync(dir).find((f) => f.startsWith("0040"))), "utf8");

test("0040: policy_code deja de tener default y de ser not null en pedidos y facturas; lo que ya está en NONE no se toca", async () => {
  const db = await dbHasta0039();
  await db.exec(`insert into sales_orders (id, company_id, name, partner_id, location_id, date, credit_days) values (1, 1, 'PV-0001', 10, 5, '2026-09-01', 120)`);
  const antes = (await db.query(`select policy_code from sales_orders where id = 1`)).rows[0];
  assert.equal(antes.policy_code, "NONE", "antes de la 0040 nacía en NONE sin que nadie lo eligiera");
  await db.exec(m40());
  await db.exec(`insert into sales_orders (id, company_id, name, partner_id, location_id, date, credit_days) values (2, 1, 'PV-0002', 10, 5, '2026-09-01', 120)`);
  await db.exec(`insert into invoices (id, company_id, kind, name, partner_id, date, due_date, amount, residual, origin) values (1, 1, 'supplier', 'FP-0001', 10, '2026-09-01', '2026-10-01', 100, 100, 'OC-0001')`);
  const rows = (await db.query(`select id, policy_code from sales_orders order by id`)).rows;
  assert.deepEqual(rows, [{ id: 1, policy_code: "NONE" }, { id: 2, policy_code: null }], "el viejo se queda (Decisión 69 c); el nuevo nace vacío, no en NONE");
  assert.equal((await db.query(`select policy_code from invoices where id = 1`)).rows[0].policy_code, null, "una FP no tiene política y ahora lo dice");
  const cols = (await db.query(`select table_name, is_nullable, column_default from information_schema.columns where column_name = 'policy_code' and table_name in ('sales_orders','invoices') order by table_name`)).rows;
  assert.deepEqual(cols, [
    { table_name: "invoices", is_nullable: "YES", column_default: null },
    { table_name: "sales_orders", is_nullable: "YES", column_default: null },
  ]);
  await db.close();
});

test("0040: los pedidos a Fecha/Cosecha con credit_days = 0 se reparan de SUS fechas; los demás no se mueven; es idempotente", async () => {
  const db = await dbHasta0039();
  await db.exec(`
    insert into sales_orders (id, company_id, name, partner_id, location_id, date, term_kind, credit_days, credit_due) values
      (1, 1, 'PV-0001', 10, 5, '2026-09-16', 'harvest', 0, '2027-04-04'),
      (2, 1, 'PV-0002', 10, 5, '2026-09-16', 'date', 0, '2027-03-15'),
      (3, 1, 'PV-0003', 10, 5, '2026-09-16', 'harvest', 150, '2027-04-04'),
      (4, 1, 'PV-0004', 10, 5, '2026-09-16', 'credit_days', 0, '2026-09-16'),
      (5, 1, 'PV-0005', 10, 5, '2026-09-16', 'contado', 0, '2026-09-16'),
      (6, 1, 'PV-0006', 10, 5, '2026-09-16', 'harvest', 0, null);
    update sales_orders set state = 'cancelled' where id = 2;
    insert into sales_orders (id, company_id, name, partner_id, location_id, date, term_kind, credit_days, credit_due) values
      (7, 1, 'PV-0007', 10, 5, '2026-09-16', 'date', 0, '2027-03-15');
    insert into invoices (id, company_id, kind, name, partner_id, date, due_date, credit_due, amount, residual, origin, inv_class, order_id, credit_days, state) values
      (1, 1, 'customer', 'FV-0001', 10, '2026-09-20', '2026-12-15', '2027-04-04', 1000, 1000, 'PV-0001', 'product', 1, 0, 'open'),
      (2, 1, 'customer', 'FI-0002', 10, '2026-09-20', '2026-12-15', '2027-04-04', 33, 33, 'Mora FV-0001', 'interest', 1, 0, 'open'),
      (3, 1, 'customer', 'FV-0003', 10, '2026-09-20', '2026-12-15', '2027-04-04', 1000, 1000, 'PV-0003', 'product', 3, 150, 'open'),
      (4, 1, 'customer', 'FV-0004', 10, '2026-09-20', '2026-09-20', '2026-09-20', 1000, 1000, 'PV-0005', 'product', 5, 0, 'open'),
      (5, 1, 'customer', 'FV-0005', 10, '2026-09-20', '2026-12-15', '2027-04-04', 1000, 0, 'PV-0001', 'product', 1, 0, 'paid');
  `);
  await db.exec(m40());
  const so = Object.fromEntries((await db.query(`select name, credit_days from sales_orders order by id`)).rows.map((r) => [r.name, r.credit_days]));
  assert.deepEqual(so, {
    "PV-0001": 200, // cosecha: 2027-04-04 − 2026-09-16
    "PV-0002": 0, // cancelado: ya no es de nadie, no se toca
    "PV-0003": 150, // ya tenía plazo: no se toca (aunque no cuadre con la fecha)
    "PV-0004": 0, // credit_days con 0 es contado: no es de este arreglo
    "PV-0005": 0, // contado
    "PV-0006": 0, // sin fecha no hay de dónde derivar
    "PV-0007": 180, // fecha: 2027-03-15 − 2026-09-16
  });
  const inv = Object.fromEntries((await db.query(`select name, credit_days from invoices order by id`)).rows.map((r) => [r.name, r.credit_days]));
  assert.deepEqual(inv, {
    "FV-0001": 200, // la FV de la cosecha lleva los días del PEDIDO (Decisión 69 d), no de su propia fecha
    "FI-0002": 0, // una FI no es documento de producto
    "FV-0003": 150, // ya tenía plazo
    "FV-0004": 0, // de contado
    "FV-0005": 0, // pagada: lo cobrado ya quedó como se cobró
  });
  await db.exec(m40());
  const otraVez = Object.fromEntries((await db.query(`select name, credit_days from sales_orders order by id`)).rows.map((r) => [r.name, r.credit_days]));
  assert.deepEqual(otraVez, so, "segunda pasada: nada cambia");
  await db.close();
});

test("0040 está documentada en migrations/README.md", () => {
  assert.ok(src("migrations/README.md").includes("0040 = **nacimiento del crédito**"));
});

// ---------------------------------------------------------------------------
// MOTOR CONGELADO (red de seguridad): computeDues de ANTES del 17-sep-2026,
// copiado tal cual de git (commit d817a81), contra el de hoy sobre casos
// generados. Contado y credit_days: idénticos byte a byte. Fecha y Cosecha:
// las FECHAS idénticas; los DÍAS son lo único que cambia, y cambian a
// `fecha − fecha` (la razón de este bloque, hallazgo #4).
// ---------------------------------------------------------------------------
function computeDuesViejo(input) {
  const date = input.date.slice(0, 10);
  if (input.termKind === "contado") {
    return { invoiceDays: 0, creditDays: 0, invoiceDue: date, creditDue: date };
  }
  if (input.termKind === "date") {
    const invoiceDue = (input.invoiceDue || date).slice(0, 10);
    const creditDue = (input.creditDue || input.invoiceDue || date).slice(0, 10);
    return { invoiceDays: input.invoiceDays, creditDays: input.creditDays, invoiceDue, creditDue };
  }
  if (input.termKind === "harvest") {
    if (!input.creditDue) throw new Error("En cosecha hay que indicar la fecha de crédito / mora");
    const invoiceDue = (input.invoiceDue || addDays(date, input.invoiceDays)).slice(0, 10);
    return {
      invoiceDays: input.invoiceDays,
      creditDays: input.creditDays,
      invoiceDue,
      creditDue: input.creditDue.slice(0, 10),
    };
  }
  const invoiceDays = input.invoiceDays;
  const creditDays = input.creditDays || invoiceDays;
  return {
    invoiceDays,
    creditDays,
    invoiceDue: addDays(date, invoiceDays),
    creditDue: addDays(date, creditDays),
  };
}

test("motor congelado: computeDues viejo vs nuevo sobre 4,000 casos generados", () => {
  let seed = 20260917;
  const rnd = (n) => {
    seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) ^ ((seed ^ (seed >>> 15)) >>> 12)) >>> 0;
    return seed % n;
  };
  const kinds = ["contado", "credit_days", "date", "harvest"];
  let identicos = 0;
  let cambiados = 0;
  for (let i = 0; i < 4000; i++) {
    const date = addDays("2026-01-01", rnd(700));
    const termKind = kinds[rnd(4)];
    const invoiceDays = [0, 30, 60, 90, 120, 150][rnd(6)];
    const creditDays = [0, 0, 90, 120, 150, 180][rnd(6)];
    const invoiceDue = rnd(3) === 0 ? "" : addDays(date, rnd(400));
    const creditDue = rnd(4) === 0 ? "" : addDays(date, rnd(400));
    const input = { date, termKind, invoiceDays, creditDays, invoiceDue, creditDue };
    let viejo, nuevo;
    try { viejo = computeDuesViejo(input); } catch (e) { viejo = { error: e.message }; }
    try { nuevo = computeDues(input); } catch (e) { nuevo = { error: e.message }; }
    if (termKind === "contado" || termKind === "credit_days") {
      assert.deepEqual(nuevo, viejo, `${termKind} tiene que ser idéntico: ${JSON.stringify(input)}`);
      identicos++;
      continue;
    }
    assert.equal(nuevo.error, viejo.error, "cosecha sin fecha: el mismo aviso");
    if (viejo.error) { identicos++; continue; }
    assert.equal(nuevo.invoiceDue, viejo.invoiceDue, "las fechas no se mueven");
    assert.equal(nuevo.creditDue, viejo.creditDue, "las fechas no se mueven");
    assert.equal(nuevo.creditDays, Math.max(0, daysBetween(date, viejo.creditDue)), "los días son fecha − fecha");
    assert.equal(nuevo.invoiceDays, Math.max(0, daysBetween(date, viejo.invoiceDue)));
    if (nuevo.creditDays === viejo.creditDays && nuevo.invoiceDays === viejo.invoiceDays) identicos++;
    else cambiados++;
  }
  assert.ok(identicos > 2000 && cambiados > 500, `identicos=${identicos} cambiados=${cambiados}`);
  console.log(`computeDues congelado: ${identicos} idénticos, ${cambiados} cambiados solo en días (Fecha/Cosecha, hallazgo #4)`);
});
