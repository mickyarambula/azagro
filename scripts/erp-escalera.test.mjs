// Margen sobre el precio de venta y escalera de plazos (3-sep-2026).
//
// Viene de revisar las hojas de cotización reales de la dirección:
//   * Mezcla física para un cliente: COSTO CONTADO 14,420 → CONTADO 15,422.46
//     con margen 6.5%. 14,420 ÷ (1 − 0.065) = 15,422.46 exacto. Un 6.5% sobre
//     costo daría 15,357: el margen es SOBRE EL PRECIO DE VENTA.
//   * El precio a crédito de esa hoja solo cuadra si el financiamiento se suma
//     al costo ANTES de aplicar el margen.
//   * La hoja tiene seis columnas de precio: contado, 30, 60, 90, 120 y 150 días.
//
// Copias literales de src/lib/erp/margins.ts, pricing.ts y ladder.ts; abajo, el
// cableado (Ajustes, servidor, pantallas y documento al cliente).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");
const sinComentarios = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:'"`])\/\/.*$/gm, "$1");

// ---------------------------------------------------------------------------
// Copias
// ---------------------------------------------------------------------------
const YEAR_DAYS = 360;
const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (x) => Math.round(x * 10000) / 10000;
function financeUnit(i) {
  if (i.days <= 0) return 0;
  const cost = Math.max(0, i.cost);
  const rate = i.tiie + i.costSpread;
  const commission = round2(cost * Math.max(0, i.commissionRate));
  const layer1 = round2((cost * (1 + Math.max(0, i.commissionRate)) * rate * Math.max(0, i.days)) / YEAR_DAYS);
  return commission + layer1;
}
function marginValid(m) {
  return m != null && (m.mode === "nominal" || m.pct < 100);
}
function marginUnit(m, landed, finance = 0) {
  if (m.mode === "nominal") return m.nominal;
  if (!marginValid(m)) throw new Error(`Margen ${Number(m.pct)}% sobre el precio: tiene que ser menor a 100%.`);
  const base = landed + Math.max(0, finance);
  return (base * m.pct) / (100 - m.pct);
}
function priceFromMargin(i) {
  const fin = Math.max(0, i.finance);
  return round4(i.landed + fin + marginUnit(i.margin, i.landed, fin));
}
function marginFromPrice(i) {
  const nominal = round4(i.price - i.landed - Math.max(0, i.finance));
  const pct = i.price > 0 ? round4((nominal / i.price) * 100) : 0;
  return { mode: i.mode, pct, nominal };
}
// ladder.ts
function parseTerms(text) {
  if (text == null) return null;
  const parts = String(text)
    .split(/[,\s;/]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const nums = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    nums.push(Number(p));
  }
  return [...new Set(nums)].sort((a, b) => a - b);
}
function ladderTerms(terms, agreed) {
  const all = new Set([0, ...terms.filter((t) => t >= 0)]);
  if (agreed > 0) all.add(agreed);
  return [...all].sort((a, b) => a - b);
}
function ladderFor(i) {
  return ladderTerms(i.terms, i.agreed).map((days) => {
    const margin = days <= 0 ? i.marginCash : i.marginCredit;
    const finance = days <= 0 ? 0 : Math.max(0, i.financeAt(days));
    if (!marginValid(margin)) return { days, finance, price: null, utility: null, pct: null, agreed: days === i.agreed };
    const price = priceFromMargin({ landed: i.landed, finance, margin });
    const utility = round4(price - i.landed - finance);
    return { days, finance, price, utility, pct: price > 0 ? round4((utility / price) * 100) : null, agreed: days === i.agreed };
  });
}

test("las copias siguen iguales al original", () => {
  const m = src("src/lib/erp/margins.ts");
  assert.ok(m.includes("return (base * m.pct) / (100 - m.pct);"), "marginUnit");
  assert.ok(m.includes("return round4(i.landed + fin + marginUnit(i.margin, i.landed, fin));"), "priceFromMargin");
  assert.ok(m.includes("const pct = i.price > 0 ? round4((nominal / i.price) * 100) : 0;"), "marginFromPrice");
  const l = src("src/lib/erp/ladder.ts");
  assert.ok(l.includes("const margin = days <= 0 ? i.marginCash : i.marginCredit;"), "contado → margen contado; a plazo → margen crédito");
  assert.ok(l.includes("const all = new Set<number>([0, ...terms.filter((t) => t >= 0)]);"), "contado siempre va");
  assert.ok(l.includes("if (agreed > 0) all.add(agreed);"), "el plazo acordado siempre va");
  assert.ok(l.includes('.split(/[,\\s;/]+/)'), "parseTerms acepta comas, espacios o diagonales");
});

