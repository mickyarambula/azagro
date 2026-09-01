import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

// ---------------------------------------------------------------------------
// Fecha de operación de Azagro: Los Mochis (America/Mazatlan, UTC-7 fijo).
// Copia de todayMx en src/lib/utils.ts y de addDays en src/lib/erp/credit.ts.
// Si cambia el motor, actualiza aquí y piensa por qué.
// ---------------------------------------------------------------------------
const AZAGRO_TZ = "America/Mazatlan";
function todayMx(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: AZAGRO_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function addDays(iso, days) {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
const utcDay = (d) => d.toISOString().slice(0, 10);

test("6:00 p.m. en Los Mochis: en UTC ya es mañana, pero la fecha de negocio sigue siendo hoy", () => {
  // 18:00 del 1 sep en Mazatlán = 01:00Z del 2 sep.
  const now = new Date("2026-09-02T01:00:00Z");
  assert.equal(utcDay(now), "2026-09-02", "la forma vieja (UTC) daba el día siguiente — ese era el bug");
  assert.equal(todayMx(now), "2026-09-01");
});

test("4:59 p.m. en Los Mochis (23:59Z): las dos formas coinciden, no hay corrimiento antes de las 5", () => {
  const now = new Date("2026-09-01T23:59:00Z");
  assert.equal(utcDay(now), "2026-09-01");
  assert.equal(todayMx(now), "2026-09-01");
});

test("justo a las 5:00 p.m. (00:00Z) empieza el problema en UTC; todayMx sigue en el día correcto", () => {
  const now = new Date("2026-09-02T00:00:00Z");
  assert.equal(utcDay(now), "2026-09-02");
  assert.equal(todayMx(now), "2026-09-01");
});

test("sin horario de verano: 6:00 p.m. de julio también sigue siendo el mismo día (UTC-7, no UTC-6)", () => {
  // 18:00 del 15 jul en Mazatlán = 01:00Z del 16 jul. Con DST (UTC-6) serían 19:00.
  const now = new Date("2026-07-16T01:00:00Z");
  assert.equal(todayMx(now), "2026-07-15");
});

test("cruce de año: 6:00 p.m. del 31 de diciembre no se convierte en 1 de enero", () => {
  const now = new Date("2027-01-01T01:00:00Z");
  assert.equal(utcDay(now), "2027-01-01");
  assert.equal(todayMx(now), "2026-12-31");
});

test("a las 11:59 p.m. de Los Mochis todavía es hoy; a las 12:00 a.m. ya es mañana", () => {
  assert.equal(todayMx(new Date("2026-09-02T06:59:59Z")), "2026-09-01");
  assert.equal(todayMx(new Date("2026-09-02T07:00:00Z")), "2026-09-02");
});

test("todayMx no depende del timezone del servidor: mismo resultado en UTC, Mazatlán y UTC+14", () => {
  // Se lanza un node aparte con TZ distinto para probar que el proceso donde
  // corre (Vercel en UTC, una Mac en Sinaloa, lo que sea) no cambia la respuesta.
  const code = `
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mazatlan", year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date("2026-09-02T01:00:00Z"));
    const g = (t) => p.find((x) => x.type === t).value;
    process.stdout.write(g("year") + "-" + g("month") + "-" + g("day"));
  `;
  for (const tz of ["UTC", "America/Mazatlan", "Pacific/Kiritimati", "America/Sao_Paulo"]) {
    const out = execFileSync(process.execPath, ["-e", code], { env: { ...process.env, TZ: tz } }).toString();
    assert.equal(out, "2026-09-01", `con TZ=${tz} debe seguir dando el 1 de septiembre`);
  }
});

test("addDays (vencimientos por plazo) es aritmética pura: no se recorre aunque el servidor esté en otro huso", () => {
  assert.equal(addDays("2026-09-01", 30), "2026-10-01");
  assert.equal(addDays("2026-09-01", 150), "2027-01-29");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29", "bisiesto");
  assert.equal(addDays("2026-09-01", 0), "2026-09-01");
  const code = `
    const addDays = (iso, days) => { const [y, m, d] = iso.slice(0, 10).split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10); };
    process.stdout.write(addDays("2026-09-01", 150) + " " + addDays("2026-12-31", 1));
  `;
  for (const tz of ["UTC", "America/Mazatlan", "Pacific/Kiritimati", "Europe/Madrid"]) {
    const out = execFileSync(process.execPath, ["-e", code], { env: { ...process.env, TZ: tz } }).toString();
    assert.equal(out, "2027-01-29 2027-01-01", `con TZ=${tz}`);
  }
});

test("ejemplo completo: pedido a 150 días entregado a las 6:00 p.m. del 1 sep vence el 29 ene, no el 30", () => {
  const entregado = todayMx(new Date("2026-09-02T01:00:00Z"));
  assert.equal(addDays(entregado, 150), "2027-01-29");
  // Con la forma vieja la factura habría quedado fechada el 2 sep y vencería el 30 ene:
  assert.equal(addDays(utcDay(new Date("2026-09-02T01:00:00Z")), 150), "2027-01-30");
});

// ---------------------------------------------------------------------------
// Cableado: el único lugar donde se decide "hoy" es todayMx en src/lib/utils.ts.
// ---------------------------------------------------------------------------
function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(f)) out.push(p);
  }
  return out;
}
const files = walk(join(root, "src")).map((p) => [p.slice(root.length + 1), readFileSync(p, "utf8")]);
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("cableado: todayMx existe una sola vez, en src/lib/utils.ts, y todayISO ya no existe", () => {
  const utils = src("src/lib/utils.ts");
  assert.ok(utils.includes("export function todayMx(now: Date = new Date()): string"));
  assert.ok(utils.includes('timeZone: AZAGRO_TZ'), "debe usar la zona de Azagro, no la del servidor");
  const defs = files.filter(([, s]) => /function todayMx\b/.test(s)).map(([p]) => p);
  assert.deepEqual(defs, ["src/lib/utils.ts"]);
  for (const [p, s] of files) assert.ok(!/todayISO/.test(s), `${p}: todayISO (UTC) ya no debe existir`);
});

