// REGLA ÚNICA del dueño (2-sep-2026): todo número de negocio se lee de Ajustes
// o de su tabla. Si no está, el sistema se detiene y avisa. Nunca inventa un
// número.
//
// Este archivo barre src/ y falla si alguien vuelve a escribir un número de
// negocio directo en el código: tipo de cambio, TIIE, spread, plazo, umbral,
// margen, comisión o FEGA. Los únicos números permitidos son los que van a una
// tabla como semilla (catalog.ts, que solo importa el sembrado) y los de la
// fórmula (360 días del año), que no son configuración.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** Quita comentarios: los números que describen el Excel en un comentario no deciden dinero. */
function sinComentarios(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:'"`])\/\/.*$/gm, "$1");
}

// Semillas de tabla y textos de ayuda: no calculan nada.
const EXENTOS = new Set(["src/lib/erp/catalog.ts"]);

const ARCHIVOS = walk(join(root, "src"))
  .map((p) => relative(root, p))
  .filter((p) => !EXENTOS.has(p))
  .map((p) => ({ path: p, code: sinComentarios(src(p)) }));

/** Cada patrón lleva el nombre del número de negocio que protege. */
const PROHIBIDOS = [
  // Tipo de cambio 18 (el viejo `useState(18)` / `?? 18`).
  { que: "tipo de cambio 18", re: /useState\(\s*18(\.\d+)?\s*\)/ },
  { que: "tipo de cambio 18", re: /(\?\?|\|\|)\s*18(\.\d+)?\b/ },
  { que: "tipo de cambio 18", re: /\bfx(Rate)?\s*[:=]\s*18(\.\d+)?\b/i },
  // TIIE escrita (7.06%, 16.06% = TIIE + 9%) y la "TIIE por omisión".
  { que: "TIIE 7.06%", re: /\b0\.0706\b/ },
  { que: "TIIE 7.06%", re: /\b7\.06\b/ },
  { que: "TIIE + 9% = 16.06%", re: /\b16\.06\b/ },
  { que: "TIIE por omisión", re: /default_tiie|defaultTiie|DEFAULT_TIIE/ },
  { que: "política de respaldo", re: /DEFAULT_POLICY|POLICY_DEFAULTS|FALLBACK_POLICY/ },
  // Spreads (mora 9%, ASR 4%), comisión 1%, FEGA 2.04%, comisión + FEGA 3.04%.
  { que: "spread de mora 9%", re: /(\?\?|\|\|)\s*0\.09\b/ },
  { que: "spread de mora 9%", re: /\bspread\s*[:=]\s*0\.09\b/i },
  { que: "spread ASR 4%", re: /(\?\?|\|\|)\s*0\.04\b/ },
  { que: "spread ASR 4%", re: /\bspread\s*[:=]\s*0\.04\b/i },
  { que: "comisión 1%", re: /(\?\?|\|\|)\s*0\.01\b/ },
  { que: "comisión 1%", re: /\bcommission(Rate)?\s*[:=]\s*0\.01\b/i },
  { que: "FEGA 2.04%", re: /\b0\.0204\b/ },
  { que: "comisión + FEGA 3.04%", re: /\b0\.0304\b/ },
  { que: "comisión + FEGA 3.04%", re: /\b3\.04\s*%/ },
  { que: "FEGA 2.04%", re: /\b2\.04\s*%/ },
  { que: "spread de mora 9%", re: /\+\s*9\s*%/ },
  // Plazos (30 / 90 / 120 / 150) y umbral de pronto pago (120).
  { que: "plazo 30 / 90 / 120 / 150 días", re: /(\?\?|\|\|)\s*(30|90|120|150)\b/ },
  { que: "plazo 30 / 90 / 120 / 150 días", re: /useState\(\s*(30|90|120|150)\s*\)/ },
  { que: "plazo 30 / 90 / 120 / 150 días", re: /\b(creditDays|invoiceDays|paymentDays|payment_days|credit_days|invoice_days|earlyPayDays|early_pay_days)\s*[:=]\s*(30|90|120|150)\b/ },
  { que: "plazo por omisión en la base", re: /\bdefault\s+(30|90|120|150)\b/i },
  // Margen 12%.
  { que: "margen 12%", re: /(\?\?|\|\|)\s*12\b/ },
  { que: "margen 12%", re: /\bmargin(Pct|_pct)?\s*[:=]\s*12\b/i },
  { que: "margen 12%", re: /\bdefault\s+12\b/i },
  { que: "margen 12%", re: /useState\(\s*12\s*\)/ },
];

test("ningún número de negocio vive en el código (tipo de cambio, TIIE, spread, plazo, umbral, margen, comisión, FEGA)", () => {
  const hallazgos = [];
  for (const { path, code } of ARCHIVOS) {
    const lineas = code.split("\n");
    for (const { que, re } of PROHIBIDOS) {
      lineas.forEach((l, i) => {
        if (re.test(l)) hallazgos.push(`${path}:${i + 1} — ${que}: ${l.trim().slice(0, 120)}`);
      });
    }
  }
  assert.deepEqual(hallazgos, [], `Números de negocio escritos en el código (van en Ajustes o en su tabla):\n${hallazgos.join("\n")}`);
});

