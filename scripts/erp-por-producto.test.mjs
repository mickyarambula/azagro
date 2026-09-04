// BLOQUE "POR PRODUCTO" DEL ESTADO DE CUENTA (3-sep-2026, prueba con el dueño).
//
// El estado de cuenta contesta una sola pregunta: cuánto debe el cliente y de
// qué. Si el bloque de arriba muestra SALDO y el de abajo VENTA, son dos cifras
// distintas en el mismo documento y no cuadran.
//
// Lo que estaba mal:
//   · el número era el saldo prorrateado, pero se armaba en el servidor sobre
//     TODAS las facturas del cliente, ignorando "Ocultar pagadas";
//   · la mora (FI) y el ajuste de TC (ATC) no tienen partidas y entraban con su
//     origen, como si fueran productos ("Mora FV-0002");
//   · sumaba MXN con USD en un solo número;
//   · el layout era una rejilla de dos columnas: el importe de la izquierda
//     quedaba pegado al nombre de la derecha.
//
// Cómo debe quedar: saldo por producto, prorrateado por importe de partida, con
// el MISMO criterio de filtrado que la tabla de arriba, separado por moneda, y
// con los cargos que no son mercancía agrupados aparte. La suma del bloque da
// exactamente el total de la tabla de arriba.
//
// Copias literales de src/lib/erp/statement-products.ts y del filtro
// productRows de src/routes/statements.tsx; abajo, el cableado.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

const round2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Copias
// ---------------------------------------------------------------------------

/** Copia de productRows en src/routes/statements.tsx: lo que pinta la tabla. */
function productRows(rows, hidePaid) {
  return rows.filter((r) => {
    if (r.kind !== "customer") return false;
    if ((r.inv_class || "product") !== "product") return false;
    if (hidePaid && r.saldo <= 0.009) return false;
    return true;
  });
}

/** Copia del total de saldo de la tabla (totalsCells en statements.tsx). */
function tableSaldo(rows, currency) {
  return rows.filter((r) => (r.currency || "MXN") === currency).reduce((s, r) => s + r.saldo, 0);
}

/** Copia de src/lib/erp/statement-products.ts */
const CURRENCY_ORDER = ["MXN", "USD"];
function currencyRank(cur) {
  const i = CURRENCY_ORDER.indexOf(cur);
  return i < 0 ? CURRENCY_ORDER.length : i;
}
function addTo(map, concept, saldo) {
  const prev = map.get(concept);
  if (prev) {
    prev.saldo += saldo;
    prev.docs += 1;
  } else {
    map.set(concept, { concept, saldo, docs: 1 });
  }
}
function bySaldoDesc(a, b) {
  return Math.abs(b.saldo) - Math.abs(a.saldo) || a.concept.localeCompare(b.concept, "es");
}
function statementByProduct(rows) {
  const currencies = [...new Set(rows.map((r) => r.currency || "MXN"))].sort(
    (a, b) => currencyRank(a) - currencyRank(b) || a.localeCompare(b),
  );
  return currencies.map((currency) => {
    const set = rows.filter((r) => (r.currency || "MXN") === currency);
    const total = set.reduce((s, r) => s + r.saldo, 0);
    const products = new Map();
    const others = new Map();
    for (const r of set) {
      const lineSum = r.products.reduce((s, l) => s + Number(l.amount), 0);
      if (!r.products.length || !(lineSum > 0)) {
        addTo(others, r.origin || r.name, r.saldo);
        continue;
      }
      for (const l of r.products) {
        addTo(products, l.product, (r.saldo * Number(l.amount)) / lineSum);
      }
    }
    const productList = [...products.values()].sort(bySaldoDesc);
    const otherList = [...others.values()].sort(bySaldoDesc);
    const items = [...productList, ...otherList];
    let acc = 0;
    for (const it of items) {
      it.saldo = round2(it.saldo);
      acc += it.saldo;
    }
    const diff = round2(round2(total) - round2(acc));
    const ajustables = productList.length ? productList : otherList;
    if (diff !== 0 && ajustables.length) {
      const biggest = ajustables.reduce((m, it) => (Math.abs(it.saldo) >= Math.abs(m.saldo) ? it : m), ajustables[0]);
      biggest.saldo = round2(biggest.saldo + diff);
    }
    return {
      currency,
      products: productList,
      others: otherList,
      othersTotal: round2(otherList.reduce((s, o) => s + o.saldo, 0)),
      total: round2(total),
    };
  });
}
function statementOutsideDocs(rows, hidePaid) {
  return rows
    .filter((r) => r.kind === "customer" && (r.inv_class || "product") !== "product")
    .filter((r) => !hidePaid || Math.abs(r.saldo) > 0.009)
    .map((r) => ({
      name: r.name,
      concept: r.origin || r.name,
      currency: r.currency || "MXN",
      saldo: round2(r.saldo),
    }))
    .sort((a, b) => Math.abs(b.saldo) - Math.abs(a.saldo) || a.name.localeCompare(b.name, "es"));
}