test("cableado: nadie en src calcula 'hoy' con toISOString (UTC) fuera de todayMx", () => {
  for (const [p, s] of files) {
    const body = stripComments(s);
    const hits = body.match(/new Date\(\)\.toISOString\(\)\.slice\(0,\s*10\)/g) ?? [];
    assert.equal(hits.length, 0, `${p}: usa todayMx() en lugar de new Date().toISOString().slice(0, 10)`);
    // Aritmética local (setDate/getDate) sobre new Date() para fechas de negocio.
    assert.ok(!/const \w+ = new Date\(\);\s*\n\s*\w+\.setDate\(/.test(body), `${p}: usa addDays(todayMx(), n) en lugar de setDate`);
  }
});

test("cableado: los sellos de tiempo de auditoría siguen en UTC (no pasan por todayMx)", () => {
  // Estos son instantes (timestamptz), no fechas de negocio: se guardan en UTC
  // y solo se convierten al mostrar con dateTimeMx.
  const audit = src("src/lib/erp/audit.ts");
  assert.ok(audit.includes("created_at timestamptz not null default now()"));
  assert.ok(!audit.includes("todayMx"), "la bitácora no debe fechar con la fecha de negocio");
  const orders = src("src/lib/erp/orders.ts");
  assert.ok(orders.includes("guia_sign_at = ${sign ? new Date().toISOString() : null}"), "la firma de guía es un instante UTC");
  const cutover = src("src/lib/erp/cutover.ts");
  assert.ok(cutover.includes("at: new Date().toISOString()"), "el sello del respaldo es un instante UTC");
});

test("cableado: ningún SQL usa current_date (día en UTC en Neon) salvo como default de columna", () => {
  for (const [p, s] of files) {
    const lines = s.split("\n");
    lines.forEach((line, i) => {
      if (!/current_date/.test(line)) return;
      const isColumnDefault = /\bdate not null default current_date/.test(line);
      const isComment = /^\s*(\/\/|\*)/.test(line);
      assert.ok(isColumnDefault || isComment, `${p}:${i + 1}: current_date en una consulta — pásale ${"${today}"}::date desde todayMx()`);
    });
  }
});

test("cableado: todo insert a una tabla con 'date default current_date' manda la fecha explícita", () => {
  // Si el insert no manda date, Postgres pone current_date (UTC en Neon) y
  // el documento puede quedar fechado mañana después de las 5 p.m.
  const tables = {
    stock_moves: "date",
    purchase_orders: "date",
    sales_orders: "date",
    invoices: "date",
    payments: "date",
    bank_moves: "date",
    quotes: "date",
    expenses: "date",
    customer_requests: "date",
    customer_pos: "po_date",
  };
  let seen = 0;
  for (const [p, s] of files) {
    const re = /insert into (\w+)\s*\(([^)]*)\)/g;
    let m;
    while ((m = re.exec(s))) {
      const col = tables[m[1]];
      if (!col) continue;
      seen++;
      const cols = m[2].split(",").map((c) => c.trim());
      assert.ok(cols.includes(col), `${p}: insert into ${m[1]} debe mandar la columna ${col} (todayMx o la fecha capturada)`);
    }
  }
  assert.ok(seen >= 20, `se esperaban al menos 20 inserts revisados, hubo ${seen}`);
});