test("las semillas de catalog.ts solo las importa el sembrado; nadie calcula con ellas", () => {
  for (const { path, code } of ARCHIVOS) {
    if (path === "src/lib/azagro.ts") continue;
    assert.ok(!/TIIE_SEED|CREDIT_POLICY_CATALOG/.test(code), `${path} usa una semilla de catalog.ts fuera del sembrado`);
  }
  const cat = sinComentarios(src("src/lib/erp/catalog.ts"));
  const politicas = cat.slice(cat.indexOf("export const CREDIT_POLICY_CATALOG"), cat.indexOf("];", cat.indexOf("export const CREDIT_POLICY_CATALOG")));
  assert.ok(!/\d\s*%|spread\s*:|fega_rate\s*:/.test(politicas), "la etiqueta de política de cobro no lleva números: la mora sale de la tabla + Ajustes");
});

test("la TIIE siempre sale de la tabla: nearestRate no acepta respaldo y requireRate se detiene", () => {
  const credit = sinComentarios(src("src/lib/erp/credit.ts"));
  assert.ok(credit.includes("export function nearestRate(table: Array<{ date: string; rate: number }>, asOf: string): RatePick | null"), "nearestRate(tabla, fecha) → renglón o null, sin tercer argumento de respaldo");
  assert.ok(credit.includes("if (!pick) throw new Error(missingRateMessage(asOf, what));"), "requireRate se detiene con mensaje si la tabla no tiene renglón");
  assert.ok(credit.includes("Captúrala en Ajustes → Tabla TIIE antes de continuar."), "el mensaje dice dónde capturarla");
  // Nadie llama nearestRate con un tercer argumento.
  for (const { path, code } of ARCHIVOS) {
    const m = code.match(/nearestRate\([^;]*?\)\s*[;,.)]/g) ?? [];
    for (const call of m) {
      const inner = call.slice("nearestRate(".length);
      let depth = 0;
      let comas = 0;
      for (const ch of inner) {
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === ")" || ch === "]" || ch === "}") {
          if (depth === 0) break;
          depth--;
        } else if (ch === "," && depth === 0) comas++;
      }
      assert.ok(comas <= 1, `${path}: nearestRate con respaldo → ${call.slice(0, 100)}`);
    }
  }
});

test("Ajustes es obligatorio: sin renglón completo el servidor y la pantalla se detienen", () => {
  const ops = sinComentarios(src("src/lib/erp/ops.ts"));
  const lectura = ops.slice(ops.indexOf("export async function readPolicy"), ops.indexOf("export const getSettings"));
  for (const col of ["credit_days", "invoice_days", "fega_rate", "fega_commission", "collection_spread", "asr_commission", "asr_spread", "early_pay_days"]) {
    assert.ok(lectura.includes(col), `readPolicy lee ${col}`);
    assert.ok(!new RegExp(`${col}\\s*\\?\\?\\s*[\\d.]`).test(lectura), `${col} sin respaldo numérico`);
  }
  assert.ok(lectura.includes("if (p.missing.length) throw new Error(missingPolicyMessage(p.missing));"), "policy() truena si falta un renglón");
  const settings = sinComentarios(src("src/routes/settings.tsx"));
  assert.ok(settings.includes("Ajustes incompletos"), "la pantalla de Ajustes avisa qué falta");
  assert.ok(settings.includes('placeholder="sin capturar"'), "un campo vacío se ve vacío, no con un número inventado");
  assert.ok(!settings.includes("TIIE por omisión"), "ya no hay TIIE por omisión");
  for (const ruta of ["src/routes/quotes.tsx", "src/routes/solicitudes.$solicitudId.tsx", "src/routes/credit.tsx"]) {
    const code = sinComentarios(src(ruta));
    assert.ok(code.includes("settingsError"), `${ruta} muestra el error de Ajustes en lugar de operar con números del código`);
  }
});