// ---------------------------------------------------------------------------
// 1. La fórmula, con los números del dueño.
// ---------------------------------------------------------------------------
test("hoja real: costo contado 14,420 con margen 6.5% → 15,422.46 (margen sobre el precio, no sobre el costo)", () => {
  const p = priceFromMargin({ landed: 14420, finance: 0, margin: { mode: "pct", pct: 6.5, nominal: 0 } });
  assert.equal(p, 15422.4599); // 14,420 ÷ 0.935 (a 4 decimales)
  assert.equal(round2(p), 15422.46);
  // Sobre costo habría dado 15,357: ya no.
  assert.equal(round2(14420 * 1.065), 15357.3);
  assert.notEqual(round2(p), 15357.3);
  // La utilidad es 6.5% del precio.
  assert.ok(Math.abs((p - 14420) / p - 0.065) < 0.000001);
});

test("caso de prueba: costo puesto 10,000, TIIE 6.9%, 150 d, margen crédito 6.5% → fin 558.71, precio 11,292.74, utilidad 734.03", () => {
  const fin = financeUnit({ cost: 10000, days: 150, tiie: 0.069, costSpread: 0.04, commissionRate: 0.01 });
  assert.equal(round2(fin), 558.71, "el financiamiento NO cambia");
  const precio = priceFromMargin({ landed: 10000, finance: fin, margin: { mode: "pct", pct: 6.5, nominal: 0 } });
  assert.equal(round2(precio), 11292.74);
  const utilidad = round2(precio - 10000 - fin);
  assert.equal(utilidad, 734.03);
  assert.equal(round2(precio * 0.065), 734.03, "que es 6.5% del precio");
  // Contado con margen 5%: 10,000 ÷ 0.95.
  assert.equal(round2(priceFromMargin({ landed: 10000, finance: 0, margin: { mode: "pct", pct: 5, nominal: 0 } })), 10526.32);
});

test("margen en monto fijo: precio = costo puesto + financiamiento + monto, misma utilidad por las dos vías", () => {
  const fin = 558.71;
  const fijo = priceFromMargin({ landed: 10000, finance: fin, margin: { mode: "nominal", pct: 0, nominal: 734.03 } });
  assert.equal(fijo, 11292.74);
  const pct = priceFromMargin({ landed: 10000, finance: fin, margin: { mode: "pct", pct: 6.5, nominal: 0 } });
  assert.ok(Math.abs(fijo - pct) < 0.01, "el mismo precio que con 6.5% del precio");
});

test("captura inversa: del precio final se despeja el margen con la fórmula nueva, y de regreso da el mismo precio", () => {
  const fin = 558.71;
  const m = marginFromPrice({ price: 11292.74, landed: 10000, finance: fin, mode: "pct" });
  assert.equal(m.nominal, 734.03);
  assert.equal(m.pct, 6.5);
  assert.ok(Math.abs(priceFromMargin({ landed: 10000, finance: fin, margin: m }) - 11292.74) < 0.01);
  // Contado: 10,526.32 → 5% (del precio).
  const c = marginFromPrice({ price: 10526.32, landed: 10000, finance: 0, mode: "pct" });
  assert.equal(c.pct, 5);
});