// ---------------------------------------------------------------------------
// El cliente de la prueba: SL AGRICOLA, con las dos monedas, una factura ya
// pagada, saldos abiertos del corte Compaq sin partidas, mora facturada y
// ajuste de tipo de cambio.
// ---------------------------------------------------------------------------
const doc = (o) => ({ kind: "customer", inv_class: "product", currency: "MXN", origin: "", products: [], ...o });

const CLIENTE = [
  doc({
    name: "FV-0001",
    saldo: 140000,
    products: [
      { product: "UREA 46%", amount: "100000" },
      { product: "SULFATO DE AMONIO", amount: "40000" },
    ],
  }),
  // Dos facturas con el MISMO saldo y productos distintos: tienen que salir como
  // dos renglones, cada uno con su nombre (antes era un importe repetido).
  doc({ name: "FV-0002", saldo: 156849.85, products: [{ product: "MEZCLA FISICA", amount: "156849.85" }] }),
  doc({ name: "FV-0003", saldo: 156849.85, products: [{ product: "FOSFATO MONOAMONICO", amount: "156849.85" }] }),
  // Corte Compaq: saldo abierto real, sin partidas. No es un producto, pero sí
  // es parte del saldo de la tabla.
  doc({ name: "A-292", origin: "Corte Compaq", saldo: 130000 }),
  doc({ name: "A-315", origin: "Corte Compaq", saldo: 42000 }),
  // Pagada: se esconde con "Ocultar pagadas", igual que arriba.
  doc({ name: "FV-0004", saldo: 0, products: [{ product: "UREA 46%", amount: "50000" }] }),
  // Dólares: pagó una parte, el saldo se reparte a prorrata del importe.
  doc({
    name: "FV-0010",
    currency: "USD",
    saldo: 12000,
    products: [
      { product: "GLIFOSATO", amount: "10000" },
      { product: "SURFACTANTE", amount: "5000" },
    ],
  }),
  // Documentos que NO son mercancía y que tampoco están en la tabla de arriba.
  doc({ name: "FI-0007", inv_class: "interest", origin: "Mora FV-0002", saldo: 1234.56 }),
  doc({ name: "ATC-0001", inv_class: "fx", origin: "Ajuste TC FV-0003", saldo: 560 }),
  // Una FI ya pagada: con "Ocultar pagadas" desaparece, mismo criterio.
  doc({ name: "FI-0003", inv_class: "interest", origin: "Mora FV-0001", saldo: 0 }),
  // Del proveedor: nunca entra al estado de cuenta del cliente.
  doc({ name: "FP-0001", kind: "supplier", saldo: 99999, products: [{ product: "UREA 46%", amount: "99999" }] }),
];

// ---------------------------------------------------------------------------
// LA PRUEBA QUE PIDIÓ EL DUEÑO: el total del bloque coincide SIEMPRE con el
// total de la tabla de arriba — con y sin "Ocultar pagadas", en las dos monedas.
// ---------------------------------------------------------------------------
for (const hidePaid of [false, true]) {
  const etiqueta = hidePaid ? 'con "Ocultar pagadas"' : 'sin "Ocultar pagadas"';

  test(`${etiqueta}: el bloque suma exactamente el total de la tabla, moneda por moneda`, () => {
    const rows = productRows(CLIENTE, hidePaid);
    const blocks = statementByProduct(rows);
    assert.deepEqual(
      blocks.map((b) => b.currency),
      ["MXN", "USD"],
    );
    for (const b of blocks) {
      // 1) El total del bloque ES el total de saldo de la tabla en esa moneda.
      assert.equal(b.total, round2(tableSaldo(rows, b.currency)));
      // 2) Y los renglones que se leen en pantalla suman ese total al centavo.
      const leido = round2(b.products.reduce((s, p) => s + p.saldo, 0) + b.othersTotal);
      assert.equal(leido, b.total);
    }
    // 3) Nunca un número que mezcle monedas.
    const mxn = blocks.find((b) => b.currency === "MXN");
    const usd = blocks.find((b) => b.currency === "USD");
    assert.notEqual(mxn.total, usd.total);
    assert.equal(mxn.total, round2(tableSaldo(rows, "MXN")));
    assert.equal(usd.total, round2(tableSaldo(rows, "USD")));
  });
}

