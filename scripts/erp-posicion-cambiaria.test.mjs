// BLOQUE A.2 — la posición cambiaria (Decisiones 83-86, 18-sep-2026,
// MODELO-NEGOCIO.md § 11.6). Contesta las cuatro preguntas del dueño sobre el
// dólar: cuánto se debe y deben por cubeta de vencimiento, a qué TC se pactó
// cada documento vivo contra el TC de hoy, cuánto se gana o se pierde si el
// dólar se mueve X pesos, y qué parte está cubierta por las dos dinámicas.
//
// Lo más fácil de equivocar aquí es el SIGNO: una cuenta por COBRAR en dólares
// gana cuando el dólar sube, una por PAGAR pierde. Esta prueba lo fija con
// números, igual que erp-parciales-paso6 fija el cuadre.
//
// Todo se calcula en vivo, sin columna y sin migración.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bucketFor,
  bucketize,
  classifyDeal,
  coverageByBucket,
  FX_BUCKETS,
  netPosition,
  revaluation,
  sensitivity,
} from "../src/lib/erp/fx-position.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

function fnBody(source, name) {
  const markers = [`export const ${name} `, `export async function ${name}(`, `export function ${name}(`, `async function ${name}(`, `function ${name}(`];
  const start = markers.map((m) => source.indexOf(m)).find((i) => i !== -1);
  assert.notEqual(start, undefined, `No existe ${name}`);
  const rest = source.slice(start);
  const next = rest.slice(10).search(/\n(export )?(async )?function |\nexport const /);
  return next === -1 ? rest : rest.slice(0, next + 10);
}

const HOY = "2026-09-18";
const doc = (o) => ({ kind: "FV", name: "FV-0001", partner: "Cliente", side: "cobrar", committed: false, usd: 0, fxAgreed: 18.5, due: HOY, ...o });

// ---------------------------------------------------------------------------
// Cubetas
// ---------------------------------------------------------------------------
test("las cubetas se paran en la fecha convenida, con «Vencido» al frente y «Sin fecha» aparte", () => {
  assert.equal(bucketFor("2026-09-17", HOY), "vencido");
  assert.equal(bucketFor("2026-01-01", HOY), "vencido");
  assert.equal(bucketFor(HOY, HOY), "hoy");
  assert.equal(bucketFor("2026-09-19", HOY), "1-30");
  assert.equal(bucketFor("2026-10-18", HOY), "1-30", "el día 30 todavía es 1-30");
  assert.equal(bucketFor("2026-10-19", HOY), "31-60", "el 31 abre la siguiente");
  assert.equal(bucketFor("2026-11-17", HOY), "31-60");
  assert.equal(bucketFor("2026-11-18", HOY), "61-90");
  assert.equal(bucketFor("2026-12-17", HOY), "61-90");
  assert.equal(bucketFor("2026-12-18", HOY), "91-150");
  assert.equal(bucketFor("2027-02-15", HOY), "91-150", "el día 150 todavía es 91-150");
  assert.equal(bucketFor("2027-02-16", HOY), "+150");
  // Sin fecha NO es hoy ni vencido: una orden de compra no tiene vencimiento
  // en la base y no se le inventa uno (regla 9, Decisión 83).
  assert.equal(bucketFor(null, HOY), "sin-fecha");
  assert.equal(bucketFor(undefined, HOY), "sin-fecha");
  assert.equal(FX_BUCKETS.length, 8);
});

