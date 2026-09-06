// CATÁLOGO DE CIRCUITOS DE FINANCIAMIENTO — PASO 0 y PASO 1 (5-sep-2026).
//
// Ver DISENO_FINANCIAMIENTO.md, ESTADO.md, DECISIONES.md. Cada pedido va a
// declarar por dónde corre su financiamiento (quién pone el capital, quién
// factura al cliente, sobre qué base corre el financiamiento, qué comisión
// cobra), en vez de que esos cuatro datos sean una sola fila global de
// Ajustes.
//
//   Paso 0: el catálogo (credit_circuits) y la tabla de tasas de dos columnas
//           (funding_rates), en un panel de solo lectura en Ajustes.
//   Paso 1: el circuito como ETIQUETA por documento (circuit_code): se
//           guarda, se hereda por la cadena SOL → COT → PV → FV → FI/NC/ATC
//           y se muestra. El motor (precio, mora, escalera, reportes) sigue
//           leyendo Ajustes exactamente igual — eso es el paso 3 — y esta
//           prueba lo vigila.
//
// La prueba de las migraciones (siembra del catálogo en 0024, etiquetado de
// lo existente en 0025) vive en scripts/migrations-apply.test.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");
const sinComentarios = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:'"`])\/\/.*$/gm, "$1");
const sinComentariosSql = (code) => code.replace(/--[^\n]*/g, "");

// ---------------------------------------------------------------------------
// Copia literal de los ayudantes puros de src/lib/erp/circuits.ts (paso 1).
// ---------------------------------------------------------------------------
function circuitForTerm(days) {
  return days > 0 ? "ASR" : "CONTADO";
}
function isCircuitCode(code) {
  return code === "CONTADO" || code === "ASR" || code === "SANTA_ROSA" || code === "PROPIA";
}
function inheritCircuit(upstream, days) {
  if (days <= 0) return "CONTADO";
  if (isCircuitCode(upstream) && upstream !== "CONTADO") return upstream;
  return circuitForTerm(days);
}

test("circuits.ts: dos server functions, ambas GET (solo lectura), scoped por empresa", () => {
  const c = src("src/lib/erp/circuits.ts");
  assert.ok(c.includes('export const listCreditCircuits = createServerFn({ method: "GET" })'), "GET, no POST: no escribe nada");
  assert.ok(c.includes('export const listFundingRates = createServerFn({ method: "GET" })'), "GET, no POST: no escribe nada");
  assert.ok(!c.includes("insert into") && !c.includes("update ") && !c.includes("delete from"), "el módulo no escribe nada en la base");
  assert.ok(c.includes("where company_id = ${companyId}"), "cada consulta filtra por la empresa del usuario");
  const body = sinComentarios(c);
  // Ningún número de negocio en el código: ni comisión, ni spread.
  assert.ok(!/0\.0[0-9]/.test(body.replace(/numeric\(\d+,\s*\d+\)/g, "")), "sin fracciones de negocio escritas a mano en el módulo");
});

test("circuits.ts: cuatro códigos fijos, sin catálogo editable desde aquí", () => {
  const c = src("src/lib/erp/circuits.ts");
  assert.ok(c.includes('export type CircuitCode = "CONTADO" | "ASR" | "SANTA_ROSA" | "PROPIA";'));
  assert.ok(!c.includes("saveCreditCircuit") && !c.includes("createCircuit"), "no hay forma de crear ni editar un circuito todavía");
});

test("Ajustes: el panel de circuitos es de solo lectura y dice que nadie más lo usa", () => {
  const st = src("src/routes/settings.tsx");
  assert.ok(st.includes("Circuitos de financiamiento (solo lectura)"), "el panel existe y se anuncia como solo lectura");
  assert.ok(st.includes("await listCreditCircuits().catch(() => []))"), "se carga con la función de solo lectura");
  assert.ok(st.includes("await listFundingRates().catch(() => []))"), "y la tabla de tasas también");
  assert.ok(
    st.includes("este catálogo todavía no lo lee nadie: ni el precio, ni la mora, ni los reportes"),
    "el texto de pantalla deja explícito que esto todavía no hace nada",
  );
  assert.ok(!st.includes("saveCreditCircuit") && !st.includes("saveFundingRate"), "no hay botón de guardar circuitos ni tasas");
  // Nace vacía a propósito: el panel lo dice, no oculta el estado real.
  assert.ok(st.includes("Sin renglones capturados todavía."), "la tabla de tasas dice que está vacía, no inventa un renglón");
});

