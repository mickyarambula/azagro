// CATÁLOGO DE CIRCUITOS DE FINANCIAMIENTO — PASO 0 (5-sep-2026).
//
// Ver DISENO_FINANCIAMIENTO.md, ESTADO.md, DECISIONES.md. Cada pedido va a
// declarar por dónde corre su financiamiento (quién pone el capital, quién
// factura al cliente, sobre qué base corre el financiamiento, qué comisión
// cobra), en vez de que esos cuatro datos sean una sola fila global de
// Ajustes. Este paso SOLO crea el catálogo (credit_circuits) y la tabla de
// tasas de dos columnas (funding_rates), y los expone en un panel de solo
// lectura en Ajustes. Nada más los toca: el precio, la mora y los reportes
// siguen exactamente igual que antes (paso 3, más adelante).
//
// La prueba de la siembra de la migración (que la comisión del circuito ASR
// se copia de Ajustes y nunca se escribe un 1%) vive en
// scripts/migrations-apply.test.mjs. Aquí se prueba el cableado: que el
// módulo y el panel existen, son de solo lectura, y que ningún camino de
// negocio (precio, mora, reportes) los está leyendo todavía.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");
const sinComentarios = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:'"`])\/\/.*$/gm, "$1");

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
  // Los únicos dos archivos que pueden mencionar estas tablas hoy son el
  // propio módulo y su prueba de migración. Si aparecen en pricing.ts,
  // margins.ts, credit.ts, reports.ts, ops.ts, orders.ts o requests.ts, el
  // paso 0 ya dejó de ser "nada lo lee todavía".
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
  ];
  for (const f of archivosDeNegocio) {
    const body = src(f);
    assert.ok(!body.includes("credit_circuits"), `${f} no debe leer credit_circuits todavía (paso 3)`);
    assert.ok(!body.includes("funding_rates"), `${f} no debe leer funding_rates todavía (paso 3)`);
  }
});

test("cableado: el pedido, la solicitud y la cotización todavía no declaran circuito", () => {
  // El paso 1 (etiqueta) y el paso 2 (selector) son los que agregan
  // circuit_code a los documentos. Hoy no debe existir en ningún lado.
  const pantallasYServidor = [
    "src/lib/erp/orders.ts",
    "src/lib/erp/requests.ts",
    "src/lib/erp/ops.ts",
    "src/lib/azagro.ts",
    "src/components/order-form.tsx",
    "src/routes/sales.$orderId.tsx",
    "src/routes/quotes.tsx",
  ];
  for (const f of pantallasYServidor) {
    assert.ok(!src(f).includes("circuit_code") && !src(f).includes("circuitCode"), `${f} no debe declarar circuito todavía (paso 1)`);
  }
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