test("un margen % de 100 o más no da precio: se detiene, no se inventa", () => {
  assert.throws(() => priceFromMargin({ landed: 10000, finance: 0, margin: { mode: "pct", pct: 100, nominal: 0 } }), /menor a 100%/);
  assert.equal(marginValid({ mode: "pct", pct: 99.99, nominal: 0 }), true);
  assert.equal(marginValid({ mode: "pct", pct: -5, nominal: 0 }), true, "negativo sí: vender con pérdida a propósito se avisa, no se bloquea");
  const req = sinComentarios(src("src/lib/erp/requests.ts"));
  assert.ok(req.includes('marginPct: z.number().lt(100, "El margen % sobre el precio tiene que ser menor a 100.")'), "saveLineMargin rechaza 100% o más");
  assert.ok(req.includes("Corrige el margen antes de cotizar."), "quoteFromRequest se detiene con margen inválido");
  const orders = sinComentarios(src("src/lib/erp/orders.ts"));
  assert.ok(orders.includes("throw new Error(`${l.code}: ${e instanceof Error ? e.message : String(e)}`);"), "cambiar plazo se detiene diciendo qué partida");
});

// ---------------------------------------------------------------------------
// 2. La escalera.
// ---------------------------------------------------------------------------
const TERMS = [0, 30, 60, 90, 120, 150];
const finAt = (days) => financeUnit({ cost: 10000, days, tiie: 0.069, costSpread: 0.04, commissionRate: 0.01 });

test("escalera: contado con el margen de contado y cada plazo con el margen de crédito", () => {
  const steps = ladderFor({
    terms: TERMS,
    agreed: 150,
    landed: 10000,
    marginCash: { mode: "pct", pct: 5, nominal: 0 },
    marginCredit: { mode: "pct", pct: 6.5, nominal: 0 },
    financeAt: finAt,
  });
  assert.deepEqual(steps.map((s) => s.days), TERMS, "seis columnas, como la hoja real");
  assert.equal(round2(steps[0].price), 10526.32, "contado con 5%");
  assert.equal(steps[0].finance, 0);
  assert.equal(steps[5].agreed, true);
  assert.equal(round2(steps[5].price), 11292.74, "150 d con 6.5%");
  assert.equal(round2(steps[5].finance), 558.71);
  assert.equal(round2(steps[5].utility), 734.03);
  assert.equal(steps[5].pct, 6.5);
  // Cada columna a plazo lleva el mismo 6.5% del precio; solo cambia el financiamiento.
  for (const s of steps.slice(1)) {
    assert.equal(s.pct, 6.5, `${s.days} d`);
    assert.equal(round2(s.price), round2((10000 + s.finance) / 0.935), `${s.days} d = (costo + fin) ÷ 0.935`);
  }
  // Y sube con los días: más financiamiento, más precio.
  for (let i = 2; i < steps.length; i++) assert.ok(steps[i].price > steps[i - 1].price);
  assert.equal(round2(steps[1].price), round2((10000 + 100 + round2((10000 * 1.01 * 0.109 * 30) / 360)) / 0.935), "30 d: fin = 100 + 91.74");
});

test("escalera: el plazo acordado se mete aunque no esté en la lista, y sin margen la columna queda en —", () => {
  const steps = ladderFor({ terms: TERMS, agreed: 45, landed: 10000, marginCash: { mode: "pct", pct: 5, nominal: 0 }, marginCredit: null, financeAt: finAt });
  assert.deepEqual(steps.map((s) => s.days), [0, 30, 45, 60, 90, 120, 150]);
  assert.equal(steps.find((s) => s.days === 45).agreed, true);
  assert.ok(steps.slice(1).every((s) => s.price === null && s.utility === null), "sin margen de crédito no hay precio a plazo: no se inventa");
  assert.ok(steps[0].price > 0, "el contado sí tiene su margen");
  const invalido = ladderFor({ terms: TERMS, agreed: 150, landed: 10000, marginCash: null, marginCredit: { mode: "pct", pct: 120, nominal: 0 }, financeAt: finAt });
  assert.ok(invalido.every((s) => s.price === null), "margen ≥ 100% tampoco da precio");
});

test("parseTerms: la lista de Ajustes se lee tolerante, ordenada y sin repetidos; vacía o con basura es null", () => {
  assert.deepEqual(parseTerms("0, 30, 60, 90, 120, 150"), TERMS);
  assert.deepEqual(parseTerms("150 / 30 / 0 / 30"), [0, 30, 150]);
  assert.deepEqual(parseTerms("45"), [45]);
  assert.equal(parseTerms(""), null);
  assert.equal(parseTerms("30, x"), null);
  assert.equal(parseTerms(null), null);
});