test("bucketize: cada documento a su casilla, y el neto por cubeta", () => {
  const rows = bucketize(
    [
      doc({ name: "FV-1", usd: 10000, due: "2026-10-01" }),
      doc({ name: "FV-2", usd: 2000, due: "2026-09-10" }),
      doc({ kind: "FP", name: "FP-1", side: "pagar", usd: 6000, due: "2026-10-05" }),
      doc({ kind: "PV", name: "PV-9", committed: true, usd: 3000, due: "2026-10-20" }),
      doc({ kind: "OC", name: "OC-9", side: "pagar", committed: true, usd: 1500, due: null }),
    ],
    HOY,
  );
  const b = (k) => rows.find((r) => r.bucket === k);
  assert.equal(b("vencido").cxc, 2000);
  assert.equal(b("1-30").cxc, 10000);
  assert.equal(b("1-30").cxp, 6000);
  // Del 18-sep al 20-oct hay 32 días: cae en la cubeta siguiente, no en 1-30.
  assert.equal(b("31-60").ventaComprometida, 3000);
  assert.equal(b("1-30").ventaComprometida, 0);
  // 10,000 por cobrar − 6,000 por pagar = 4,000
  assert.equal(b("1-30").neto, 4000);
  assert.equal(b("31-60").neto, 3000);
  assert.equal(b("sin-fecha").compraComprometida, 1500);
  assert.equal(b("sin-fecha").neto, -1500, "lo comprometido de compra resta");
});

test("un documento en dólares SIN TC pactado cuenta aparte y no se valúa (Decisión 85)", () => {
  const rows = bucketize([doc({ usd: 4000, fxAgreed: null, due: "2026-10-01" })], HOY);
  const b = rows.find((r) => r.bucket === "1-30");
  assert.equal(b.sinTcUsd, 4000, "se cuenta en su propio renglón, con nombre y socio");
  assert.equal(b.cxc, 0, "y NO entra a un total que después se multiplica por un TC");
  assert.equal(b.neto, 0);
});

test("lo que no se puede valuar no mueve la posición neta ni la sensibilidad (Decisión 85)", () => {
  const rows = bucketize(
    [doc({ usd: 4000, fxAgreed: null, side: "pagar", due: "2026-10-01" }), doc({ usd: 1000, fxAgreed: 18.5, due: "2026-10-01" })],
    HOY,
  );
  const pos = netPosition(rows, { usd: 0, tracked: 0, sinTc: 0, avgFx: null });
  assert.equal(pos.pasivosUsd, 0, "la factura sin TC no se suma a lo que debemos");
  assert.equal(pos.netoUsd, 1000, "solo lo valuable mueve el neto");
  assert.equal(pos.sinTcUsd, 4000, "pero se dice cuánto quedó fuera");
  assert.equal(sensitivity(pos.netoUsd, 1), 1000, "y la sensibilidad no lo multiplica");
});

// ---------------------------------------------------------------------------
// Posición neta y las dos preguntas de dinero
// ---------------------------------------------------------------------------
const CAJA = { usd: 5000, tracked: 5000, sinTc: 0, avgFx: 18.4 };

test("posición neta: (lo que nos deben + caja) − lo que debemos", () => {
  const rows = bucketize(
    [
      doc({ name: "FV-1", usd: 10000, due: "2026-10-01" }),
      doc({ kind: "FP", name: "FP-1", side: "pagar", usd: 6000, due: "2026-10-05" }),
      doc({ kind: "OC", name: "OC-1", side: "pagar", committed: true, usd: 1000, due: null }),
    ],
    HOY,
  );
  const p = netPosition(rows, CAJA);
  assert.equal(p.activosUsd, 10000);
  assert.equal(p.pasivosUsd, 7000, "la factura del proveedor más la orden comprometida");
  assert.equal(p.cajaUsd, 5000);
  assert.equal(p.netoUsd, 8000, "10,000 + 5,000 − 7,000");
});

test("sensibilidad: EL SIGNO. Si el dólar sube, una posición neta positiva gana y una negativa pierde", () => {
  // Posición larga en dólares (nos deben más de lo que debemos): el dólar sube, ganamos.
  assert.equal(sensitivity(8000, 1), 8000, "con +1 peso, 8,000 dólares netos son +$8,000");
  assert.equal(sensitivity(8000, 0.5), 4000);
  assert.equal(sensitivity(8000, -1), -8000, "si el dólar BAJA un peso, se pierde");
  // Posición corta (debemos más de lo que nos deben): el dólar sube, perdemos.
  assert.equal(sensitivity(-3000, 1), -3000);
  assert.equal(sensitivity(-3000, -1), 3000);
  assert.equal(sensitivity(0, 5), 0, "sin exposición no hay nada que ganar ni perder");
});

