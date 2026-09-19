// EL AVISO AL COTIZAR EN PESOS CON COSTO EN DÓLARES (Decisión 90, 19-sep-2026).
//
// El caso del dueño: se compra a US$1,000 la pieza con el dólar en 17.50
// (costo $17,500), se cotiza con 20 % de margen a $21,875, y treinta días
// después se le paga al proveedor con el dólar en 18.50 — el costo real fue
// $18,500 y el margen real 15.4 %, no 20 %.
//
// Quién lo absorbe ya está decidido: **Azagro, nunca el cliente**. La
// exposición no nace de la venta —el cliente compró un precio en pesos— sino
// de haber decidido deberle dólares al proveedor a crédito. Lo que se fija
// aquí es que la persona que cotiza lo VEA antes de comprometer el precio, y
// que el sistema **no pronostique nada**: el costo financiero se mete solo en
// el precio porque hay tasa y hay días; dónde va a estar el dólar en un mes no
// lo sabe nadie.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { quoteFxExposure, utilityAfterFxMove } from "../src/lib/erp/fx-exposure.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

// 10 piezas a US$1,000 con el dólar en 17.50: el costo vive en pesos (17,500)
// y guarda con qué TC llegó ahí.
const CASO = [{ qty: 10, costMxn: 17500, costCurrency: "USD", costFx: 17.5 }];

// ---------------------------------------------------------------------------
// 1. Los números del caso del dueño
// ---------------------------------------------------------------------------
test("el caso del dueño: US$10,000 de costo, y cada peso del dólar mueve $10,000 de utilidad", () => {
  const e = quoteFxExposure(CASO, "MXN");
  assert.equal(e.aplica, true);
  assert.equal(e.usd, 10000, "los dólares se recuperan dividiendo: 17,500 ÷ 17.50 × 10");
  assert.equal(e.porPeso, 10000, "cada dólar que se debe cuesta un peso más por cada peso que suba");
  assert.equal(e.tc, 17.5);
  assert.equal(e.n, 1);
});

test("el caso del dueño: la utilidad esperada de 43,750 se queda en 33,750 si el dólar sube un peso", () => {
  // Precio = 17,500 ÷ (1 − 0.20) = 21,875 · utilidad 4,375 × 10 = 43,750.
  assert.equal(utilityAfterFxMove(43750, 10000, 1), 33750);
  // Margen real 33,750 / 218,750 = 15.43 %, no 20 %.
  assert.equal(Math.round((33750 / 218750) * 10000) / 100, 15.43);
});

test("si el dólar BAJA, la utilidad sube lo mismo: el signo no está invertido", () => {
  assert.equal(utilityAfterFxMove(43750, 10000, -1), 53750);
  assert.equal(utilityAfterFxMove(43750, 10000, 0), 43750, "sin movimiento, nada cambia");
});

// ---------------------------------------------------------------------------
// 2. Cuándo NO aplica
// ---------------------------------------------------------------------------
test("cotizando en dólares no se avisa nada: ahí el riesgo es del cliente (Decisión 2)", () => {
  assert.equal(quoteFxExposure(CASO, "USD").aplica, false, "el precio viaja con el tipo de cambio: el cliente lo asume");
  assert.equal(quoteFxExposure(CASO, "USD").usd, 0);
});

test("costo en pesos: no hay nada que avisar", () => {
  const e = quoteFxExposure([{ qty: 10, costMxn: 17500, costCurrency: "MXN", costFx: null }], "MXN");
  assert.equal(e.aplica, false);
  assert.equal(e.usd, 0);
});

test("un costo marcado USD sin tipo de cambio usable no se convierte a la fuerza", () => {
  // Dividir entre 1 (o entre nada) daría «10,000 dólares» que no son dólares.
  for (const fx of [null, 0, 1]) {
    const e = quoteFxExposure([{ qty: 10, costMxn: 17500, costCurrency: "USD", costFx: fx }], "MXN");
    assert.equal(e.aplica, false, `TC ${fx}: no se inventa una conversión`);
  }
});