test("tipo de cambio: se propone el más reciente de la tabla con su fecha; tabla vacía = no se guarda un pedido en dólares", () => {
  const orders = sinComentarios(src("src/lib/erp/orders.ts"));
  assert.ok(orders.includes("Sin tipo de cambio"), "el servidor rechaza un pedido en USD sin TC");
  const form = sinComentarios(src("src/components/order-form.tsx"));
  assert.ok(form.includes("`TC tabla ${lookups.fx.rate} (${lookups.fx.date})`"), "el formulario de pedido dice de qué fecha es el TC propuesto");
  assert.ok(form.includes("Sin tipo de cambio en la tabla"), "y avisa si la tabla está vacía");
  const nuevo = sinComentarios(src("src/routes/sales.nuevo.tsx"));
  assert.ok(nuevo.includes("fxRate: lookups.fx?.rate ?? 0"), "el pedido nuevo arranca con el TC de la tabla o vacío, nunca 18");
  const quotes = sinComentarios(src("src/routes/quotes.tsx"));
  assert.ok(quotes.includes("nearestRate(s.fx.map((r) => ({ date: r.date, rate: Number(r.usd_mxn) })), todayMx())"), "Cotizaciones propone el TC de la tabla");
  assert.ok(quotes.includes("`Dólar pactado (tabla ${fxFrom})`") && quotes.includes('"Dólar pactado (sin tabla)"'), "y muestra la fecha del renglón (o que no hay tabla)");
  const cpo = sinComentarios(src("src/lib/erp/cpo.ts"));
  assert.ok(cpo.includes("Sin tipo de cambio: la tabla está vacía."), "convertir una OC en USD sin TC se detiene");
  assert.ok(!cpo.includes("${1}") && !/values\s*\([^)]*\b1,\s*\$\{plazo\}/.test(cpo), "la OC convertida no lleva TC 1 fijo");
});

test("reportes: una partida sin costo queda FUERA de la utilidad y se cuenta aparte, no entra como 100% de ganancia", () => {
  const rep = sinComentarios(src("src/lib/erp/reports.ts"));
  assert.ok(rep.includes("excluidas"), "el reporte cuenta las partidas excluidas");
  assert.ok(rep.includes("sin costo"), "y dice por qué");
  const pantalla = sinComentarios(src("src/routes/reportes.tsx"));
  assert.ok(pantalla.includes("fuera del cálculo de utilidad"), "la pantalla avisa cuántas quedaron fuera");
});

// Punto 4 del dueño: con TIIE 6.9% en la tabla, costo $10,000 a 150 días debe
// dar $558.71 en todas las rutas. $565.44 solo sale con 7.06%, y el 7.06 ya no
// existe en el código (lo vigila el primer test), así que no puede ganarle a
// la tabla en ninguna pantalla.
const YEAR_DAYS = 360;
const round2 = (n) => Math.round(n * 100) / 100;
function financeBase(i) {
  const cost = Math.max(0, i.cost);
  const commissionRate = Math.max(0, i.commissionRate);
  const rate = Math.max(0, i.tiie) + Math.max(0, i.costSpread);
  return { commission: round2(cost * commissionRate), interestYear: cost * (1 + commissionRate) * rate };
}
function financeFor(base, days) {
  if (days <= 0) return 0;
  return base.commission + round2((base.interestYear * days) / YEAR_DAYS);
}

test("TIIE 6.9% en la tabla → $558.71 a 150 días; $565.44 solo sale con el 7.06 que ya no existe", () => {
  const con69 = financeFor(financeBase({ cost: 10000, tiie: 0.069, costSpread: 0.04, commissionRate: 0.01 }), 150);
  const con706 = financeFor(financeBase({ cost: 10000, tiie: 0.0706, costSpread: 0.04, commissionRate: 0.01 }), 150);
  assert.equal(round2(con69), 558.71);
  assert.equal(round2(con706), 565.44);
  // Las tres rutas toman la TIIE del mismo lugar: el renglón vigente de la tabla.
  const ops = sinComentarios(src("src/lib/erp/ops.ts"));
  assert.ok(ops.includes("const tiieToday = nearestRate(await tiieTableOf(sql, cid), todayMx());"), "Cotizaciones (servidor): tabla, hoy");
  const quotes = sinComentarios(src("src/routes/quotes.tsx"));
  assert.ok(quotes.includes("setTiie(d.tiieToday?.rate ?? 0);") && quotes.includes("setTiieFrom(d.tiieToday?.date ?? null);"), "Cotizaciones (pantalla): la misma TIIE del servidor, con fecha");
  const sol = sinComentarios(src("src/routes/solicitudes.$solicitudId.tsx"));
  assert.ok(sol.includes("nearestRate(") && sol.includes("setTiieFrom("), "Solicitud: tabla, hoy, con fecha");
  assert.ok(!sol.includes("s.tiie[0]"), "Solicitud ya no toma el primer renglón a ciegas");
  const crear = ops.slice(ops.indexOf("export const createQuote"), ops.indexOf("\nexport const", ops.indexOf("export const createQuote") + 10));
  assert.ok(crear.includes('const pick = requireRate(await tiieTableOf(sql, cid), today, "cotización a crédito");'), "crear la cotización a crédito exige renglón de TIIE (se detiene sin él)");
  assert.ok(crear.includes("Math.abs(pick.rate - data.tiie) > 0.000001"), "y no acepta una TIIE distinta a la de la tabla");
  assert.ok(!crear.includes("data.tiie ?? 0"), "la TIIE guardada es la de la tabla, no la que mandó la pantalla");
});