// ---------------------------------------------------------------------------
// 3. Cableado.
// ---------------------------------------------------------------------------
test("Ajustes: la escalera vive en company_settings.quote_terms (migración 0020), se lee con la política y se edita en la pantalla", () => {
  const mig = src("migrations/0020_escalera_plazos.sql");
  assert.ok(mig.includes("alter table company_settings add column if not exists quote_terms text;"), "columna");
  assert.ok(mig.includes("set default '0,30,60,90,120,150'"), "lista inicial del dueño para renglones nuevos");
  assert.ok(mig.includes("where quote_terms is null"), "y para los que ya existían, sin pisar una capturada");
  const ops = sinComentarios(src("src/lib/erp/ops.ts"));
  assert.ok(ops.includes('export const QUOTE_TERMS_LABEL = "escalera de plazos (días)";'), "etiqueta en 'Ajustes incompletos'");
  assert.ok(ops.includes("quoteTerms: z.string(),"), "saveSettings la recibe");
  assert.ok(ops.includes("const terms = parseTerms(data.quoteTerms);"), "y la valida");
  assert.ok(ops.includes("quote_terms = excluded.quote_terms"), "y la guarda");
  assert.ok(ops.includes("changes.push(`escalera de plazos ${antesTerms ?? \"sin capturar\"} → ${termsText}`)"), "bitácora anterior → nuevo");
  assert.ok(ops.includes("quoteTerms: quoteTerms ?? []"), "policy() la entrega ya validada (si falta, ya tronó antes)");
  const settings = sinComentarios(src("src/routes/settings.tsx"));
  assert.ok(settings.includes("Escalera de plazos de la cotización (días separados por coma; 0 = contado)"), "campo en Ajustes");
  assert.ok(settings.includes("setQuoteTerms(s.quoteTerms ? formatTerms(s.quoteTerms) : \"\")"), "se muestra lo guardado, vacío si no hay");
  assert.ok(settings.includes("Precio de venta por unidad = (costo puesto + financiamiento) ÷ (1 − margen %)"), "la ayuda dice la fórmula nueva");
  const rules = src("src/lib/erp/rules.ts");
  assert.ok(rules.includes('id: "margin"') && rules.includes('id: "ladder"'), "reglas de negocio: margen sobre precio y escalera");
});

test("servidor: listQuotes arma la escalera por partida con el costo real y las tasas de la COT, igual para todos los roles", () => {
  const ops = sinComentarios(src("src/lib/erp/ops.ts"));
  const fn = ops.slice(ops.indexOf("export const listQuotes"), ops.indexOf("export const createQuote"));
  assert.ok(fn.includes("ladder: ladderFor({"), "escalera por partida");
  assert.ok(fn.includes("terms: pol.quoteTerms,"), "plazos de Ajustes");
  assert.ok(fn.includes("agreed: l.q_days,"), "más el acordado");
  assert.ok(fn.includes('marginCash: marginOf(l, "cash"),') && fn.includes('marginCredit: marginOf(l, "credit"),'), "dos márgenes");
  assert.ok(fn.includes("days === l.q_days ? stored : financeUnit({ cost: landed, days, tiie: Number(l.q_tiie), costSpread: Number(l.q_spread), commissionRate: pol.asrCommission })"), "financiamiento por columna con TIIE/spread de la COT; el acordado usa el guardado");
  assert.ok(fn.includes("ladder: l.ladder.map((s) => ({ ...s, utility: null, pct: null }))"), "a quien no ve márgenes se le esconde utilidad y %, no el precio");
  assert.ok(fn.indexOf("...ladderOf(l)") < fn.indexOf("if (!canSeeCosts(me.role))"), "se calcula antes de esconder el costo");
  assert.ok(fn.includes("terms: pol.quoteTerms }"), "la pantalla recibe la lista de plazos");
  // Alta manual: contado + financiamiento = misma utilidad en pesos → margen en $ fijo.
  const crear = ops.slice(ops.indexOf("export const createQuote"), ops.indexOf("export const reviseQuote"));
  assert.ok(crear.includes('marginFromPrice({ price: line.cash, landed, finance: 0, mode: "nominal" })'), "alta manual: margen contado en $ fijo");
  assert.ok(crear.includes('marginFromPrice({ price: line.credit, landed, finance: fin, mode: "nominal" })'), "y el de crédito también");
});

