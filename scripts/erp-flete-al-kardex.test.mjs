// EL FLETE ENTRA AL COSTO DEL INVENTARIO — MOTOR CONGELADO AL CENTAVO
// (Decisiones 100 y 101, pieza 2, 21-sep-2026).
//
// Esta pieza cambia CÓMO se calcula el costo con el que la mercancía entra al
// kardex, y de ese costo cuelga todo: el precio, el financiamiento que se le
// cobra al cliente y la utilidad del pedido. Las pruebas de la pieza 1
// congelaban por TEXTO —que alcanzaba para probar que nada se movía—; ésta
// congela por NÚMERO, que es lo único que prueba una fórmula.
//
// La propiedad que fija, y es la que hace segura la pieza:
//   **una recepción SIN costo de viaje capturado tiene que dar byte a byte lo
//   mismo que daba antes**, en el costo del kardex, en el precio y en la
//   utilidad. Todo lo que ya operaba no puede cambiar de número.
//
// Y la segunda, que es el corazón del bloque:
//   **con costo de viaje, el flete entra EXACTAMENTE UNA VEZ**. Ni cero (se
//   perdería) ni dos (se le cobraría de más al cliente).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isStop, splitTripCost } from "../src/lib/erp/trip-split.ts";
import { freightInsideCost } from "../src/lib/erp/cost.ts";
import { maskAmounts } from "../src/lib/erp/audit-mask.ts";

// `stock.ts` y `pricing.ts` no se pueden cargar aquí (importan con `@/`), así
// que sus fórmulas se copian —el patrón que ya usa `erp-formulas.test.mjs`—.
// Eso es exactamente lo que se quiere de un motor congelado: la referencia
// vive en la prueba y no se mueve cuando alguien toca el código.

/** Copia de src/lib/erp/stock.ts movingAverage — si cambia el motor, este test falla. */
function movingAverage(oldQty, oldAvg, qtyIn, unitCost) {
  const on = Math.max(0, oldQty);
  const inn = Math.max(0, qtyIn);
  const next = on + inn;
  if (next <= 0.0000001) return Math.max(0, unitCost);
  return (on * Math.max(0, oldAvg) + inn * Math.max(0, unitCost)) / next;
}

/**
 * Copia del precio de CONTADO de src/lib/erp/pricing.ts: costo puesto entre
 * (1 − margen). A plazo entra el financiamiento, que esta pieza no toca.
 */