test("cableado: nada de negocio lee todavía credit_circuits ni funding_rates", () => {
  // El paso 1 solo agrega la ETIQUETA (circuit_code) y sus ayudantes puros.
  // Las tablas del catálogo siguen sin lector fuera de circuits.ts y su
  // prueba de migración: si aparecen en pricing.ts, margins.ts, credit.ts,
  // reports.ts, ops.ts, orders.ts o requests.ts, ya no es "nadie lo lee".
  const archivosDeNegocio = [
    "src/lib/erp/pricing.ts",
    "src/lib/erp/margins.ts",
    "src/lib/erp/credit.ts",
    "src/lib/erp/reports.ts",
    "src/lib/erp/ops.ts",
    "src/lib/erp/orders.ts",
    "src/lib/erp/requests.ts",
    "src/lib/erp/ladder.ts",
    "src/lib/azagro.ts",
    "src/lib/erp/cpo.ts",
    "src/lib/erp/cutover.ts",
  ];
  for (const f of archivosDeNegocio) {
    const body = src(f);
    assert.ok(!body.includes("credit_circuits"), `${f} no debe leer credit_circuits todavía (paso 3)`);
    assert.ok(!body.includes("funding_rates"), `${f} no debe leer funding_rates todavía (paso 3)`);
  }
});

// ---------------------------------------------------------------------------
// PASO 1 — la etiqueta.
// ---------------------------------------------------------------------------

test("paso 1: la regla del circuito nuevo — plazo 0 es Contado; con plazo, mientras no exista el lineal, Circuito ASR", () => {
  const c = src("src/lib/erp/circuits.ts");
  assert.ok(c.includes('return days > 0 ? "ASR" : "CONTADO";'), "circuitForTerm copiado literal");
  assert.equal(circuitForTerm(0), "CONTADO");
  assert.equal(circuitForTerm(-5), "CONTADO", "un plazo negativo no es crédito");
  assert.equal(circuitForTerm(1), "ASR");
  assert.equal(circuitForTerm(150), "ASR");
  assert.equal(c.match(/export const CUTOVER_CIRCUIT: CircuitCode = "ASR";/g)?.length, 1, "el corte de Compaq entra al circuito ASR, siempre");
});

test("paso 1: herencia por la cadena — igual que el plazo: el de arriba manda, plazo 0 lo vuelve Contado, Contado con plazo propone ASR", () => {
  const c = src("src/lib/erp/circuits.ts");
  assert.ok(c.includes('if (days <= 0) return "CONTADO";'), "inheritCircuit copiado literal (1/3)");
  assert.ok(c.includes('if (isCircuitCode(upstream) && upstream !== "CONTADO") return upstream;'), "inheritCircuit copiado literal (2/3)");
  assert.ok(c.includes("return circuitForTerm(days);"), "inheritCircuit copiado literal (3/3)");
  // SOL a 90 d (ASR) → COT a 90 d: ASR.
  assert.equal(inheritCircuit("ASR", 90), "ASR");
  // COT ASR → pedido de contado (oferta contado): Contado.
  assert.equal(inheritCircuit("ASR", 0), "CONTADO");
  // SOL de contado → COT a 60 d: la propuesta es ASR (todavía no hay lineal).
  assert.equal(inheritCircuit("CONTADO", 60), "ASR");
  // Documento viejo sin etiqueta: aplica la regla nueva.
  assert.equal(inheritCircuit(null, 30), "ASR");
  assert.equal(inheritCircuit(undefined, 0), "CONTADO");
  // Un circuito de crédito ya elegido (paso 2) se respeta mientras haya plazo.
  assert.equal(inheritCircuit("SANTA_ROSA", 120), "SANTA_ROSA");
  assert.equal(inheritCircuit("PROPIA", 120), "PROPIA");
  assert.equal(inheritCircuit("SANTA_ROSA", 0), "CONTADO");
  // Basura en la base no se hereda: aplica la regla.
  assert.equal(inheritCircuit("XYZ", 30), "ASR");
  // Nunca un plazo decidido por la etiqueta: el plazo entra, no sale.
  assert.ok(!c.includes("route_kind") && !c.includes("routeKind"), "route_kind es logística: no decide el circuito");
});