test("revaluación al TC de hoy: por cobrar gana cuando el dólar sube; por pagar pierde", () => {
  const docs = [
    doc({ name: "FV-1", usd: 10000, fxAgreed: 18.5 }),
    doc({ kind: "FP", name: "FP-1", side: "pagar", usd: 6000, fxAgreed: 18.0 }),
  ];
  // El dólar de hoy (19.00) está arriba de los dos pactados.
  const r = revaluation(docs, CAJA, 19);
  // Cliente: 10,000 × (19.00 − 18.50) = +5,000 (nos van a pagar dólares que valen más)
  // Proveedor: −6,000 × (19.00 − 18.00) = −6,000 (vamos a pagar dólares que cuestan más)
  assert.equal(r.docsMxn, -1000, "5,000 − 6,000");
  // Caja: 5,000 dólares comprados a 18.40, hoy valen 19.00 → +3,000 no realizados
  assert.equal(r.cajaMxn, 3000);
  assert.equal(r.totalMxn, 2000);
});

test("sin TC de hoy no se inventa ninguno: la revaluación no se calcula (regla 9)", () => {
  const r = revaluation([doc({ usd: 1000 })], CAJA, null);
  assert.equal(r.docsMxn, null);
  assert.equal(r.cajaMxn, null);
  assert.equal(r.totalMxn, null);
  // La regla «un TC real es mayor que 1» vive en UN solo lugar (`isUsdFx`) y se
  // aplica en la frontera: la consulta entrega null cuando no hay TC usable, y
  // el motor puro no vuelve a decidir qué es un tipo de cambio.
  const q = src("src/lib/erp/fx-position-query.ts");
  assert.ok(q.includes("const tcHoy = isUsdFx(hoy?.rate) ? Number(hoy!.rate) : null;"), "la consulta normaliza el TC de hoy");
  assert.ok(q.includes("revaluation(docs, cash, tcHoy)"), "y el motor recibe un número usable o null");
});

test("la revaluación NO valúa los documentos sin TC pactado: los cuenta aparte", () => {
  const r = revaluation([doc({ usd: 10000, fxAgreed: 18.5 }), doc({ name: "FV-2", usd: 4000, fxAgreed: null })], { usd: 0, tracked: 0, sinTc: 0, avgFx: null }, 19);
  assert.equal(r.docsMxn, 5000, "solo la que sí tiene TC pactado");
  assert.equal(r.sinTcUsd, 4000);
});

// ---------------------------------------------------------------------------
// Cobertura — dinámica 1 (a nivel empresa, por cubeta) y dinámica 2 (por deal)
// ---------------------------------------------------------------------------
test("dinámica 1: los dólares en caja se apartan contra lo que se debe, de lo que vence antes a lo que vence después", () => {
  const rows = bucketize(
    [
      doc({ kind: "FP", name: "FP-1", side: "pagar", usd: 3000, due: "2026-09-10" }), // vencido
      doc({ kind: "FP", name: "FP-2", side: "pagar", usd: 4000, due: "2026-10-01" }), // 1-30
      doc({ kind: "OC", name: "OC-1", side: "pagar", committed: true, usd: 2000, due: null }), // sin fecha
    ],
    HOY,
  );
  const cob = coverageByBucket(rows, 5000);
  const b = (k) => cob.find((r) => r.bucket === k);
  assert.equal(b("vencido").debeUsd, 3000);
  assert.equal(b("vencido").cubiertoCaja, 3000, "lo vencido se cubre primero");
  assert.equal(b("vencido").abiertoCompra, 0);
  assert.equal(b("1-30").debeUsd, 4000);
  assert.equal(b("1-30").cubiertoCaja, 2000, "quedaban 2,000 dólares");
  assert.equal(b("1-30").abiertoCompra, 2000, "y 2,000 quedan abiertos");
  assert.equal(b("sin-fecha").cubiertoCaja, 0, "ya no queda caja");
  assert.equal(b("sin-fecha").abiertoCompra, 2000);
  // El orden de salida es el canónico, para que la tabla siempre se lea igual.
  assert.deepEqual(cob.map((r) => r.bucket), [...FX_BUCKETS]);
});

