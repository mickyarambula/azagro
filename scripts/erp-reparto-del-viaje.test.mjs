// CÓMO SE REPARTE EL COSTO DE UN VIAJE (Decisiones 100 y 101, pieza 2).
//
// El criterio del dueño, 21-sep-2026: se reparte según lo que causó el costo,
// y lo que consume un camión de insumos agrícolas es el PESO. Nunca por
// importe: sesga el costo de la urea hacia abajo y el del producto caro hacia
// arriba, que es justo al revés de lo que hay que saber para decidir.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isStop, splitBasis, splitTripCost, tripShare } from "../src/lib/erp/trip-split.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

const ton = (lineId, qty) => ({ lineId, qty, uom: "TON", unitWeight: 1000 });

// ---------------------------------------------------------------------------
// 1. El caso del dueño, con sus números
// ---------------------------------------------------------------------------
test("20 ton de urea y 1 de foliar, $21,000 de flete: $1,000 por tonelada a cada uno", () => {
  const r = splitTripCost({ total: 21000, lines: [ton(1, 20), ton(2, 1)] });
  assert.ok(!isStop(r));
  assert.equal(r.basis, "cantidad", "misma unidad: repartir por cantidad ES repartir por peso");
  assert.deepEqual(r.perLine, [
    { lineId: 1, unit: 1000, amount: 20000 },
    { lineId: 2, unit: 1000, amount: 1000 },
  ]);
  assert.equal(r.residual, 0);
});

test("por IMPORTE habría dado otra cosa, y por eso no se hace así", () => {
  // Urea 20 ton a $8,000 = $160,000; foliar 1 ton a $60,000. Por importe:
  // urea 160/220 × 21,000 = $15,272.73 ($763.64/ton) y foliar $5,727.27/ton.
  const porImporte = { urea: Math.round((160000 / 220000) * 21000 * 100) / 100, foliar: Math.round((60000 / 220000) * 21000 * 100) / 100 };
  assert.equal(porImporte.urea, 15272.73);
  assert.equal(porImporte.foliar, 5727.27);
  // El foliar pagaría 5.7 veces el flete que causó.
  assert.equal(Math.round((5727.27 / 1000) * 10) / 10, 5.7);
  // Y el sistema NO hace eso.
  const r = splitTripCost({ total: 21000, lines: [ton(1, 20), ton(2, 1)] });
  assert.notEqual(r.perLine[0].amount, 15272.73);
  assert.equal(r.perLine[0].amount, 20000);
});

// ---------------------------------------------------------------------------
// 2. Si se puede saber a quién le toca, no se reparte
// ---------------------------------------------------------------------------
test("una sola partida se lleva el viaje completo: no hay nada que prorratear", () => {
  const r = splitTripCost({ total: 2000, lines: [{ lineId: 7, qty: 100, uom: "SAC", unitWeight: null }] });
  assert.ok(!isStop(r));
  assert.equal(r.basis, "unica");
  assert.deepEqual(r.perLine, [{ lineId: 7, unit: 20, amount: 2000 }]);
  assert.equal(r.residual, 0, "y no hace falta peso para eso");
});

// ---------------------------------------------------------------------------
// 3. El camino de siempre: sin costo de viaje, nada cambia
// ---------------------------------------------------------------------------
test("sin costo de viaje el reparto es cero en todas las partidas: el camino de siempre", () => {
  for (const total of [0, -5]) {
    const r = splitTripCost({ total, lines: [ton(1, 10), ton(2, 10)] });
    assert.ok(!isStop(r));
    assert.equal(r.basis, "sin-costo");
    assert.deepEqual(r.perLine, [
      { lineId: 1, unit: 0, amount: 0 },
      { lineId: 2, unit: 0, amount: 0 },
    ]);
  }
});

// ---------------------------------------------------------------------------
// 4. Unidades mezcladas: por peso, o se detiene
// ---------------------------------------------------------------------------
test("toneladas y litros se reparten por PESO, no sumando 10 + 200", () => {
  // 100 sacos de 50 kg (5,000 kg) y 100 botellas de 1 kg (100 kg). $2,000.
  const r = splitTripCost({
    total: 2000,
    lines: [
      { lineId: 1, qty: 100, uom: "SAC", unitWeight: 50 },
      { lineId: 2, qty: 100, uom: "LT", unitWeight: 1 },
    ],
  });
  assert.ok(!isStop(r));
  assert.equal(r.basis, "peso");
  // 5,000 / 5,100 = 98.04 % → $1,960.78 y $39.22.
  assert.equal(r.perLine[0].amount, 1960.78);
  assert.equal(r.perLine[1].amount, 39.22);
  assert.equal(r.perLine[0].unit, 19.6078);
  assert.equal(r.perLine[1].unit, 0.3922);
  // Por cantidad habrían sido $10 y $10 — la botella cargando lo mismo que el
  // saco que pesa cincuenta veces más.
  assert.notEqual(r.perLine[1].amount, 1000);
});