test("paso 1: el circuito se guarda y se hereda en cada alta de la cadena (SOL → COT → PV → FV → NC/FI/ATC), sin usar route_kind", () => {
  const req = src("src/lib/erp/requests.ts");
  const ops = src("src/lib/erp/ops.ts");
  const az = src("src/lib/azagro.ts");
  const orders = src("src/lib/erp/orders.ts");
  // SOL: nace SIN circuito (nulo) — no es "de contado", es que nadie ha
  // capturado el plazo todavía; Contado es justo el circuito que no cobra
  // financiamiento, y no lo decide el sistema por cuenta propia (decisión
  // del dueño, 5-sep-2026). Se resuelve sola al capturar el plazo.
  assert.ok(/insert into customer_requests \([^)]*circuit_code\)/.test(req), "createRequest guarda circuit_code");
  assert.ok(req.slice(req.indexOf("insert into customer_requests"), req.indexOf("insert into customer_requests") + 400).includes("${data.locationId ?? null},\n        ${null})"), "solicitud nueva: circuit_code nulo, no Contado por omisión");
  assert.ok(!req.includes("circuitForTerm"), "requests.ts ya no usa circuitForTerm: la solicitud no nace resuelta");
  assert.ok(req.includes("inheritCircuit(before[0].circuit_code, data.creditDays)"), "saveRequestTerms recalcula la etiqueta con el plazo nuevo (null se resuelve igual que Contado)");
  assert.ok(req.includes("cambios.push(`circuito ${circuitLabel(before[0].circuit_code)} → ${circuitLabel(circuit)}`)"), "y lo deja en bitácora");
  // SOL → COT.
  assert.ok(req.includes("inheritCircuit(req[0].circuit_code, data.creditDays)"), "quoteFromRequest hereda de la solicitud");
  assert.ok(/insert into quotes \([^)]*request_id, circuit_code\)/.test(req), "…y lo escribe en la cotización");
  // COT directa (sin solicitud) y revisión.
  assert.ok(ops.includes("${circuitForTerm(data.creditDays ?? 0)}"), "createQuote: regla por plazo");
  assert.ok(ops.includes("const circuitRev = inheritCircuit(q[0].circuit_code, data.creditDays ?? q[0].credit_days);"), "reviseQuote sigue al plazo nuevo");
  assert.ok(ops.includes("circuit_code = ${circuitRev},"), "…y lo guarda");
  // COT → PV.
  assert.ok(ops.includes("${inheritCircuit(q[0].circuit_code, days)}"), "decideQuote: el pedido hereda de la cotización (días de la oferta aceptada)");
  const pedidoDesdeCot = ops.slice(ops.indexOf("const termKind = days > 0"), ops.indexOf("${inheritCircuit(q[0].circuit_code, days)}"));
  assert.ok(!pedidoDesdeCot.includes("inheritCircuit(routeKind") && !pedidoDesdeCot.includes("circuitForTerm(routeKind"), "route_kind no decide el circuito");
  // PV manual y cambio de plazo.
  assert.ok(orders.includes("${circuitForTerm(dues.creditDays)}"), "saveOrder (alta manual): regla por plazo");
  assert.equal(orders.match(/circuit_code = \$\{circuit\},/g)?.length, 2, "saveOrder y changeOrderTerm recalculan y guardan la etiqueta");
  assert.equal(orders.match(/cambios\.push\(`circuito \$\{circuitLabel\(/g)?.length, 2, "…con bitácora en los dos");
  // OC del cliente → PV.
  assert.ok(src("src/lib/erp/cpo.ts").includes("${circuitForTerm(plazo)}"), "el pedido desde OC del cliente: regla por el plazo del cliente");
  // PV → FV → NC.
  assert.ok(az.includes("${inheritCircuit(so[0].circuit_code, so[0].credit_days ?? 0)}"), "deliverSale: la FV hereda del pedido");
  assert.ok(/created_by, circuit_code\n\s+\)\n\s+values \([\s\S]{0,400}\$\{so\[0\]\.circuit_code\}/.test(az), "returnSale: la NC hereda del pedido");
  // FV → FI (mora) y → ATC (tipo de cambio).
  assert.equal(ops.match(/\$\{inv\[0\]\.circuit_code\}/g)?.length, 2, "FI y ATC heredan de su factura de origen");
  // Corte de Compaq: todo al circuito ASR (solo facturas de cliente).
  const cut = src("src/lib/erp/cutover.ts");
  assert.ok(cut.includes('${r.kind === "customer" ? CUTOVER_CIRCUIT : null}'), "el importador pone Circuito ASR a las facturas de cliente");
  assert.ok(cut.includes("· circuito ${CIRCUIT_LABEL[CUTOVER_CIRCUIT]}"), "y lo deja en la bitácora del corte");
  // Facturas de proveedor: sin circuito (no es su concepto).
  for (const m of az.matchAll(/insert into invoices \(([^)]*)\)\s*values \(\s*\$\{[^,]+\}, 'supplier'/g)) {
    assert.ok(!m[1].includes("circuit_code"), "una FP no lleva circuito");
  }
});

test("paso 1: la etiqueta se muestra de solo lectura en las cuatro pantallas y en el estado de cuenta (solo en pantalla)", () => {
  assert.ok(src("src/routes/solicitudes.$solicitudId.tsx").includes("data?.quote ? circuitLabel(data.quote.circuit_code) : requestCircuitLabel(data?.request.circuit_code)"), "solicitud");
  assert.ok(src("src/routes/quotes.tsx").includes("{circuitLabel(qrow.circuit_code)}"), "cotización (panel Ver)");
  const form = src("src/components/order-form.tsx");
  assert.ok(form.includes("circuit?: string | null;") && form.includes("{circuitLabel(circuit)}"), "pedido: dato de solo lectura, sin selector");
  // La solicitud (antes de cotizar) usa su propio texto: "Sin definir", no
  // el "Sin circuito" genérico — no capturar el plazo no es un error.
  const sol = src("src/routes/solicitudes.$solicitudId.tsx");
  assert.ok(sol.includes("requestCircuitLabel(data?.request.circuit_code)"), "solicitud sin cotizar: requestCircuitLabel");
  assert.ok(sol.includes("data?.quote ? circuitLabel(data.quote.circuit_code)"), "solicitud ya cotizada: la etiqueta resuelta de la cotización");
  const c = src("src/lib/erp/circuits.ts");
  assert.ok(c.includes('return isCircuitCode(code) ? CIRCUIT_LABEL[code] : "Sin definir";'), "requestCircuitLabel: nulo dice Sin definir, no Sin circuito");
  for (const sel of form.match(/<select[\s\S]*?<\/select>/g) ?? []) assert.ok(!/circuit/i.test(sel), "todavía no hay selector de circuito (paso 2)");
  assert.ok(src("src/routes/sales.$orderId.tsx").includes("circuit={circuit}"), "la pantalla del pedido lo pasa desde el pedido guardado");
  assert.ok(src("src/routes/credit.tsx").includes("circuitLabel(r.circuit_code)"), "cartera");
  const ops = src("src/lib/erp/ops.ts");
  assert.ok(ops.includes("formula.lines.push(`Circuito de financiamiento: ${circuitLabel(inv.circuit_code)}"), "estado de cuenta: renglón de explicación en pantalla");
  assert.ok(ops.includes("circuitCode: inv.circuit_code,"), "…y el dato en el renglón");
  // Al cliente no le sale: el papel (doc-text.ts) no conoce el circuito.
  assert.ok(!/circuit/i.test(src("src/lib/erp/doc-text.ts")), "el documento que sale al cliente no menciona el circuito");
});

test("paso 1: el motor sigue leyendo Ajustes — precio, márgenes, mora, escalera y reportes no conocen el circuito", () => {
  const motor = ["src/lib/erp/pricing.ts", "src/lib/erp/margins.ts", "src/lib/erp/credit.ts", "src/lib/erp/ladder.ts", "src/lib/erp/reports.ts"];
  for (const f of motor) {
    const body = src(f);
    for (const palabra of ["circuit_code", "circuitCode", "credit_circuits", "funding_rates", "erp/circuits", "./circuits"]) {
      assert.ok(!body.includes(palabra), `${f} no debe mencionar ${palabra} (el motor lee el circuito en el paso 3)`);
    }
  }
});

test("paso 1: la migración 0025 etiqueta por plazo y por origen, nunca por route_kind, y no toca lo ya etiquetado", () => {
  const sql = sinComentariosSql(src("migrations/0025_circuito_etiqueta.sql"));
  assert.ok(!sql.includes("route_kind"), "route_kind es logística: la migración no lo consulta");
  for (const t of ["customer_requests", "quotes", "sales_orders", "invoices"]) {
    assert.ok(sql.includes(`alter table ${t} add column if not exists circuit_code text;`), `${t}.circuit_code nulo permitido`);
  }
  assert.equal((sql.match(/where circuit_code is null/g) ?? []).length + (sql.match(/i\.circuit_code is null/g) ?? []).length, 7, "cada update respeta lo ya etiquetado (idempotente)");
  assert.ok(sql.includes("origin = 'Corte Compaq'"), "el corte de Compaq se reconoce por su origen");
  assert.ok(sql.includes("i.origin in ('Mora ' || o.name, 'Ajuste TC ' || o.name)"), "FI y ATC se ligan a su FV por el origen que escribe el sistema");
  assert.ok(!sql.includes("not null") || sql.includes("is not null"), "la columna no lleva NOT NULL: sin selector todavía");
});

test("hallazgo anotado: la comisión de la cotización no se congela (pendiente para el paso 3)", () => {
  // Este paso no lo corrige — solo confirma que el hallazgo sigue siendo
  // cierto hoy, para que la corrección del paso 3 sepa exactamente qué
  // arreglar. TIIE y spread SÍ están congelados en la cotización; la
  // comisión se relee en vivo de Ajustes en cada camino que reprecia.
  const orders = src("src/lib/erp/orders.ts");
  const ops = src("src/lib/erp/ops.ts");
  assert.ok(orders.includes("commissionRate: pol.asrCommission"), "changeOrderTerm relee la comisión de Ajustes, no la de la cotización");
  assert.ok(orders.includes("tiie: Number(q[0].tiie)") && orders.includes("costSpread: Number(q[0].spread)"), "TIIE y spread sí salen de la cotización congelada");
  const revise = ops.slice(ops.indexOf("const marginUpdates = new Map"), ops.indexOf("const marginUpdates = new Map") + 1200);
  assert.ok(revise.includes("commissionRate: pol.asrCommission"), "reviseQuote también relee la comisión en vivo");
  assert.ok(ESTADO_TIENE_EL_HALLAZGO(), "ESTADO.md debe registrar este hallazgo con archivo y línea");
});

function ESTADO_TIENE_EL_HALLAZGO() {
  const estado = src("ESTADO.md");
  return estado.includes("orders.ts:435") && estado.includes("ops.ts:1050") && /comisi[oó]n.*no se congela/i.test(estado);
}
