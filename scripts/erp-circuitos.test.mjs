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

test("circuits.ts: lecturas GET scoped por empresa; las dos escrituras del paso 3 son de administrador con bitácora", () => {
  const c = src("src/lib/erp/circuits.ts");
  assert.ok(c.includes('export const listCreditCircuits = createServerFn({ method: "GET" })'), "GET, no POST: no escribe nada");
  assert.ok(c.includes('export const listFundingRates = createServerFn({ method: "GET" })'), "GET, no POST: no escribe nada");
  // Paso 3: el catálogo no se crea ni se borra desde aquí; solo se captura la
  // comisión de un circuito y los renglones de la tabla de tasas, y las dos
  // exigen administrador y dejan bitácora.
  assert.ok(!c.includes("delete from"), "nada se borra desde aquí");
  assert.ok(!c.includes("insert into credit_circuits"), "el catálogo nace con la migración, no desde pantalla");
  assert.equal(c.match(/await assertAdmin\(sql, context\.userId\);/g)?.length, 2, "saveFundingRate y saveCircuitCommission: solo administrador");
  assert.equal(c.match(/await writeAudit\(sql, \{/g)?.length, 2, "…con bitácora las dos");
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

test("Ajustes: el panel de circuitos dice que el precio lee de ahí, captura la comisión del circuito y los renglones de la tabla de tasas", () => {
  const st = src("src/routes/settings.tsx");
  assert.ok(st.includes('<h2 className="text-sm font-semibold">Circuitos de financiamiento</h2>'), "el panel existe (ya no es solo lectura)");
  assert.ok(st.includes("await listCreditCircuits().catch(() => [])"), "se carga con la función de lectura");
  assert.ok(st.includes("await listFundingRates().catch(() => [])"), "y la tabla de tasas también");
  assert.ok(st.includes("El precio lee de aquí la comisión y la") && st.includes("base del circuito del documento (paso 3)"), "el texto dice quién lo lee y desde cuándo");
  assert.ok(!st.includes("saveCreditCircuit"), "el catálogo no se crea ni se edita entero desde pantalla");
  assert.ok(st.includes("saveFundingRate(") && st.includes("saveCircuitCommission("), "sí se capturan tasas y la comisión del circuito");
  // Nace vacía a propósito: el panel lo dice, no oculta el estado real.
  assert.ok(st.includes("Sin renglones capturados todavía."), "la tabla de tasas dice que está vacía, no inventa un renglón");
});

test("cableado: las tablas del catálogo solo las lee circuits.ts; el motor puro (pricing, margins, ladder, credit) recibe los números", () => {
  // Paso 3: el servidor (ops, orders, requests, azagro, reports) llega al
  // catálogo SOLO a través de circuits.ts (circuitTerms / priceRateFor /
  // readCircuits). Ningún otro archivo escribe el nombre de la tabla, y el
  // motor puro sigue sin importar circuits.ts: recibe comisión y base por
  // parámetro.
  for (const f of [
    "src/lib/erp/pricing.ts",
    "src/lib/erp/margins.ts",
    "src/lib/erp/credit.ts",
    "src/lib/erp/ladder.ts",
    "src/lib/erp/reports.ts",
    "src/lib/erp/ops.ts",
    "src/lib/erp/orders.ts",
    "src/lib/erp/requests.ts",
    "src/lib/azagro.ts",
    "src/lib/erp/cpo.ts",
    "src/lib/erp/cutover.ts",
  ]) {
    // Se miran solo las líneas de código: un comentario puede nombrar la tabla.
    const body = sinComentarios(src(f));
    assert.ok(!body.includes("credit_circuits"), `${f} no lee credit_circuits directo: pasa por circuits.ts`);
    assert.ok(!body.includes("funding_rates"), `${f} no lee funding_rates directo: pasa por circuits.ts`);
  }
  for (const f of ["src/lib/erp/pricing.ts", "src/lib/erp/margins.ts", "src/lib/erp/ladder.ts", "src/lib/erp/credit.ts"]) {
    assert.ok(!src(f).includes("erp/circuits") && !src(f).includes("./circuits"), `${f}: el motor puro no importa circuits.ts`);
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
  assert.ok(req.includes('cambios.push(`circuito ${circuitLabel(before[0].circuit_code)} → ${circuitLabel(circuit)}${elegido ? " (elegido)" : ""}`)'), "y lo deja en bitácora, marcado si lo eligió a mano");
  // SOL → COT.
  assert.ok(req.includes("inheritCircuit(req[0].circuit_code, data.creditDays)"), "quoteFromRequest hereda de la solicitud");
  assert.ok(/insert into quotes \([^)]*request_id, circuit_code,\s*commission_rate, cost_rate, collection_rate\)/.test(req), "…y lo escribe en la cotización (junto a lo congelado del paso 3)");
  // COT directa (sin solicitud) y revisión.
  assert.ok(ops.includes("circuitForTerm(data.creditDays ?? 0)"), "createQuote: regla por plazo (default cuando no se elige a mano)");
  assert.ok(ops.includes("let circuitRev = inheritCircuit(q[0].circuit_code, data.creditDays ?? q[0].credit_days);"), "reviseQuote sigue al plazo nuevo (o lo elige a mano el administrador)");
  assert.ok(ops.includes("circuit_code = ${circuitRev},"), "…y lo guarda");
  // COT → PV.
  assert.ok(ops.includes("${inheritCircuit(q[0].circuit_code, days)}"), "decideQuote: el pedido hereda de la cotización (días de la oferta aceptada)");
  const pedidoDesdeCot = ops.slice(ops.indexOf("const termKind = days > 0"), ops.indexOf("${inheritCircuit(q[0].circuit_code, days)}"));
  assert.ok(!pedidoDesdeCot.includes("inheritCircuit(routeKind") && !pedidoDesdeCot.includes("circuitForTerm(routeKind"), "route_kind no decide el circuito");
  // PV manual y cambio de plazo.
  assert.ok(orders.includes("circuitForTerm(dues.creditDays)"), "saveOrder (alta manual): regla por plazo (default cuando no se elige a mano)");
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

test("paso 1: la etiqueta se muestra en las cuatro pantallas y en el estado de cuenta (solo en pantalla), en vivo mientras se decide", () => {
  const sol = src("src/routes/solicitudes.$solicitudId.tsx");
  // Antes de que exista un plazo (ni tecleado ni guardado) no hay circuito
  // que proponer: "Sin definir" propio, no el "Sin circuito" genérico de
  // un documento roto.
  assert.ok(sol.includes("requestCircuitLabel(request.circuit_code)"), "solicitud sin plazo decidido: requestCircuitLabel");
  assert.ok(sol.includes('{quote ? (\n              <p className="text-sm">{circuitLabel(quote.circuit_code)}'), "solicitud ya cotizada: la etiqueta resuelta de la cotización, fija");
  assert.ok(sol.includes("circuitOverride ?? inheritCircuit(request.circuit_code, days)"), "solicitud: circuito en vivo mientras se teclea el plazo, sin esperar a guardar");
  const c = src("src/lib/erp/circuits.ts");
  assert.ok(c.includes('return isCircuitCode(code) ? CIRCUIT_LABEL[code] : "Sin definir";'), "requestCircuitLabel: nulo dice Sin definir, no Sin circuito");
  assert.ok(src("src/routes/quotes.tsx").includes("{circuitLabel(qrow.circuit_code)}"), "cotización (panel Ver, quedó cerrada o vino de una solicitud): solo lectura, fija");
  assert.ok(src("src/routes/credit.tsx").includes("circuitLabel(r.circuit_code)"), "cartera");
  const ops = src("src/lib/erp/ops.ts");
  assert.ok(ops.includes("formula.lines.push(`Circuito de financiamiento: ${circuitLabel(inv.circuit_code)}"), "estado de cuenta: renglón de explicación en pantalla");
  assert.ok(ops.includes("circuitCode: inv.circuit_code,"), "…y el dato en el renglón");
  // Al cliente no le sale: el papel (doc-text.ts) no conoce el circuito.
  assert.ok(!/circuit/i.test(src("src/lib/erp/doc-text.ts")), "el documento que sale al cliente no menciona el circuito");
});

test("paso 3: el motor puro recibe el circuito por parámetro — pricing, margins, ladder y credit no conocen la etiqueta ni el catálogo", () => {
  // Hasta el paso 2 esto incluía reports.ts; en el paso 3 el P&L SÍ lee el
  // circuito del documento (es parte del motor que lo recibe). Lo que sigue
  // prohibido es que el motor puro lea la etiqueta o el catálogo.
  const motor = ["src/lib/erp/pricing.ts", "src/lib/erp/margins.ts", "src/lib/erp/credit.ts", "src/lib/erp/ladder.ts"];
  for (const f of motor) {
    const body = src(f);
    for (const palabra of ["circuit_code", "circuitCode", "credit_circuits", "funding_rates", "erp/circuits", "./circuits"]) {
      assert.ok(!body.includes(palabra), `${f} no debe mencionar ${palabra}: recibe comisión y base por parámetro`);
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
  assert.ok(!sql.includes("not null") || sql.includes("is not null"), "la columna sigue nula-permitida: ni la migración ni el selector del paso 2 obligan a elegir");
});

// ---------------------------------------------------------------------------
// PASO 2 — el selector (5-sep-2026): el sistema PROPONE según el plazo, la
// persona confirma o cambia. Solo Contado y Circuito ASR son elegibles;
// Línea Santa Rosa y Línea propia salen apagadas, "por construir". Solo
// ADMINISTRADOR puede moverlo — cualquier otro rol lo ve, no lo mueve.
// Candado tras confirmar el pedido; para un pedido que vino de cotización el
// circuito nunca se elige a mano, se hereda. El motor sigue sin leerlo.
// ---------------------------------------------------------------------------

test("paso 2: solo dos códigos elegibles, los otros dos por construir", () => {
  const c = src("src/lib/erp/circuits.ts");
  assert.ok(c.includes('export const SELECTABLE_CIRCUITS: CircuitCode[] = ["CONTADO", "ASR"];'), "solo Contado y Circuito ASR");
  assert.ok(c.includes('export const CIRCUIT_CODES: CircuitCode[] = ["CONTADO", "ASR", "SANTA_ROSA", "PROPIA"];'), "el selector lista los cuatro, en el orden del catálogo");
  assert.ok(c.includes('export function circuitForTerm(days: number): "CONTADO" | "ASR" {'), "circuitForTerm nunca propone un circuito por construir");
});

test("paso 2: CircuitSelect propone, no fuerza — apaga los dos por construir y respeta 'editable' (admin + sin candado)", () => {
  const cs = src("src/components/circuit-select.tsx");
  assert.ok(cs.includes("if (!editable) {") && cs.includes("return <p className=\"text-sm\">{circuitLabel(value)}</p>;"), "no editable: se ve, no se mueve (misma etiqueta que paso 1)");
  assert.ok(cs.includes("disabled={!SELECTABLE_CIRCUITS.includes(code)}"), "Línea Santa Rosa y Línea propia no se pueden elegir en el <select>");
  assert.ok(cs.includes('{SELECTABLE_CIRCUITS.includes(code) ? "" : " (por construir)"}'), "…y lo dicen");
  assert.ok(cs.includes("if (isSelectableCircuit(e.target.value)) onChange(e.target.value);"), "el cambio nunca dispara con un código no elegible");
});

test("paso 2: elegir circuito a mano es solo de administrador — servidor, no solo pantalla", () => {
  const req = src("src/lib/erp/requests.ts");
  const ops = src("src/lib/erp/ops.ts");
  const orders = src("src/lib/erp/orders.ts");
  assert.ok(req.includes("if (data.circuitCode !== undefined) await assertAdmin(sql, context.userId);"), "saveRequestTerms: admin o truena");
  assert.equal(ops.match(/if \(data\.circuitCode !== undefined\) await assertAdmin\(sql, context\.userId\);/g)?.length, 2, "createQuote y reviseQuote: admin o truena, en los dos");
  assert.ok(orders.includes('if (data.circuitCode !== undefined && member.role !== "admin") {'), "saveOrder: admin o truena");
  // Los cuatro validan contra el mismo par de códigos elegibles, nunca los cuatro.
  assert.equal(
    (req.match(/circuitCode: z\.enum\(\["CONTADO", "ASR"\]\)\.optional\(\)/g)?.length ?? 0) +
      (ops.match(/circuitCode: z\.enum\(\["CONTADO", "ASR"\]\)\.optional\(\)/g)?.length ?? 0) +
      (orders.match(/circuitCode: z\.enum\(\["CONTADO", "ASR"\]\)\.optional\(\)/g)?.length ?? 0),
    4,
    "saveRequestTerms, createQuote, reviseQuote y saveOrder: mismo par elegible en el validador",
  );
});

test("paso 2: la elección manual manda sobre la regla, y queda marcada en bitácora", () => {
  const req = src("src/lib/erp/requests.ts");
  const ops = src("src/lib/erp/ops.ts");
  const orders = src("src/lib/erp/orders.ts");
  assert.ok(
    req.includes("if (data.circuitCode !== undefined && isSelectableCircuit(data.circuitCode)) {\n      circuit = data.circuitCode;\n      elegido = true;\n    }"),
    "saveRequestTerms: la elección pisa la regla",
  );
  assert.equal(ops.match(/circuitElegido = true;/g)?.length, 1, "reviseQuote también distingue elegido de propuesto");
  assert.ok(orders.includes("current[0].quote_id == null) {\n        circuit = data.circuitCode;\n        circuitElegido = true;"), "saveOrder: solo aplica en un pedido DIRECTO");
  for (const [f, cambio] of [
    [req, 'cambios.push(`circuito ${circuitLabel(before[0].circuit_code)} → ${circuitLabel(circuit)}${elegido ? " (elegido)" : ""}`)'],
    [ops, 'cambios.push(`circuito ${circuitLabel(q[0].circuit_code)} → ${circuitLabel(circuitRev)}${circuitElegido ? " (elegido)" : ""}`)'],
    [orders, 'cambios.push(`circuito ${circuitLabel(current[0].circuit_code)} → ${circuitLabel(circuit)}${circuitElegido ? " (elegido)" : ""}`)'],
  ]) {
    assert.ok(f.includes(cambio), `bitácora marca "(elegido)" cuando fue un pick manual: ${cambio.slice(0, 40)}…`);
  }
});

test("paso 2: un pedido que vino de cotización NUNCA elige circuito a mano — se hereda, punto", () => {
  const orders = src("src/lib/erp/orders.ts");
  // decideQuote (COT → PV) sigue siendo herencia pura, sin circuitCode en su validador.
  const decideStart = orders.indexOf("export const decideQuote");
  assert.equal(decideStart, -1, "decideQuote vive en ops.ts, no en orders.ts (nada que verificar aquí)");
  const opsSrc = src("src/lib/erp/ops.ts");
  const decide = opsSrc.slice(opsSrc.indexOf("export const decideQuote"), opsSrc.indexOf("export const decideQuote") + 3500);
  assert.ok(!decide.includes("circuitCode"), "decideQuote no acepta un circuito a mano: el pedido que nace de cotización hereda de ahí");
  // saveOrder: la elección manual solo aplica cuando el pedido no trae quote_id.
  assert.ok(orders.includes("quote_id: number | null;") && orders.includes("current[0].quote_id == null"), "saveOrder verifica que el pedido sea DIRECTO antes de aceptar una elección manual");
});
test("paso 2: las tres pantallas de origen — solicitud, cotización directa, pedido directo — proponen con la regla y dejan cambiar", () => {
  // Solicitud: ya cubierto arriba (CircuitSelect con inheritCircuit en vivo).
  const quotes = src("src/routes/quotes.tsx");
  assert.ok(quotes.includes('const isAdmin = useAccess().role === "admin";'), "cotizaciones: sabe si el usuario es administrador");
  assert.ok(quotes.includes('const [circuitCode, setCircuitCode] = useState<CircuitCode>("CONTADO");'), "cotización directa nueva: propone con la regla");
  assert.ok(quotes.includes("circuitCode: circuitTouched && isSelectableCircuit(circuitCode) ? circuitCode : undefined,"), "…y solo manda el pick si lo tocó (si no, el servidor propone igual)");
  assert.ok(quotes.includes("{!qrow.request_name && revisable ? ("), "revisión: el selector solo aparece en una cotización DIRECTA (sin solicitud) y todavía abierta");
  assert.ok(
    quotes.includes('value={circuitOverride ?? (inheritCircuit(qrow.circuit_code, agreedDays) as "CONTADO" | "ASR")}'),
    "…en vivo con el plazo acordado de la revisión, no el guardado",
  );
  const orderForm = src("src/components/order-form.tsx");
  assert.ok(
    orderForm.includes('circuit?: { value: CircuitCode; editable: boolean; onChange: (code: "CONTADO" | "ASR") => void } | null;'),
    "pedido: el prop ahora trae valor + si es editable + el manejador, no solo el texto del paso 1",
  );
  const nuevo = src("src/routes/sales.nuevo.tsx");
  assert.ok(nuevo.includes('editable: access.role === "admin",'), "pedido directo nuevo: solo administrador lo mueve");
  assert.ok(nuevo.includes("setCircuitCode((c) => inheritCircuit(c, dues?.creditDays ?? 0)"), "…y propone según el plazo mientras se compone el pedido");
  const ficha = src("src/routes/sales.$orderId.tsx");
  assert.ok(ficha.includes("editable: !origin && isAdmin && editable,"), "pedido cargado: el selector solo aparece en uno DIRECTO (sin origin) y sigue las reglas normales de edición");
});

test("paso 2: candado tras confirmar el pedido — el mismo 'editable' del formulario, no uno nuevo", () => {
  const ficha = src("src/routes/sales.$orderId.tsx");
  assert.ok(ficha.includes('const editable = canEdit && state === "draft";'), "el pedido deja de editarse (todo, no solo el circuito) en cuanto sale de borrador");
  assert.ok(ficha.includes("editable: !origin && isAdmin && editable,"), "el circuito usa exactamente ese mismo candado — no uno aparte, más permisivo o más estricto");
});

test("paso 2: 'Tipo de entrega: Circuito ASR' se renombró a 'Entrega directa vía ASR' — sigue siendo route_kind, logística, no el circuito de financiamiento", () => {
  const orderForm = src("src/components/order-form.tsx");
  assert.ok(orderForm.includes('{ id: "asr", label: "Entrega directa vía ASR" },'), "el texto del renglón de logística cambió");
  assert.ok(!orderForm.includes('{ id: "asr", label: "Circuito ASR" }'), "…y el nombre viejo, que se confundía con el circuito, ya no está ahí");
  assert.ok(orderForm.includes('export type RouteKind = "own" | "supplier" | "asr";') && orderForm.includes('routeKind: RouteKind;'), "sigue siendo el mismo campo (route_kind): nada de lógica cambió, solo el texto");
});

test("paso 2: el motor sigue sin leer el circuito ni el catálogo (mismo barrido que el paso 1, con dos archivos más)", () => {
  const motor = [
    "src/lib/erp/pricing.ts",
    "src/lib/erp/margins.ts",
    "src/lib/erp/credit.ts",
    "src/lib/erp/ladder.ts",
    "src/lib/erp/reports.ts",
    "src/lib/erp/cpo.ts",
  ];
  for (const f of motor) {
    const body = src(f);
    for (const palabra of ["credit_circuits", "funding_rates"]) {
      assert.ok(!body.includes(palabra), `${f} no debe leer ${palabra} todavía (paso 3)`);
    }
  }
  // cpo.ts sí menciona circuitForTerm (paso 1, regla por plazo) — eso ya se
  // vigiló arriba; aquí solo se confirma que no lee el catálogo.
});

test("hallazgo CERRADO (paso 3): la comisión se congela en la cotización junto a la TIIE y el spread", () => {
  // ESTADO.md § 6: changeOrderTerm y reviseQuote releían pol.asrCommission
  // en vivo, así que una cotización vieja cambiaba de precio al revisarla si
  // alguien movía la comisión en Ajustes. Ahora los dos leen
  // quotes.commission_rate, escrita al cotizar, y se detienen si falta.
  const orders = src("src/lib/erp/orders.ts");
  const ops = src("src/lib/erp/ops.ts");
  assert.ok(!orders.includes("pol.asrCommission") && !ops.includes("pol.asrCommission"), "nadie relee la comisión de Ajustes");
  assert.ok(orders.includes("commissionRate: frozenCommission })"), "changeOrderTerm reprecia con la comisión congelada");
  assert.ok(orders.includes("tiie: Number(q[0].tiie)") && orders.includes("costSpread: Number(q[0].spread)"), "TIIE y spread siguen saliendo de la cotización congelada");
  const revise = ops.slice(ops.indexOf("export const reviseQuote"), ops.indexOf("export const decideQuote"));
  assert.ok(revise.includes("const frozenCommission = Number(q[0].commission_rate);") && revise.includes("commissionRate: frozenCommission })"), "reviseQuote también");
  assert.ok(ESTADO_CERRO_EL_HALLAZGO(), "ESTADO.md § 6 debe decir que quedó cerrado en el paso 3");
});

function ESTADO_CERRO_EL_HALLAZGO() {
  const estado = src("ESTADO.md");
  const seis = estado.slice(estado.indexOf("## 6. Hallazgo"), estado.indexOf("## 7."));
  return /CERRADO/.test(seis) && seis.includes("quotes.commission_rate") && seis.includes("0026");
}