test("falta el peso de un producto: se DETIENE y lo pide, no cae a cantidad", () => {
  // Caer a cantidad repartiría sumando toneladas con litros: un número
  // inventado, que es justo lo que la regla 9 prohíbe.
  const r = splitTripCost({
    total: 2000,
    lines: [
      { lineId: 1, qty: 10, uom: "TON", unitWeight: 1000 },
      { lineId: 2, qty: 200, uom: "LT", unitWeight: null },
    ],
  });
  assert.ok(isStop(r));
  assert.match(r.stop, /unidades distintas/);
  assert.match(r.stop, /Captura cuánto pesa una unidad/, "dice qué hacer");
  assert.match(r.stop, /o reparte el flete a mano/, "y nombra la salida que siempre existe");
});

test("un peso en cero o negativo cuenta como SIN capturar", () => {
  for (const w of [0, -1]) {
    const r = splitTripCost({
      total: 2000,
      lines: [{ lineId: 1, qty: 10, uom: "TON", unitWeight: 1000 }, { lineId: 2, qty: 5, uom: "LT", unitWeight: w }],
    });
    assert.ok(isStop(r), `peso ${w} no puede pasar como capturado`);
  }
});

test("una unidad VACÍA no es «la misma unidad»: son dos huecos", () => {
  // `purchase_lines.uom` es text not null default '', así que dos partidas sin
  // unidad se verían iguales. Repartirlas por cantidad sería adivinar.
  const r = splitTripCost({
    total: 2000,
    lines: [{ lineId: 1, qty: 10, uom: "", unitWeight: null }, { lineId: 2, qty: 5, uom: "", unitWeight: null }],
  });
  assert.ok(isStop(r), "se detiene en vez de repartir por cantidad");
});

// ---------------------------------------------------------------------------
// 5. El reparto CIERRA: no se pierde ni se inventa un centavo
// ---------------------------------------------------------------------------
test("lo repartido más el residuo es exactamente lo que costó el viaje", () => {
  const casos = [
    { total: 2000, lines: [ton(1, 1), ton(2, 1), ton(3, 1)] }, // 666.666…
    { total: 1000, lines: [ton(1, 3), ton(2, 7)] },
    { total: 21000, lines: [ton(1, 20), ton(2, 1)] },
    { total: 0.03, lines: [ton(1, 1), ton(2, 1), ton(3, 1)] },
    { total: 12345.67, lines: [ton(1, 7), ton(2, 11), ton(3, 13)] },
    { total: 999.99, lines: [{ lineId: 1, qty: 100, uom: "SAC", unitWeight: 50 }, { lineId: 2, qty: 3, uom: "LT", unitWeight: 1 }] },
  ];
  for (const c of casos) {
    const r = splitTripCost(c);
    assert.ok(!isStop(r), JSON.stringify(c));
    const suma = Math.round(r.perLine.reduce((s, p) => s + p.amount, 0) * 100) / 100;
    assert.equal(Math.round((suma + r.residual) * 100) / 100, Math.round(c.total * 100) / 100, `no cierra: ${JSON.stringify(c)}`);
    assert.ok(Math.abs(r.residual) < 0.01, `el residuo tiene que ser centavos, no pesos: ${r.residual}`);
  }
});

test("$2,000 entre tres partes iguales: el centavo que sobra se carga y se dice dónde", () => {
  const r = splitTripCost({ total: 2000, lines: [ton(1, 1), ton(2, 1), ton(3, 1)] });
  assert.ok(!isStop(r));
  const suma = Math.round(r.perLine.reduce((s, p) => s + p.amount, 0) * 100) / 100;
  assert.equal(suma, 2000, "no se pierde un centavo");
  assert.equal(r.residual, 0);
});

// ---------------------------------------------------------------------------
// 6. Lo que el módulo NO hace
// ---------------------------------------------------------------------------
test("no reparte por importe: la palabra no aparece como base posible", () => {
  const f = src("src/lib/erp/trip-split.ts");
  assert.ok(!/basis = "importe"|basis: "importe"/.test(f), "no existe esa base");
  assert.ok(f.includes("**Nunca por importe.**"), "y queda escrito por qué");
  assert.ok(f.includes("cotizar por debajo de lo que se puede"), "con la consecuencia de negocio, no solo la teoría");
});

test("es puro: sin imports, para que esta prueba lo cargue directo", () => {
  const f = src("src/lib/erp/trip-split.ts");
  assert.ok(!/^import /m.test(f), "ningún import");
});

// ---------------------------------------------------------------------------
// 7. EL REPARTO ENTRE CAMIONES: la misma regla, o se rompe (revisión 21-sep)
// ---------------------------------------------------------------------------
// La primera versión repartía POR PESO dentro del camión y por CANTIDAD CRUDA
// entre camiones. La regla escrita dos veces, y la segunda copia mal.