function precioContado(i) {
  const landedUnit = Math.max(0, i.cost) + Math.max(0, i.freight) + Math.max(0, i.other ?? 0);
  return { landedUnit, unitPrice: landedUnit / (1 - i.marginPct / 100) };
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");
const r4 = (n) => Math.round(n * 10000) / 10000;

// ---------------------------------------------------------------------------
// A. EL MOTOR DE ANTES, congelado tal cual (commit bae5c21, pieza 1). Es la
//    referencia: no se toca nunca. Así entraba la mercancía al kardex.
// ---------------------------------------------------------------------------
function costoDeEntrada_ANTES(i) {
  // receiptUnitCostMxn: pesos si la OC es en pesos; USD × TC si no.
  return i.currency === "USD" ? r4(i.unitPrice * i.fx) : r4(i.unitPrice);
}

function promedio_ANTES(i) {
  return movingAverage(i.qtyBefore, i.avgBefore, i.qtyIn, costoDeEntrada_ANTES(i));
}

// ---------------------------------------------------------------------------
// B. El motor de AHORA: el mismo, más el flete repartido del viaje.
// ---------------------------------------------------------------------------
function costoDeEntrada_AHORA(i, fleteUnit) {
  return r4(costoDeEntrada_ANTES(i) + (fleteUnit ?? 0));
}

// ---------------------------------------------------------------------------
// C. La malla
// ---------------------------------------------------------------------------
const MALLA = [];
for (const unitPrice of [0.5, 500, 8000, 14420, 98765.43]) {
  for (const [currency, fx] of [["MXN", 1], ["USD", 18], ["USD", 20.5]]) {
    for (const qtyIn of [1, 3, 100, 12.5]) {
      for (const qtyBefore of [0, 50, 1000]) {
        for (const avgBefore of [0, 400, 9000]) {
          for (const trip of [0, 2000, 21000, 12345.67]) {
            MALLA.push({ unitPrice, currency, fx, qtyIn, qtyBefore, avgBefore, trip });
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 1. SIN COSTO DE VIAJE: byte a byte lo de antes
// ---------------------------------------------------------------------------
test("sin costo de viaje, el costo de entrada y el promedio son EXACTAMENTE los de antes", () => {
  const sinViaje = MALLA.filter((c) => c.trip === 0);
  assert.ok(sinViaje.length > 150, `${sinViaje.length} casos sin viaje`);
  for (const c of sinViaje) {
    const split = splitTripCost({ total: 0, lines: [{ lineId: 1, qty: c.qtyIn, uom: "TON", unitWeight: 1000 }] });
    assert.ok(!isStop(split));
    const fleteUnit = split.perLine[0].unit;
    assert.equal(fleteUnit, 0, "sin viaje no hay flete que repartir");
    assert.equal(costoDeEntrada_AHORA(c, fleteUnit), costoDeEntrada_ANTES(c), `costo en ${JSON.stringify(c)}`);
    assert.equal(
      movingAverage(c.qtyBefore, c.avgBefore, c.qtyIn, costoDeEntrada_AHORA(c, fleteUnit)),
      promedio_ANTES(c),
      `promedio en ${JSON.stringify(c)}`,
    );
  }
});

test("sin flete dentro del costo, el apagador no apaga nada", () => {
  // `cost_freight_in = 0` es el caso de todo lo histórico, todo brokeraje y
  // todo costo capturado a mano. El flete cotizado sigue sumando una vez.
  for (const cost of [0, 1000, 14420, 137500]) {
    for (const freight of [0, 300, 3000]) {
      assert.equal(precioContado({ cost, freight, marginPct: 15 }).landedUnit, cost + freight, "el costo puesto no cambió de fórmula");
    }
    assert.equal(freightInsideCost({ cost, source: "referencia", avgFreight: 999, captured: false }), 0, "el costo de referencia nunca trae flete");
    assert.equal(freightInsideCost({ cost, source: "kardex", avgFreight: 999, captured: true }), 0, "un costo tecleado tampoco");
    assert.equal(freightInsideCost({ cost, source: "ninguno", avgFreight: 999, captured: false }), 0, "sin costo tampoco");
  }
});

// ---------------------------------------------------------------------------
// 2. CON COSTO DE VIAJE: exactamente una vez
// ---------------------------------------------------------------------------
test("el flete entra EXACTAMENTE UNA VEZ: ni se pierde ni se dobla, en toda la malla", () => {
  const conViaje = MALLA.filter((c) => c.trip > 0);
  assert.ok(conViaje.length > 500, `${conViaje.length} casos con viaje`);
  for (const c of conViaje) {
    const split = splitTripCost({ total: c.trip, lines: [{ lineId: 1, qty: c.qtyIn, uom: "TON", unitWeight: 1000 }] });
    assert.ok(!isStop(split));
    const fleteUnit = split.perLine[0].unit;
    const antes = costoDeEntrada_ANTES(c);
    const ahora = costoDeEntrada_AHORA(c, fleteUnit);
    const delta = r4(ahora - antes);
    assert.notEqual(delta, 0, `el flete se perdió en ${JSON.stringify(c)}`);
    assert.equal(delta, r4(fleteUnit), `el flete no entró una vez exacta en ${JSON.stringify(c)}`);
    assert.notEqual(delta, r4(fleteUnit * 2), "y no entró dos veces");
    // Una sola partida: el viaje completo, repartido entre lo que llegó. El
    // unitario se guarda a CUATRO decimales (`stock_moves.unit_cost` es
    // numeric(14,4)), así que $2,000 entre 3 toneladas da $666.6667 y × 3 son
    // $2,000.0001. La diferencia es una centésima de centavo y es inevitable:
    // lo que NO se admite es perder o doblar un centavo.
    const capitalizado = fleteUnit * c.qtyIn;
    assert.ok(Math.abs(capitalizado - c.trip) < 0.01, `el viaje no cuadra al centavo en ${JSON.stringify(c)}: ${capitalizado} vs ${c.trip}`);
    // Y el importe repartido sí es exacto: de ahí sale el unitario, no al revés.
    assert.equal(split.perLine[0].amount, r4(c.trip), "el importe del reparto cuadra exacto");
  }
});

test("el flete se suma DESPUÉS de convertir a pesos: una OC en dólares no lo multiplica por el TC", () => {
  // $2,000 de flete sobre 100 unidades = $20 por unidad. Con la OC en dólares
  // a TC 18 y precio US$500: costo $9,000 + $20 = $9,020. Si el flete entrara
  // antes de convertir, saldría (500 + 20) × 18 = $9,360 — $340 de más por
  // unidad, $34,000 en el camión.
  const c = { unitPrice: 500, currency: "USD", fx: 18, qtyIn: 100 };
  const split = splitTripCost({ total: 2000, lines: [{ lineId: 1, qty: 100, uom: "TON", unitWeight: 1000 }] });
  assert.ok(!isStop(split));
  assert.equal(split.perLine[0].unit, 20);
  assert.equal(costoDeEntrada_AHORA(c, 20), 9020);
  assert.notEqual(costoDeEntrada_AHORA(c, 20), 9360, "el error que el orden de las operaciones evita");
  assert.equal(9360 - 9020, 340);
});

// ---------------------------------------------------------------------------
// 3. EL CAMIÓN DEL DUEÑO, de punta a punta
// ---------------------------------------------------------------------------
test("100 sacos a $500 con $2,000 de viaje: costo puesto $520, y el precio sube $23.53 SOLO una vez", () => {
  const split = splitTripCost({ total: 2000, lines: [{ lineId: 1, qty: 100, uom: "SAC", unitWeight: 50 }] });
  assert.ok(!isStop(split));
  assert.equal(split.perLine[0].unit, 20);

  const costoPuesto = costoDeEntrada_AHORA({ unitPrice: 500, currency: "MXN", fx: 1 }, 20);
  assert.equal(costoPuesto, 520);

  // El precio se arma con el costo puesto y SIN volver a sumar el flete: el
  // apagador dice que esos $20 ya están adentro.
  const bien = precioContado({ cost: 520, freight: 0, marginPct: 15 });
  assert.equal(bien.landedUnit, 520);
  assert.equal(Math.round(bien.unitPrice * 100) / 100, 611.76);

  // Lo que habría pasado sin apagador: $520 + $20 otra vez.
  const doble = precioContado({ cost: 520, freight: 20, marginPct: 15 });
  assert.equal(doble.landedUnit, 540);
  assert.equal(Math.round(doble.unitPrice * 100) / 100, 635.29);
  assert.equal(Math.round((635.29 - 611.76) * 100) / 100, 23.53, "los $23.53 por saco que se evitan");
  assert.equal(Math.round(23.53 * 100 * 100) / 100, 2353, "≈$2,353 en ese camión");
});

// ---------------------------------------------------------------------------
// 4. El promedio móvil mezcla los dos regímenes, y se puede explicar
// ---------------------------------------------------------------------------
test("el promedio del flete se mueve con el MISMO promedio móvil que el costo", () => {
  // Camión 1: 100 a $500 + $20 de flete = $520. Camión 2: 100 a $600 sin
  // flete. Promedio del costo $560; del flete, $10.
  const avg1 = movingAverage(0, 0, 100, 520);
  assert.equal(avg1, 520);
  const avgF1 = movingAverage(0, 0, 100, 20);
  assert.equal(avgF1, 20);
  const avg2 = movingAverage(100, avg1, 100, 600);
  assert.equal(avg2, 560);
  const avgF2 = movingAverage(100, avgF1, 100, 0);
  assert.equal(avgF2, 10);
  // Y la parte de flete nunca puede ser mayor que el costo: si lo fuera,
  // apagar de más dejaría el precio por debajo del costo.
  assert.ok(avgF2 < avg2);
  assert.equal(freightInsideCost({ cost: 560, source: "kardex", avgFreight: 10, captured: false }), 10);
  assert.equal(freightInsideCost({ cost: 5, source: "kardex", avgFreight: 10, captured: false }), 5, "tope en el costo");
});

// ---------------------------------------------------------------------------
// 5. Los otros llamadores del kardex no mandan flete, y hay que contarlos
// ---------------------------------------------------------------------------
test("solo la RECEPCIÓN manda flete al kardex; los demás movimientos no cambian", () => {
  // Si esta lista dice menos de los que hay, el que falte puede empezar a
  // mandar flete sin que nadie lo note — la lección de los SEIS lectores.
  const archivos = [
    "src/lib/azagro.ts",
    "src/lib/erp/receipt-reversal.ts",
    "src/lib/erp/delivery-reversal.ts",
    "src/lib/erp/return-reversal.ts",
    "src/lib/erp/cutover-core.ts",
    "src/lib/erp/stock.ts",
  ];
  let conFlete = 0;
  let total = 0;
  for (const f of archivos) {
    const t = src(f);
    // `postStock(sql, {` y `postStock(tx, {`: las dos formas que se usan.
    // `postStock(sql, {`, `postStock(tx, {` y `o.postStock(sql, {` (el corte
    // lo recibe inyectado): las tres formas que se usan de verdad.
    total += (t.match(/await (?:o\.)?postStock\((?:sql|tx), \{/g) || []).length;
    // Solo en los LLAMADORES: `stock.ts` es donde vive `postStock`, y ahí
    // `freightUnit` es su propia variable, no una llamada.
    if (f !== "src/lib/erp/stock.ts") conFlete += (t.match(/freightUnit:/g) || []).length;
  }
  assert.equal(total, 12, "el kardex se mueve desde 12 lugares; si esta cuenta cambia, revisa el nuevo ANTES de tocar el número");
  // DOS lo mandan explícito, y las dos por la misma razón: saben algo que el
  // promedio de la bodega no sabe.
  //   · la recepción: el flete de ESE camión, que acaba de llegar;
  //   · la devolución: el flete con el que esa mercancía SALIÓ (Decisión 9),
  //     que no es el promedio de hoy.
  // Los otros diez no lo mandan y NO lo necesitan: `postStock` lo deriva del
  // mismo lugar del que saca el costo. Pedirle a cada llamador que se acuerde
  // fue justo lo que dejó a la utilidad del pedido sin ver el flete.
  assert.equal(conFlete, 2, "dos lo mandan explícito: la recepción y la devolución");
  const a = src("src/lib/azagro.ts");
  assert.ok(a.includes("freightUnit: fleteUnit.get(x.lineId) ?? 0,"), "la recepción");
  assert.ok(a.includes("freightUnit: exitFreight ?? undefined,"), "la devolución, con el que salió");
  const st = src("src/lib/erp/stock.ts");
  assert.ok(st.includes("if (freightUnit == null) freightUnit = Math.min(cached.avgFreight, unitCost);"), "una salida lo deriva del promedio de su bodega");
  assert.ok(st.includes("if (freightUnit == null && opts.reversesId) {"), "y un contrario lo hereda del movimiento que revierte");
});

test("una salida NO borra el desglose del costo que se queda en la bodega", () => {
  const st = src("src/lib/erp/stock.ts");
  assert.ok(st.includes("avg_freight = coalesce(${avgFreight ?? null}, stock_quants.avg_freight)"), "se conserva");
});

// ---------------------------------------------------------------------------
// 6. El apagador se CONGELA, no se recalcula
// ---------------------------------------------------------------------------
test("cuánto flete trae el costo se congela con la partida, en los cuatro lugares que la crean", () => {
  // Recalcularlo después leería el promedio de HOY, que ya se movió con los
  // camiones que llegaron después de cotizar.
  const ops = src("src/lib/erp/ops.ts");
  const req = src("src/lib/erp/requests.ts");
  assert.ok(ops.includes("const costFreightIn = freightInsideCost({ cost, source: pick.source, avgFreight: p?.freight_in_cost, captured: line.cost > 0 });"), "cotizar");
  assert.ok(ops.includes("const fleteDentroNuevo = (productId: number) => {"), "revisar, partida nueva");
  assert.ok(ops.includes("const fleteDentroDe = (productId: number) => {"), "duplicar");
  assert.ok(req.includes("cost_currency, cost_fx, cost_freight_in,"), "cotizar desde solicitud");
  assert.ok(req.includes("el costo de una\n        -- solicitud es el precio del PROVEEDOR"), "y ahí es CERO, dicho a propósito");
  // La regla vive en UN solo lugar.
  assert.equal((src("src/lib/erp/cost.ts").match(/export function freightInsideCost\(/g) || []).length, 1);
});

// ---------------------------------------------------------------------------
// 7. Las puertas por donde el mismo dinero podría volver a restar
// ---------------------------------------------------------------------------
test("un gasto ligado a un VIAJE no puede marcarse además como flete del pedido", () => {
  // Ese gasto ya entró al costo de la mercancía en el kardex. Marcarlo también
  // como flete del pedido lo restaría una segunda vez de la utilidad — el
  // doble conteo de la Decisión 99, por la puerta de al lado.
  const e = src("src/lib/erp/expenses.ts");
  assert.ok(e.includes("if (data.isFreight && data.eventRef) {"), "el candado");
  assert.ok(e.includes("Marcarlo también como flete del pedido lo restaría dos veces."), "y dice por qué");
});

test("un gasto ligado a un viaje no resta como gasto del pedido: ya está en el costo", () => {
  const r = src("src/lib/erp/reports.ts");
  const q = r.slice(r.indexOf("async function orderExpenses"), r.indexOf("async function orderMora"));
  assert.ok(q.includes("and coalesce(e.event_ref,'') = ''"), "sale de la consulta de gastos del pedido");
  // Y queda escrito lo que FALTA, con el motivo de por qué no se hizo aquí: el
  // intento de netear (importe − capitalizado) se revirtió el 21-sep-2026
  // porque restaba lo capitalizado a CADA gasto del viaje en vez de al
  // conjunto — dos gastos movían la utilidad $2,500 según cómo se capturaron.
  assert.ok(q.includes("LO QUE FALTA, Y ESTÁ ANOTADO"), "el hueco queda nombrado, no escondido");
  assert.ok(q.includes("el neteo\n        -- correcto va POR VIAJE, no por gasto") || q.includes("correcto va POR VIAJE, no por gasto"), "y cómo sería el arreglo bueno");
});

test("marcar como flete del pedido un gasto de viaje se detiene por LAS DOS puertas", () => {
  // `createExpense` se detenía y `setExpenseFreight` no. Un candado que deja
  // la puerta de al lado abierta no es un candado (regla 5g).
  const e = src("src/lib/erp/expenses.ts");
  assert.equal(
    (e.match(/Marcarlo también como flete del pedido lo restaría dos veces\./g) || []).length,
    2,
    "el mismo mensaje en las dos puertas",
  );
  assert.ok(e.includes("if (data.isFreight && data.eventRef) {"), "al crear");
  assert.ok(e.includes("if (data.isFreight && e[0].event_ref) {"), "y al corregir la marca");
});

test("un viaje que YA entró al costo no se corrige: el promedio no se recalcula hacia atrás", () => {
  const t = src("src/lib/erp/trip-cost.ts");
  assert.ok(t.includes("if (antes[0]?.capitalized_at) {"), "el candado");
  assert.ok(t.includes("revierte la recepción y vuelve a recibirla con el costo correcto"), "y nombra la salida, que existe");
});

test("recibir se detiene sin el costo del viaje, y el mensaje dice dónde capturarlo", () => {
  const a = src("src/lib/azagro.ts");
  assert.ok(a.includes("hay que capturar lo que costó traerla: el flete y las maniobras del viaje"), "se detiene");
  assert.ok(a.includes("Se capturan en la orden de compra"), "dice dónde");
  assert.ok(a.includes("si el proveedor la trae sin cobrar flete se teclea 0"), "y que un cero se teclea a propósito");
  assert.ok(a.includes("Después de recibir ya no puede entrar al costo de la mercancía."), "y por qué no se puede después");
  // La salida se construyó ANTES que el candado.
  assert.ok(src("src/lib/erp/trip-cost.ts").includes("export const savePlannedTrip"), "y la salida existe");
  assert.ok(src("src/routes/purchases.tsx").includes("Capturar antes de recibir"), "y está en la pantalla donde se ve");
});

test("un camión que llegó en dos recepciones no se revierte completo: dejaría viva una factura del proveedor", () => {
  // Bug vivo, anterior a esta pieza. El lado de las ENTREGAS ya tenía este
  // candado con su razonamiento escrito; el de recepciones nunca lo tuvo.
  const r = src("src/lib/erp/receipt-reversal.ts");
  assert.ok(r.includes("const eventosVivos = await sql<{ n: number }>`"), "cuenta los eventos vivos");
  assert.ok(r.includes("dejaría viva la factura del proveedor"), "y dice qué se rompería");
  assert.ok(r.includes("Revierte la recepción que quieras deshacer, una por una."), "y manda al camino que sí funciona");
  // Solo en el camino por ORDEN: el de por evento ya filtra bien.
  assert.equal((r.match(/const eventosVivos = await sql/g) || []).length, 1, "un solo candado, en el camino por orden");
});

test("el campo de flete de la cotización se llama por lo que es", () => {
  const p = src("src/routes/solicitudes.$solicitudId.tsx");
  assert.ok(p.includes("Flete al cliente / UoM"), "el rótulo");
  assert.ok(p.includes("El flete que NO está dentro del costo"), "y la explicación al pasar el cursor");
});

test("la bitácora no publica un costo de compra a quien no puede verlo", () => {
  // La bitácora pide `settings:view`, que administración tiene — pero
  // administración NO ve costos de compra (regla 10). Sin máscara, el costo de
  // un viaje enmascarado en Compras se leía completo aquí, con su importe.
  const a = src("src/lib/erp/audit.ts");
  assert.ok(a.includes("const COSTO_DE_COMPRA = new Set(["), "la lista de acciones que imprimen un costo de compra");
  for (const acc of ["costo-de-viaje", "costo-de-viaje-planeado", "recibir", "flete-de-solicitud"]) {
    assert.ok(a.includes(`"${acc}",`), `${acc} tiene que estar en la lista`);
  }
  assert.ok(a.includes("canSeeCosts(me.role)"), "y la máscara usa el MISMO rol que esconde el número en Compras");
  assert.ok(a.includes("COSTO_DE_COMPRA.has(r.action) ? { ...r, detail: maskAmounts(r.detail) } : r"), "se tapa el importe, no el renglón");
  assert.ok(a.includes("se sale por la bitácora sin que nadie lo note"), "y queda dicho qué pasa si alguien agrega una acción y la olvida");
});

test("capturar el flete de SALIDA sobre mercancía que ya trae el de entrada es legítimo", () => {
  // El primer intento puso aquí un `throw`. Era un candado sin salida sobre el
  // único camino que existe para cobrar la entrega: mercancía + traerla +
  // llevársela suma bien, y son tres cosas distintas.
  const o = src("src/lib/erp/ops.ts");
  assert.ok(o.includes("AQUÍ NO VA UN CANDADO, y el primer intento puso uno mal"), "queda dicho");
  assert.ok(!/ya trae \$\{?costFreightIn/.test(o), "el throw se fue");
  assert.ok(o.includes("const landed = cost + (line.freight ?? 0) + (line.other ?? 0);"), "y la fórmula sigue sumando las tres");
});

test("la máscara de la bitácora se CORRE con los detalles reales, no se lee", () => {
  // Verificar una máscara leyendo su código es justo cómo se cuelan los casos:
  // la primera versión tapaba «500 → 520» y dejaba pasar «85 → 72», porque
  // dos de las trece acciones imprimen el costo sin decimales.
  const casos = [
    // [entrada, lo que NO puede quedar visible]
    ["Recepción RCP/0001 · nace FP-0001 por pagar · costo del viaje 2000.00 (flete 2000.00 + maniobras 0.00)", ["2000.00", "0.00"]],
    ["costo 85 → 72", ["85", "72"]],
    ["costo 500 → 520", ["500", "520"]],
    ["Total 50000.00 MXN", ["50000.00"]],
    ["promedio 9357.1429", ["9357.1429"]],
    ["costo de salida 520.0000", ["520.0000"]],
    ["diferencia -1500.00", ["1500.00"]],
    ["flete por unidad 0.00 → 20.00", ["20.00"]],
    ["costo de referencia 0 → 480", ["480"]],
  ];
  for (const [entrada, prohibidos] of casos) {
    const out = maskAmounts(entrada);
    for (const p of prohibidos) assert.ok(!out.includes(p), `se coló ${p} en: ${out}`);
  }
  // Y lo que NO es dinero se queda: el folio y el motivo son el trabajo de
  // administración, y taparlos fue el aviso de la revisión.
  assert.ok(maskAmounts("Recepción parcial RCP/0003 · nace FP-0007 por pagar").includes("RCP/0003"), "el folio del evento");
  assert.ok(maskAmounts("Recepción parcial RCP/0003 · nace FP-0007 por pagar").includes("FP-0007"), "el folio de la factura");
  assert.equal(maskAmounts("Cancelada: el proveedor no tenía existencia"), "Cancelada: el proveedor no tenía existencia", "el motivo obligatorio");
  assert.ok(maskAmounts("ABC1234 sin costo").includes("ABC1234"), "un código de producto no es un importe");
});

test("todas las acciones que imprimen un costo de compra están en la lista", () => {
  // El comentario dice «la lista solo sirve si está completa». `devolver`
  // faltaba: imprime «costo de salida 520.0000», que desde esta pieza ya trae
  // el flete adentro.
  const a = src("src/lib/erp/audit.ts");
  for (const acc of [
    "costo-de-viaje", "costo-de-viaje-planeado", "recibir", "flete-de-solicitud",
    "elegir-proveedor", "precio-producto", "crear-oc", "cancelar-oc", "revertir-fp",
    "revertir-recepcion", "devolucion-sin-costo-origen", "devolver",
  ]) {
    assert.ok(a.includes(`"${acc}",`), `${acc} imprime un costo de compra y no está en la lista`);
  }
});