test("dinámica 1: sin dólares en caja, todo lo que se debe queda abierto", () => {
  const rows = bucketize([doc({ kind: "FP", side: "pagar", name: "FP-1", usd: 7000, due: "2026-10-01" })], HOY);
  const cob = coverageByBucket(rows, 0);
  const b = cob.find((r) => r.bucket === "1-30");
  assert.equal(b.cubiertoCaja, 0);
  assert.equal(b.abiertoCompra, 7000);
});

const deal = (o) => ({ soName: "PV-0001", partner: "Cliente", saleCurrency: "USD", saleFx: 18.5, buyCurrency: "USD", buyFx: 18.2, saleUsd: 0, buyUsd: 0, hasBuy: true, ...o });

test("dinámica 2: compra en pesos al TC del proveedor + venta en dólares al pactado = CUBIERTO", () => {
  const c = classifyDeal(deal({ buyCurrency: "MXN", buyFx: null, saleUsd: 10000, buyUsd: 0 }));
  assert.equal(c.estado, "dinamica-2");
  assert.equal(c.usdAbierto, 0, "las dos patas quedan fijas en pesos");
});

test("sin compra ligada al pedido NO se declara dinámica 2: no hay dos patas que fijar", () => {
  // Lo encontró la verificación en navegador: un pedido surtido de inventario
  // (su OC no lleva so_id) salía como «cubierto, dinámica 2» aunque no hubiera
  // ninguna compra ligada. Decir eso es afirmar una cobertura que no consta.
  const c = classifyDeal(deal({ buyCurrency: "MXN", buyFx: null, saleUsd: 8000, buyUsd: 0, hasBuy: false }));
  assert.equal(c.estado, "venta-pactada");
  assert.match(c.motivo, /No hay una compra ligada a este pedido/);
  assert.equal(c.usdAbierto, 0, "el precio al cliente sí está fijo al pactado");
});

test("las dos puntas en dólares y por el mismo monto: cobertura natural", () => {
  const c = classifyDeal(deal({ saleUsd: 10000, buyUsd: 10000 }));
  assert.equal(c.estado, "natural");
  assert.equal(c.usdApareado, 10000);
  assert.equal(c.usdAbierto, 0);
});

test("las dos puntas en dólares con montos distintos: lo que sobra queda abierto por ese lado", () => {
  const masCompra = classifyDeal(deal({ saleUsd: 8000, buyUsd: 10000 }));
  assert.equal(masCompra.estado, "abierto-compra");
  assert.equal(masCompra.usdApareado, 8000);
  assert.equal(masCompra.usdAbierto, 2000);
  const masVenta = classifyDeal(deal({ saleUsd: 12000, buyUsd: 10000 }));
  assert.equal(masVenta.estado, "abierto-venta");
  assert.equal(masVenta.usdAbierto, 2000);
});

test("venta en pesos con costo en dólares: ABIERTO lado compra (el costo se mueve y el precio no)", () => {
  const c = classifyDeal(deal({ saleCurrency: "MXN", saleFx: null, saleUsd: 0, buyUsd: 9000 }));
  assert.equal(c.estado, "abierto-compra");
  assert.equal(c.usdAbierto, 9000);
});

test("venta en dólares SIN TC pactado: abierto lado venta, y abierto por los dos si además se compra en dólares", () => {
  const soloVenta = classifyDeal(deal({ saleFx: null, buyCurrency: "MXN", buyFx: null, saleUsd: 5000, buyUsd: 0 }));
  assert.equal(soloVenta.estado, "abierto-venta");
  assert.equal(soloVenta.usdAbierto, 5000);
  const ambos = classifyDeal(deal({ saleFx: null, saleUsd: 5000, buyUsd: 4000 }));
  assert.equal(ambos.estado, "abierto-ambos");
  assert.equal(ambos.usdAbierto, 9000);
});