const UREA = { lineId: 1, qty: 10, uom: "TON", unitWeight: 1000 };   // 10,000 kg
const FOLIAR = { lineId: 2, qty: 1000, uom: "LT", unitWeight: 1 };   //  1,000 kg

test("el camión de urea NO carga el flete del foliar: 10 TON contra 1,000 L", () => {
  // Éstos son los números exactos que encontró la revisión de dinero.
  const sh = tripShare({ order: [UREA, FOLIAR], now: [UREA] });
  assert.ok(!isStop(sh));
  assert.equal(sh.basis, "peso", "unidades mezcladas: se mide por peso");
  // 10,000 de 11,000 kg.
  assert.equal(Math.round(sh.frac * 10000) / 10000, 0.9091);
  const leToca = Math.round(21000 * sh.frac * 100) / 100;
  assert.equal(leToca, 19090.91, "de $21,000, a la urea le tocan $19,090.91");
  // Lo que daba la versión mala: 10 de 1,010 «unidades» = 0.99 %.
  const porCantidadCruda = Math.round(21000 * (10 / 1010) * 100) / 100;
  assert.equal(porCantidadCruda, 207.92, "el número equivocado de la primera versión");
  assert.equal(Math.round((leToca - porCantidadCruda) * 100) / 100, 18883.0 - 0.01, "casi $18,883 mal asignados");
});

test("y el camión del foliar carga lo suyo, no el resto", () => {
  const sh = tripShare({ order: [UREA, FOLIAR], now: [FOLIAR] });
  assert.ok(!isStop(sh));
  assert.equal(Math.round(21000 * sh.frac * 100) / 100, 1909.09);
});

test("las dos partes suman el viaje completo", () => {
  const a = tripShare({ order: [UREA, FOLIAR], now: [UREA] });
  const b = tripShare({ order: [UREA, FOLIAR], now: [FOLIAR] });
  assert.ok(!isStop(a) && !isStop(b));
  assert.equal(Math.round((a.frac + b.frac) * 10000) / 10000, 1);
});

test("con todo el camión en la misma unidad, la fracción es por cantidad — que ES por peso", () => {
  const sh = tripShare({
    order: [{ lineId: 1, qty: 30, uom: "TON", unitWeight: null }, { lineId: 2, qty: 70, uom: "TON", unitWeight: null }],
    now: [{ lineId: 1, qty: 30, uom: "TON", unitWeight: null }],
  });
  assert.ok(!isStop(sh));
  assert.equal(sh.basis, "cantidad");
  assert.equal(Math.round(sh.frac * 10000) / 10000, 0.3, "y no hace falta capturar ningún peso");
});

test("unidades mezcladas SIN peso: se detiene, igual que el reparto dentro del camión", () => {
  const sh = tripShare({
    order: [{ lineId: 1, qty: 10, uom: "TON", unitWeight: 1000 }, { lineId: 2, qty: 200, uom: "LT", unitWeight: null }],
    now: [{ lineId: 1, qty: 10, uom: "TON", unitWeight: 1000 }],
  });
  assert.ok(isStop(sh), "no inventa una fracción");
  assert.match(sh.stop, /unidades distintas/);
});

test("LA REGLA VIVE EN UN SOLO LUGAR: los dos repartos llaman a la misma base", () => {
  // Fue exactamente el error: la misma decisión escrita dos veces, y la
  // segunda copia repartía sumando toneladas con litros.
  const f = src("src/lib/erp/trip-split.ts");
  assert.equal((f.match(/export function splitBasis\(/g) || []).length, 1, "una sola base");
  assert.equal((f.match(/const b = splitBasis\(lines\);/g) || []).length, 1, "el reparto dentro del camión la usa");
  assert.ok(f.includes("const bOrder = splitBasis(vivas);"), "y el reparto entre camiones también");
  // Y no quedó una segunda copia del criterio suelta.
  assert.equal((f.match(/l\.qty \* Number\(l\.unitWeight\)/g) || []).length, 1, "el peso se calcula en un solo sitio");
  // El que reparte entre camiones NO suma cantidades crudas cuando hay pesos.
  const a = src("src/lib/azagro.ts");
  assert.ok(!/select coalesce\(sum\(qty\),0\)::text as total/.test(a), "la suma cruda de la primera versión se fue");
  assert.ok(a.includes("const share = tripShare({"), "y azagro.ts llama a la regla");
});

test("splitBasis: la misma entrada da la misma base, la pida quien la pida", () => {
  for (const ls of [[UREA, FOLIAR], [UREA], [{ lineId: 9, qty: 5, uom: "SAC", unitWeight: 50 }, { lineId: 8, qty: 5, uom: "SAC", unitWeight: 50 }]]) {
    const b = splitBasis(ls);
    assert.ok(!isStop(b));
    assert.equal(b.base.length, ls.length);
    assert.ok(b.base.every((x) => x >= 0));
  }
});
