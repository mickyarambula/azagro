// LA TASA DE UN DOCUMENTO — N1, Decisión 5, construido el 19-sep-2026.
//
// El hueco que cierra: la tabla de dos columnas (tasa de costo / tasa de
// cobro, `funding_rates`, migración 0024) se construyó y el motor de PRECIOS
// del circuito lineal ya la leía. La MORA no: seguía leyendo `tiie_rates`
// para todos los circuitos. Y las dos tablas se capturan por separado en
// Ajustes, sin nada que las amarre, así que el precio y la mora del MISMO
// documento podían correr con dos tasas distintas sin que nadie se enterara.
//
// La regla: un documento se mide con la tabla de la que salió su precio.
//   · ASR    → `tiie_rates` (ahí solo hay una tasa, y es la del precio).
//   · lineal → `funding_rates`: lo que se le COBRA al cliente a tasa de
//     cobro; lo que mide COSTO, a tasa de costo. Decisión 5, sin excepción.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { docRate, rateTableName, usesFundingTable } from "../src/lib/erp/doc-rate.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

// Los números del ejemplo de la Decisión 5 (ESTADO.md N1): tasa de cobro
// 7.05 %, spread de mora 9 %. Y una TIIE capturada aparte en 7.60 %, que es
// justo lo que pasa cuando nadie amarra las dos tablas.
const TIIE = { rate: 0.076, date: "2026-08-01" };
const TASAS = { costRate: 0.0675, collectionRate: 0.0705, date: "2026-08-01" };
const SPREAD_MORA = 0.09;
const CAPITAL = 111876.11;
const mora = (rate, dias) => Math.round(((CAPITAL * (rate + SPREAD_MORA) * dias) / 360) * 100) / 100;

// ---------------------------------------------------------------------------
// 1. El número de la Decisión 5
// ---------------------------------------------------------------------------
test("lineal: la mora sale a tasa de COBRO — $1,496.34 a 30 días, el número de la Decisión 5", () => {
  const p = docRate({ base: "costo_margen", which: "cobro", tiie: TIIE, funding: TASAS });
  assert.equal(p.rate, 0.0705, "la columna de cobro, no la TIIE");
  assert.equal(p.source, "tasas");
  assert.equal(mora(p.rate, 30), 1496.34, "111,876.11 × (7.05 % + 9 %) × 30 / 360");
});

test("y con la tabla equivocada salían $1,547.62: $51.28 de más en UNA factura en UN mes", () => {
  // Lo que hacía el sistema hasta hoy: la TIIE, para todos los circuitos.
  assert.equal(mora(TIIE.rate, 30), 1547.62);
  assert.equal(Math.round((1547.62 - 1496.34) * 100) / 100, 51.28, "el cliente lineal pagaba de más");
  // Y el signo se invierte solo: si la TIIE capturada queda POR DEBAJO de la
  // tasa de cobro, Azagro cobra de menos. No es «un error conservador».
  const tiieBaja = { rate: 0.065, date: "2026-08-01" };
  assert.ok(mora(tiieBaja.rate, 30) < 1496.34, "con la TIIE baja se cobraba de menos");
});

// ---------------------------------------------------------------------------
// 2. Las dos preguntas del lineal son columnas distintas
// ---------------------------------------------------------------------------
test("lineal: cobro y costo son dos columnas, y la protección es la diferencia", () => {
  const cobro = docRate({ base: "costo_margen", which: "cobro", tiie: TIIE, funding: TASAS });
  const costo = docRate({ base: "costo_margen", which: "costo", tiie: TIIE, funding: TASAS });
  assert.equal(cobro.rate, 0.0705);
  assert.equal(costo.rate, 0.0675);
  assert.equal(Math.round((cobro.rate - costo.rate) * 10000) / 10000, 0.003, "la protección: 30 puntos base");
  // El pronto pago se bonifica a tasa de COSTO: con la de cobro se regalaría
  // la protección, que es justo lo que la línea se queda.
  assert.ok(costo.rate < cobro.rate, "bonificar a la de cobro sería regalar de más");
});