test("un deal sin ninguna punta en dólares no es exposición", () => {
  const c = classifyDeal(deal({ saleCurrency: "MXN", saleFx: null, buyCurrency: "MXN", buyFx: null }));
  assert.equal(c.estado, "sin-exposicion");
  assert.equal(c.usdAbierto, 0);
});

// ---------------------------------------------------------------------------
// Cableado: que la consulta lea de los documentos y no invente nada
// ---------------------------------------------------------------------------
test("la consulta cuenta lo comprometido de una orden como total menos las facturas nacidas, nunca por cantidad recibida", () => {
  const q = src("src/lib/erp/fx-position-query.ts");
  assert.ok(q.includes("and i.kind = 'supplier' and i.origin = po.name and i.state <> 'reversed'"), "la FP se amarra a su OC por origin, y una revertida no cuenta");
  const sinComentarios = q.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!sinComentarios.includes("qty_received"), "nunca por cantidad recibida: una orden directa jamás se recibe y contaría dos veces");
  // La orden guarda su total en la MONEDA DE LA ORDEN (dólares), al revés que
  // el pedido, que desde L4a vive en pesos: por eso se compara contra los
  // `amount_fx` de las facturas del proveedor, sin dividir entre el TC. Lo
  // atrapó la verificación en navegador: US$540.54 en vez de US$10,000.
  assert.ok(q.includes("const pendienteUsd = Math.round((Number(o.total) - Number(o.facturado)) * 100) / 100;"), "lo comprometido de compra, ya en dólares");
  assert.ok(q.includes("select sum(i.amount_fx) from invoices"), "las facturas del proveedor se restan en dólares");
});

test("la consulta incluye el pedido entregado sin facturar y el de contado, y deja fuera mora y ajustes por TC", () => {
  const q = src("src/lib/erp/fx-position-query.ts");
  assert.ok(q.includes("and so.state in ('confirmed','done')"), "entregar no factura (D47): un pedido `done` sin factura sigue comprometido");
  assert.ok(!q.includes("term_kind"), "el filtro de contado de creditExposure NO se copia: la posición mide moneda, no línea de crédito");
  assert.ok(q.includes("and coalesce(i.inv_class,'product') = 'product'"), "la mora (FI) y el ajuste por TC (ATC) nacen en pesos y no son exposición al dólar");
});

test("lo comprometido de venta usa la MISMA regla que creditExposure: solo FV vivas, menos lo cerrado corto", () => {
  const q = src("src/lib/erp/fx-position-query.ts");
  // La NC espejo de una entrega revertida y la NC de una devolución también
  // cuelgan del pedido (`order_id`), nacen `paid` y son `inv_class='product'`:
  // sin estos dos filtros entraban como facturación NEGATIVA y DOBLABAN lo
  // comprometido — US$16,000 en vez de US$8,000 tras revertir una entrega de
  // un pedido de 8 × 1,000 USD, y US$2,000 fantasma tras devolver 2.
  assert.ok(q.includes("and i.kind = 'customer' and i.name like 'FV-%'"), "solo facturas de venta, no las NC");
  assert.ok(q.includes("and i.reverses_id is null and i.state <> 'reversed'"), "ni la NC contraria de una revertida (regla 5d)");
  // Decisión 62: lo cerrado corto ya nunca va a salir, así que no se va a
  // facturar y no expone al dólar. Misma resta que `credit-limit.ts`.
  assert.ok(q.includes("select sum(coalesce(sl.qty_closed_short, 0) * sl.unit_price) from sales_lines sl where sl.so_id = so.id"), "lo cerrado corto no queda comprometido para siempre");
  assert.ok(q.includes("const pendienteMxn = Number(s.total) - Number(s.facturado) - Number(s.corto);"), "y se resta del pendiente");
  // Decisión 83: sin fecha de pago convenida, cubeta «Sin fecha» — nunca la
  // fecha de captura, que mandaba un pedido de contado a «Vencido».
  assert.ok(q.includes("coalesce(so.invoice_due, so.credit_due)::text as due"), "no se cae a so.date");
});