test("ocultar pagadas cambia el total de la tabla Y el del bloque, juntos", () => {
  const conPagadas = statementByProduct(productRows(CLIENTE, false));
  const sinPagadas = statementByProduct(productRows(CLIENTE, true));
  // La factura pagada trae saldo 0: el total no se mueve, pero su producto sí
  // deja de aparecer cuando se ocultan las pagadas. El criterio es uno solo.
  const nombres = (bs) => bs.find((b) => b.currency === "MXN").products.map((p) => p.concept);
  assert.ok(nombres(conPagadas).includes("UREA 46%"));
  assert.ok(nombres(sinPagadas).includes("UREA 46%")); // FV-0001 sigue abierta
  const docsUrea = (bs) => bs.find((b) => b.currency === "MXN").products.find((p) => p.concept === "UREA 46%").docs;
  assert.equal(docsUrea(conPagadas), 2); // FV-0001 + FV-0004 (pagada)
  assert.equal(docsUrea(sinPagadas), 1); // solo FV-0001
});

test("saldo por producto, prorrateado por importe de partida", () => {
  const mxn = statementByProduct(productRows(CLIENTE, true)).find((b) => b.currency === "MXN");
  const urea = mxn.products.find((p) => p.concept === "UREA 46%");
  const sulfato = mxn.products.find((p) => p.concept === "SULFATO DE AMONIO");
  // FV-0001: saldo 140,000 repartido 100/40 mil.
  assert.equal(urea.saldo, 100000);
  assert.equal(sulfato.saldo, 40000);
  const usd = statementByProduct(productRows(CLIENTE, true)).find((b) => b.currency === "USD");
  // FV-0010: cargo 15,000 USD con saldo 12,000 → 2/3 y 1/3.
  assert.equal(usd.products.find((p) => p.concept === "GLIFOSATO").saldo, 8000);
  assert.equal(usd.products.find((p) => p.concept === "SURFACTANTE").saldo, 4000);
  assert.equal(usd.total, 12000);
});

test("dos productos con el mismo saldo son dos renglones, cada uno con su nombre", () => {
  const mxn = statementByProduct(productRows(CLIENTE, true)).find((b) => b.currency === "MXN");
  const iguales = mxn.products.filter((p) => p.saldo === 156849.85).map((p) => p.concept);
  assert.deepEqual(iguales.sort(), ["FOSFATO MONOAMONICO", "MEZCLA FISICA"]);
  // Y ningún concepto se repite: el nombre es la identidad del renglón.
  const conceptos = mxn.products.map((p) => p.concept);
  assert.equal(new Set(conceptos).size, conceptos.length);
});

test("mora y ajuste de TC no son productos: salen del bloque y se listan aparte", () => {
  const rows = productRows(CLIENTE, false);
  const blocks = statementByProduct(rows);
  const todos = blocks.flatMap((b) => [...b.products, ...b.others]).map((p) => p.concept);
  assert.ok(!todos.includes("Mora FV-0002"), "la mora no es un producto");
  assert.ok(!todos.includes("Ajuste TC FV-0003"), "el ajuste de TC no es un producto");
  assert.ok(!todos.includes("FP-0001"), "la factura del proveedor no entra al estado de cuenta del cliente");
  const fuera = statementOutsideDocs(CLIENTE, false).map((d) => d.name);
  assert.deepEqual(fuera, ["FI-0007", "ATC-0001", "FI-0003"]);
  // Y no se suman al total: el bloque cuadra con la tabla, que tampoco los trae.
  const mxn = blocks.find((b) => b.currency === "MXN");
  assert.equal(mxn.total, round2(tableSaldo(rows, "MXN")));
  // Mismo criterio de pagadas también aquí.
  assert.deepEqual(
    statementOutsideDocs(CLIENTE, true).map((d) => d.name),
    ["FI-0007", "ATC-0001"],
  );
});

test('el corte Compaq va en "Otros cargos", con su desglose, y sí cuenta en el total', () => {
  const mxn = statementByProduct(productRows(CLIENTE, true)).find((b) => b.currency === "MXN");
  assert.deepEqual(
    mxn.others.map((o) => o.concept),
    ["Corte Compaq"],
  );
  assert.equal(mxn.others[0].docs, 2); // A-292 y A-315 agrupadas
  assert.equal(mxn.othersTotal, 172000);
  assert.ok(!mxn.products.some((p) => p.concept === "Corte Compaq"), "no se mezcla con la mercancía");
  const leido = round2(mxn.products.reduce((s, p) => s + p.saldo, 0) + mxn.othersTotal);
  assert.equal(leido, mxn.total);
});