// ---------------------------------------------------------------------------
// 3. ASR: una sola tasa, y es la del precio
// ---------------------------------------------------------------------------
test("doble facturación (ASR): las dos preguntas dan la TIIE — ese circuito nunca tuvo dos tasas", () => {
  for (const which of ["cobro", "costo"]) {
    const p = docRate({ base: "costo_comision", which, tiie: TIIE, funding: TASAS });
    assert.equal(p.rate, 0.076, `${which}: la TIIE`);
    assert.equal(p.source, "tiie");
  }
  assert.equal(mora(0.076, 30), 1547.62, "y su mora no cambia: es la que siempre fue");
});

test("un documento sin circuito capturado se mide como ASR, no se queda sin tasa", () => {
  for (const base of [null, undefined, ""]) {
    assert.equal(docRate({ base, which: "cobro", tiie: TIIE, funding: TASAS }).source, "tiie");
  }
  assert.equal(usesFundingTable("costo_margen"), true);
  assert.equal(usesFundingTable("costo_comision"), false);
});

// ---------------------------------------------------------------------------
// 4. Sin renglón NO hay respaldo (regla 9)
// ---------------------------------------------------------------------------
test("si falta la tabla que le toca, la respuesta es null — nunca se cae a la otra", () => {
  // Lineal sin tasas capturadas: null, aunque la TIIE esté ahí. Caer a la
  // TIIE sería cobrarle al cliente con un número que no es el suyo.
  assert.equal(docRate({ base: "costo_margen", which: "cobro", tiie: TIIE, funding: null }), null);
  // Y al revés: ASR sin TIIE es null aunque haya tabla de tasas.
  assert.equal(docRate({ base: "costo_comision", which: "cobro", tiie: null, funding: TASAS }), null);
});

test("el aviso manda a la tabla correcta: decirle «captura la TIIE» a quien opera en lineal lo manda a llenar la que su documento no lee", () => {
  assert.equal(rateTableName("costo_margen"), "Tabla de tasas (costo / cobro)");
  assert.equal(rateTableName("costo_comision"), "Tabla TIIE");
  assert.equal(rateTableName(null), "Tabla TIIE");
});

// ---------------------------------------------------------------------------
// 5. Cableado: los cinco lugares que preguntan por la tasa de un documento
// ---------------------------------------------------------------------------
test("los cinco lectores preguntan por circuito, y ninguno se quedó con la TIIE a secas", () => {
  const ops = src("src/lib/erp/ops.ts");
  const rep = src("src/lib/erp/reports.ts");
  const pant = src("src/routes/credit.tsx");

  // 1. Estado de cuenta (la mora en vivo de cada factura abierta).
  assert.ok(ops.includes('const tiiePick = pickDocRate(books, inv.circuit_code, moraDue, "cobro");'), "estado de cuenta: tasa de cobro del circuito");
  // 2. La FI que de verdad se emite.
  const mora = ops.slice(ops.indexOf("export async function issueMoraInvoice"));
  assert.ok(mora.includes('pickDocRate(books, inv[0].circuit_code, moraDue, "cobro")'), "FI: tasa de cobro del circuito");
  assert.ok(mora.includes("if (!pick) throw new Error(missingDocRateMessage("), "FI: sin renglón en la tabla que le toca, no se emite");
  // 3. Pronto pago — la única que va a tasa de COSTO.
  assert.ok(ops.includes('pickDocRate(books, i.circuit_code, i.date, "costo")'), "pronto pago: tasa de costo del circuito");
  // 4. «Lo que viene» del inicio.
  assert.ok(rep.includes("base: baseOf.get(inv.circuit_code ?? \"\") ?? null"), "lo que viene: por circuito de la factura");
  // 5. La vista previa de la pantalla de cobro, que tiene que enseñar la
  //    MISMA tasa que va a cobrar el servidor.
  assert.ok(pant.includes("const baseDoc = settings.circuits.find((c) => c.code === inv.circuit_code)?.financingBase ?? null;"), "pantalla: el circuito del documento");
  assert.ok(pant.includes('which: "cobro",'), "pantalla: tasa de cobro");
});