test("el promedio de los dólares en caja se lee igual que en Bancos, para que las dos pantallas digan lo mismo", () => {
  const q = src("src/lib/erp/fx-position-query.ts");
  assert.ok(q.includes("where company_id = ${companyId} order by id"), "mismo orden que listBanks: por id, no por fecha");
  assert.ok(q.includes(".map((m) => ({ amount: m.amount, fxRate: m.fx_rate, reversal: m.reverses_id != null }));"), "y el mismo amount crudo");
});

test("un traslado entre dos cuentas en dólares arrastra el costo, no lo pierde (Decisión 86)", () => {
  const o = fnBody(src("src/lib/erp/ops.ts"), "addBankMove");
  assert.ok(o.includes("tcTraslado = avg.avgFx;"), "los mismos dólares entran con el costo con el que salieron");
  assert.ok(o.includes("${tcTraslado != null ? signed : null}, ${tcTraslado})"), "la pata que sale lo guarda");
  assert.ok(o.includes("${tcTraslado != null ? Math.abs(data.amount) : null}, ${tcTraslado})"), "y la que entra también");
});

test("el TC de hoy sale de un solo lugar (fxToday) y sin renglón no se inventa ninguno", () => {
  const fx = src("src/lib/erp/fx.ts");
  assert.ok(fx.includes("export async function fxToday(sql: Sql, companyId: number, asOf: string): Promise<FxRow | null> {"), "el helper único");
  assert.ok(fx.includes("return fxAt(await loadFxTable(sql, companyId), asOf);"), "el renglón vigente a la fecha, misma regla que la TIIE");
  const q = src("src/lib/erp/fx-position-query.ts");
  assert.ok(q.includes("const hoy = await fxToday(sql, companyId, asOf);"), "la posición lo usa");
  // Antes había un lugar que tomaba el último renglón sin tope de fecha: el TC
  // del lunes se congelaba en un pedido del viernes.
  const o = src("src/lib/erp/orders.ts");
  assert.ok(o.includes("const fxRow = await fxToday(sql, companyId, todayMx());"), "el pedido propone el TC vigente HOY");
  assert.ok(!o.includes("from fx_rates where company_id = ${companyId} order by date desc limit 1"), "ya no hay resolución sin tope de fecha");
});

test("los candados de tipo de cambio: un TC ≤ 1 no se guarda ni en Ajustes ni en un pedido", () => {
  assert.ok(src("src/lib/erp/ops.ts").includes('usdMxn: z.number().gt(1, "El tipo de cambio USD→MXN tiene que ser mayor que 1 (pesos por dólar).")'), "Ajustes rechaza un TC que el resto del sistema trata como «no hay»");
  assert.ok(src("src/lib/erp/orders.ts").includes('if (data.currency === "USD" && !isUsdFx(data.fxRate)) {'), "el pedido en dólares exige un TC real, no solo mayor que cero");
});

test("permisos: la posición es tesorería de la empresa — la ve quien ve bancos, y el resultado exige ver márgenes", () => {
  const q = fnBody(src("src/lib/erp/fx-position-query.ts"), "getFxPosition");
  assert.ok(q.includes('await assertCan(sql, context.userId, "banks", "view");'), "módulo bancos");
  assert.ok(q.includes("const verResultado = canSeeMargins(me.role);"), "sensibilidad y revaluación son resultado");
  assert.ok(q.includes("const reval = verResultado ? revaluation(docs, cash, tcHoy) : null;"), "sin permiso de márgenes no se calcula");
  // No lleva cartera propia: no hay «mi parte» de una posición de la empresa.
  assert.ok(!q.includes("own_only"), "la posición es de la empresa, no de un vendedor");
  const acl = src("src/lib/erp/acl.ts");
  assert.ok(acl.includes('"/posicion"'), "la ruta tiene módulo propio en pathModule: sin renglón, pathModule la manda a dashboard y la abre cualquier rol");
});