test("cableado: las fechas por omisión de FV, FP, NC, pago de devolución, kardex y corte usan todayMx", () => {
  const azagro = src("src/lib/azagro.ts");
  // deliverSale: la FV lleva date = today explícito
  assert.ok(/company_id, kind, name, partner_id, date, due_date, credit_due, state/.test(azagro), "FV debe llevar columna date");
  // returnSale: NC, pago y kardex con el mismo `today`
  assert.ok(/paid_date = \$\{today\} where id = \$\{nc\[0\]!\.id\}/.test(azagro), "paid_date de la NC ya no usa current_date");
  const ops = src("src/lib/erp/ops.ts");
  assert.ok(ops.includes("const asOf = (data.asOf || todayMx()).slice(0, 10);"), "corte por omisión del estado de cuenta");
  assert.ok(ops.includes("const asOf = (opts?.asOf || todayMx()).slice(0, 10);"), "corte por omisión de la FI");
  assert.ok(ops.includes("const payDate = (opts.date || today).slice(0, 10);") && ops.includes("const today = todayMx();"), "fecha de cobro por omisión");
  const stock = src("src/lib/erp/stock.ts");
  assert.ok(stock.includes("const day = (opts.date || todayMx()).slice(0, 10);"), "fecha del movimiento de kardex por omisión");
  assert.ok(stock.includes("paid_date = coalesce(paid_date, ${todayMx()}::date)"), "paid_date al liquidar");
  const credit = src("src/lib/erp/credit.ts");
  assert.ok(credit.includes("const asOf = (input.asOf || todayMx()).slice(0, 10);"));
  assert.ok(credit.includes("const today = (asOf || todayMx()).slice(0, 10);"));
});

test("cableado: las pantallas proponen la fecha de hoy con todayMx (no con el reloj UTC del navegador)", () => {
  for (const f of [
    "src/routes/banks.tsx",
    "src/routes/gastos.tsx",
    "src/routes/purchases.tsx",
    "src/routes/cpo.tsx",
    "src/routes/credit.tsx",
    "src/routes/sales.nuevo.tsx",
    "src/routes/reportes.tsx",
    "src/routes/quotes.tsx",
    "src/routes/settings.tsx",
    "src/routes/vencimientos.tsx",
    "src/routes/statements.tsx",
  ]) {
    assert.ok(src(f).includes("todayMx"), `${f} debe usar todayMx`);
  }
});