test("la regla vive en UN lugar: nadie más decide de qué tabla sale la tasa de un documento", () => {
  const dr = src("src/lib/erp/doc-rate.ts");
  // Una sola comparación contra la base del circuito, en una sola función.
  assert.equal((dr.match(/=== "costo_margen"/g) ?? []).length, 1, "la comparación vive una sola vez");
  // Y no hay respaldo escondido: ningún `?? ` que sustituya una tabla por otra.
  assert.ok(!/funding\s*\?\?\s*input\.tiie|tiie\s*\?\?\s*input\.funding/.test(dr), "sin respaldo entre tablas");
  // El módulo es puro: la prueba lo carga directo, con números.
  assert.ok(!/^import /m.test(dr), "doc-rate.ts no importa nada");
});

// ---------------------------------------------------------------------------
// 6. Lo que encontró el revisor de dinero: los dos estimadores de pronto pago
//    que se habían quedado leyendo la TIIE. Una mitad construida es peor que
//    ninguna — es justo el defecto que este bloque vino a cerrar.
// ---------------------------------------------------------------------------
test("la estimación de pronto pago usa la MISMA tasa que el cobro va a perdonar, en los tres lugares", () => {
  const ops = src("src/lib/erp/ops.ts");
  const rep = src("src/lib/erp/reports.ts");
  // 1. El cobro real (el que perdona dinero de verdad).
  assert.ok(ops.includes('pickDocRate(books, i.circuit_code, i.date, "costo")'), "el cobro bonifica a tasa de costo del circuito");
  // 2. La columna "Pronto pago (est.)" del estado de cuenta. Si leyera otra
  //    tabla, la pantalla estimaría una bonificación y el sistema perdonaría
  //    otra: sobre $111,876.11 con 30 días sin consumir, $1,081.47 contra
  //    $1,002.22 — $79.25 de diferencia entre lo que se enseña y lo que se da.
  assert.ok(ops.includes('pickDocRate(books, inv.circuit_code, inv.date, "costo")'), "el estado de cuenta estima con la misma tasa que se aplica");
  // 3. La tarjeta de utilidad del pedido: la de COSTO congelada, nunca la de
  //    cobro (que lleva la protección adentro y estimaría de más).
  assert.ok(rep.includes("const bonoRate = usesFundingTable(financingBase) ? costRate : tiieIssue;"), "el P&L estima con la tasa de costo del documento");
  assert.ok(rep.includes("tiieAtIssue: bonoRate,"), "y es esa la que entra a earlyPayBonus");
});

test("los avisos de «falta tasa» mandan a la tabla que ese documento sí lee", () => {
  const ops = src("src/lib/erp/ops.ts");
  // Los dos del estado de cuenta: mora y pronto pago.
  assert.ok(ops.includes("missingDocRateMessage(books, inv.circuit_code, moraDue,"), "aviso de mora: tabla del circuito");
  assert.ok(ops.includes("missingDocRateMessage(books, inv.circuit_code, inv.date,"), "aviso de pronto pago: tabla del circuito");
  // Y el texto que explicaba la mora ya no miente.
  assert.ok(!ops.includes("este interés de mora sigue leyendo la TIIE"), "el texto viejo decía que la mora lee la TIIE: ya no es cierto");
  assert.ok(ops.includes("de qué tabla sale la tasa"), "ahora dice que el circuito decide la tabla");
});

test("la fórmula guardada en la FI nombra la tabla de la que salió el número", () => {
  const credit = src("src/lib/erp/credit.ts");
  assert.ok(credit.includes('pick.source === "tasas" ? (which === "costo" ? "Tasa de costo" : "Tasa de cobro") : "TIIE"'), "rateLabel nombra la tabla");
  assert.ok(src("src/lib/erp/ops.ts").includes('rateLabel(pick, "cobro")'), "la FI pide la etiqueta de cobro");
});

test("no se consulta la tabla de tasas cuando el documento no la va a usar (el Panorama llama 500 veces)", () => {
  const rep = src("src/lib/erp/reports.ts");
  assert.ok(rep.includes("funding: usesFundingTable(baseOfDoc) ? nearestFunding(await fundingTableOf(sql, companyId), issueDate) : null,"), "la consulta va detrás de la pregunta");
});