test("una partida sin cantidad o sin costo no aporta exposición", () => {
  assert.equal(quoteFxExposure([{ qty: 0, costMxn: 17500, costCurrency: "USD", costFx: 17.5 }], "MXN").aplica, false);
  assert.equal(quoteFxExposure([{ qty: 10, costMxn: 0, costCurrency: "USD", costFx: 17.5 }], "MXN").aplica, false);
});

// ---------------------------------------------------------------------------
// 3. Varias partidas
// ---------------------------------------------------------------------------
test("varias partidas: los dólares se suman, y si vienen con TC distintos no se enseña uno solo", () => {
  const mezcla = quoteFxExposure(
    [
      { qty: 10, costMxn: 17500, costCurrency: "USD", costFx: 17.5 },
      { qty: 5, costMxn: 3700, costCurrency: "USD", costFx: 18.5 },
      { qty: 3, costMxn: 900, costCurrency: "MXN", costFx: null },
    ],
    "MXN",
  );
  assert.equal(mezcla.usd, 11000, "10,000 + 1,000; la partida en pesos no expone nada");
  assert.equal(mezcla.tc, null, "dos tipos de cambio distintos: no hay «el» TC de la cotización");
  assert.equal(mezcla.n, 2);
  const mismo = quoteFxExposure(
    [
      { qty: 10, costMxn: 17500, costCurrency: "USD", costFx: 17.5 },
      { qty: 2, costMxn: 8750, costCurrency: "USD", costFx: 17.5 },
    ],
    "MXN",
  );
  assert.equal(mismo.usd, 11000);
  assert.equal(mismo.tc, 17.5, "el mismo TC en todas: sí se puede nombrar");
});

// ---------------------------------------------------------------------------
// 4. Lo que el sistema NO hace, a propósito
// ---------------------------------------------------------------------------
test("no se pronostica: ni colchón sugerido, ni «dólar esperado», ni nada que entre al precio", () => {
  const f = src("src/lib/erp/fx-exposure.ts");
  // El motor de precios no lo conoce: el precio sigue siendo
  // (costo puesto + financiamiento) ÷ (1 − margen), sin un término nuevo.
  assert.ok(!src("src/lib/erp/pricing.ts").includes("fx-exposure"), "pricing.ts ni se entera");
  assert.ok(!src("src/lib/erp/pricing.ts").includes("quoteFxExposure"), "el precio no lleva colchón automático");
  // Y el módulo no propone un número: solo divide lo que ya existe.
  assert.ok(!/colch[oó]n\s*=|sugerid[oa]\s*=|esperado\s*=/.test(f), "no calcula ningún colchón");
  assert.ok(f.includes("Aquí no se pronostica nada"), "y lo dice donde se lee");
});

test("el aviso vive en la pantalla donde se decide el precio, y dice quién lo absorbe", () => {
  const p = src("src/routes/solicitudes.$solicitudId.tsx");
  assert.ok(p.includes("const exp = quoteFxExposure("), "la pantalla de la cotización al cliente");
  assert.ok(p.includes("El costo de esta cotización es en dólares"), "lo nombra");
  assert.ok(p.includes("Lo absorbe Azagro: el cliente compró un precio en pesos"), "y dice de quién es (Decisión 90)");
  assert.ok(p.includes("súbele el margen o el tipo de cambio arriba"), "el colchón lo pone la persona, a mano");
  assert.ok(p.includes("nadie sabe dónde va a estar el dólar"), "y explica por qué el sistema no lo hace solo");
  // Nunca sale de la empresa: es una cuenta interna, no va en el papel.
  assert.ok(!src("src/lib/erp/doc-text.ts").includes("quoteFxExposure"), "el papel al cliente no lo menciona (regla 7)");
});