// $100 entre tres partidas iguales: 33.33 + 33.33 + 33.33 = 99.99. El centavo
// que falta lo absorbe el producto más grande de la moneda, no se pierde.
const TERCIOS = doc({
  name: "FV-0005",
  saldo: 100,
  products: [
    { product: "ADHERENTE", amount: "1" },
    { product: "COADYUVANTE", amount: "1" },
    { product: "REGULADOR PH", amount: "1" },
  ],
});

test("los centavos del prorrateo no rompen el cuadre", () => {
  const b = statementByProduct(productRows([TERCIOS], true))[0];
  assert.equal(b.total, 100);
  assert.equal(round2(b.products.reduce((s, p) => s + p.saldo, 0)), 100);
  assert.deepEqual(
    b.products.map((p) => p.saldo).sort((x, y) => y - x),
    [33.34, 33.33, 33.33],
  );
});

test("con centavos de por medio el bloque sigue cuadrando, en las dos monedas y con las dos vistas", () => {
  const conCentavos = [...CLIENTE, TERCIOS];
  for (const hidePaid of [false, true]) {
    const rows = productRows(conCentavos, hidePaid);
    for (const b of statementByProduct(rows)) {
      assert.equal(b.total, round2(tableSaldo(rows, b.currency)));
      assert.equal(round2(b.products.reduce((s, p) => s + p.saldo, 0) + b.othersTotal), b.total);
    }
  }
  // El centavo cae en un producto; "Otros cargos" son saldos completos de
  // documentos y quedan exactos.
  const mxn = statementByProduct(productRows(conCentavos, true)).find((b) => b.currency === "MXN");
  assert.equal(mxn.othersTotal, 172000);
});

test("un cliente sin nada no pinta bloque", () => {
  assert.deepEqual(statementByProduct([]), []);
  assert.deepEqual(statementOutsideDocs([], false), []);
});

// ---------------------------------------------------------------------------
// Cableado: que la pantalla use ESTOS renglones y no otra fuente.
// ---------------------------------------------------------------------------
test("cableado: el bloque se arma con los mismos renglones que la tabla", () => {
  const page = src("src/routes/statements.tsx");
  assert.ok(page.includes("const rows = productRows(viewing, hidePaid);"), "la tabla filtra con productRows");
  assert.ok(page.includes("const blocks = statementByProduct(rows);"), "el bloque usa esos mismos renglones");
  assert.ok(page.includes("const outside = statementOutsideDocs(viewing.rows, hidePaid);"), "y el mismo hidePaid");
  assert.ok(
    page.includes('import { statementByProduct, statementOutsideDocs } from "@/lib/erp/statement-products";'),
    "un solo lugar donde se reparte el saldo",
  );
  assert.ok(!page.includes("viewing.byProduct"), "ya no existe el byProduct del servidor");
  assert.ok(page.includes("Por producto — saldo pendiente"), "el título dice que es saldo, no venta");
  assert.ok(page.includes("moneyIn(b.total, b.currency)"), "el total se imprime en la moneda del bloque");
  assert.ok(page.includes("Otros cargos"), "los cargos que no son mercancía van agrupados");
});

test("cableado: el servidor ya no arma un por-producto que mezcla monedas", () => {
  const ops = src("src/lib/erp/ops.ts");
  assert.ok(!ops.includes("const byProduct"), "se fue del servidor");
  assert.ok(!ops.includes("byProduct,"), "y del payload del estado de cuenta");
  assert.ok(ops.includes("result.push({ partner, contacts, rows, ar, ap, byCurrency });"));
});

test("cableado: el reparto separa monedas y no inventa un producto", () => {
  const lib = src("src/lib/erp/statement-products.ts");
  assert.ok(lib.includes('const set = rows.filter((r) => (r.currency || "MXN") === currency);'), "una lista por moneda");
  assert.ok(lib.includes("addTo(others, r.origin || r.name, r.saldo);"), "sin partidas no se inventa producto");
  assert.ok(lib.includes("addTo(products, l.product, (r.saldo * Number(l.amount)) / lineSum);"), "prorrateo por partida");
  assert.ok(lib.includes("total: round2(total),"), "el total es el de la tabla, no la suma de redondeos");
});