test("pantalla de la cotización: escalera interna en vivo, plazo acordado editable, y la revisión lo manda", () => {
  const q = src("src/routes/quotes.tsx");
  assert.ok(q.includes("function ladderOfLine("), "escalera por partida en la pantalla");
  assert.ok(q.includes("Escalera de plazos (interna, no sale al cliente)"), "dice que es interna");
  assert.ok(q.includes("const agreedDays = revDays ?? qrow.credit_days;"), "plazo acordado en edición");
  assert.ok(q.includes("onChange={(e) => changeDays(Number(e.target.value))}"), "selector de plazo acordado");
  assert.ok(q.includes("if (st?.price != null) next[l.product_id] = { ...rp, credit: st.price };"), "cambiar el plazo toma la columna de la escalera");
  assert.ok(q.includes("creditDays: agreedDays,"), "la revisión guarda el plazo nuevo");
  assert.ok(q.includes("Crédito {agreedDays} d"), "la columna de crédito es la del plazo en edición");
  assert.ok(q.includes("const daysDirty = revDays != null && revDays !== qrow.credit_days;"), "cambiar el plazo cuenta como cambio");
  // En vivo cuando se ve el costo; si no, la escalera del servidor.
  assert.ok(q.includes("marginCredit: marginFromPrice({ price: rp.credit, landed, finance: finAt(agreed), mode: creditMode }),"), "el margen de crédito sale del precio capturado y aplica a todas las columnas");
  assert.ok(q.includes("price: st.days === 0 ? rp.cash : st.days === agreed ? rp.credit : st.price,"), "sin costo visible: escalera del servidor");
});

test("documento al cliente: SOLO contado y el plazo acordado; la escalera no sale", () => {
  const q = src("src/routes/quotes.tsx");
  const doc = q.slice(q.indexOf("async function printQuote"), q.indexOf("return (\n    <AppShell>"));
  // 4-sep-2026: el papel lleva UN solo precio, el de la oferta acordada (un
  // papel con dos precios invita a pedir el de contado y se queda archivado).
  // Los dos precios siguen en pantalla.
  assert.ok(doc.includes("const offer = paperOfferOf(qrow);"), "un solo precio en el papel: el de la oferta acordada");
  assert.ok(!doc.includes('"Imp. contado", "P. crédito"'), "nunca los dos en el papel");
  assert.ok(doc.includes('["Producto", "Cant.", "P. unitario", "Importe"]'), "uno cuando la oferta es uno");
  assert.ok(!doc.includes("ladder"), "la escalera no entra al documento");
  assert.ok(doc.includes("paperOfferLabel(offer, qrow.credit_days)") && q.includes("`Crédito ${creditDays ?? 0} d`"), "el plazo acordado va en el encabezado");
  assert.ok(doc.includes('offer === "cash" ? Number(l.cash_price) : Number(l.credit_price)'), "y el precio a crédito es el guardado para ese plazo");
});

test("solicitud: la escalera se ve por partida con precio, financiamiento y utilidad, y el margen de crédito aplica a todos los plazos", () => {
  const sol = src("src/routes/solicitudes.$solicitudId.tsx");
  assert.ok(sol.includes("const steps = ladderFor({ terms, agreed: days, landed, marginCash: mCash, marginCredit: mCredit, financeAt: finAt });"), "escalera por partida");
  assert.ok(sol.includes("setTerms(s.quoteTerms);"), "plazos de Ajustes");
  assert.ok(sol.includes("{st.days > 0 ? `fin ${money(st.finance)} · ` : \"\"}util {money(st.utility ?? 0)} ({(st.pct ?? 0).toFixed(1)}%)"), "cada columna con financiamiento y utilidad");
  assert.ok(sol.includes("Precio = (costo puesto + financiamiento) ÷ (1 − margen %)"), "la fórmula a la vista");
  assert.ok(sol.includes("Al cliente solo le llegan dos precios: contado"), "y aclara qué le llega al cliente");
});
