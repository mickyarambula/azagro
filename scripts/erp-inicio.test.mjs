// EL INICIO — rediseño del tablero (16-sep-2026, `DISENO-INVESTIGACION.md` §
// 2-4). El diagnóstico encontró que las cifras que importan (Caja, Por
// cobrar, Por pagar, Inventario) se pintaban en cuarto lugar, después de 13
// tarjetas de atajo fijas y un diagrama que es un manual, y que "Existencia
// por bodega" listaba TODAS las ubicaciones tuvieran o no existencia. Este
// archivo prueba lo nuevo: `creditExceededSummary` (funcional, PGlite),
// `unitPrice` en `salesLineGaps` (para valuar "entregado sin facturar" en
// dinero), y el cableado de `getDashboard` / `getUpcomingPayable` / la
// pantalla nueva.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pendingMigrations } from "./migration-plan.mjs";
import { creditExceededSummary } from "../src/lib/erp/credit-limit.ts";
import { salesLineGaps } from "../src/lib/erp/parciales.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "migrations");
const src = (p) => readFileSync(join(root, p), "utf8");

function fnBody(source, name) {
  const markers = [`export const ${name} `, `export async function ${name}(`, `export function ${name}(`, `async function ${name}(`, `function ${name}(`];
  const start = markers.map((m) => source.indexOf(m)).find((i) => i !== -1);
  assert.notEqual(start, undefined, `No existe ${name}`);
  const rest = source.slice(start);
  const next = rest.slice(10).search(/\n(export )?(async )?function |\nexport const /);
  return next === -1 ? rest : rest.slice(0, next + 10);
}

function tagOf(db) {
  return async (strings, ...vals) => {
    let text = "";
    strings.forEach((part, i) => {
      text += part;
      if (i < vals.length) text += `$${i + 1}`;
    });
    return (await db.query(text, vals)).rows;
  };
}

async function freshDb() {
  const db = new PGlite();
  for (const { name, path } of pendingMigrations(readdirSync(dir), [])) {
    try {
      await db.exec(readFileSync(join(dir, path), "utf8"));
    } catch (e) {
      assert.fail(`${name}: ${e?.message ?? e}`);
    }
  }
  await db.exec(`insert into companies (id, name, join_code, created_by) values (1, 'Azagro', 'AZ1', 'u1')`);
  return db;
}

// ---------------------------------------------------------------------------
// creditExceededSummary (credit-limit.ts) — paso 6 de PARCIALES.md aplicado
// al inicio: misma cuenta que `creditExposure` (facturado + apartado, sin
// límite capturado no limita, lo cerrado corto no aparta), pero en un solo
// viaje para todos los clientes.
// ---------------------------------------------------------------------------

test("creditExceededSummary: sin ningún cliente con límite capturado, 0 y 0", async () => {
  const db = await freshDb();
  const sql = tagOf(db);
  await db.exec(`insert into partners (company_id, code, name, is_customer, credit_limit, payment_days) values (1, 'CL1', 'Cliente sin límite', true, 0, 30)`);
  const r = await creditExceededSummary(sql, 1);
  assert.deepEqual(r, { n: 0, amount: 0 });
  await db.close();
});

test("creditExceededSummary: facturado abierto por encima del límite cuenta; por debajo no", async () => {
  const db = await freshDb();
  await db.exec(`insert into partners (company_id, code, name, is_customer, credit_limit, payment_days) values (1, 'CL1', 'Sobregirado', true, 100000, 30)`);
  await db.exec(`insert into partners (company_id, code, name, is_customer, credit_limit, payment_days) values (1, 'CL2', 'Al corriente', true, 100000, 30)`);
  await db.exec(`insert into invoices (company_id, kind, name, partner_id, due_date, state, amount, residual, currency) values (1, 'customer', 'FV-0001', 1, current_date, 'open', 150000, 150000, 'MXN')`);
  await db.exec(`insert into invoices (company_id, kind, name, partner_id, due_date, state, amount, residual, currency) values (1, 'customer', 'FV-0002', 2, current_date, 'open', 50000, 50000, 'MXN')`);
  const r = await creditExceededSummary(tagOf(db), 1);
  assert.equal(r.n, 1);
  assert.equal(r.amount, 50000, "150,000 facturado − 100,000 de límite");
  await db.close();
});

test("creditExceededSummary: lo apartado en un pedido confirmado a crédito también cuenta, menos lo ya facturado y lo cerrado corto", async () => {
  const db = await freshDb();
  const sql = tagOf(db);
  await db.exec(`insert into partners (company_id, code, name, is_customer, credit_limit, payment_days) values (1, 'CL1', 'Con pedido', true, 100000, 30)`);
  await db.exec(`insert into products (company_id, code, name) values (1, 'ALB-10', 'Albendazol 10')`);
  await db.exec(`insert into locations (company_id, code, name) values (1, '001', 'Bodega')`);
  await db.exec(`insert into sales_orders (company_id, name, partner_id, date, state, total, term_kind, location_id) values (1, 'PV-0001', 1, current_date, 'confirmed', 120000, 'credit_days', 1)`);
  await db.exec(`insert into sales_lines (so_id, product_id, qty, unit_price) values (1, 1, 100, 1200)`);
  // Pedido de 120,000 sin facturar todavía: 120,000 apartado > 100,000 de límite.
  let r = await creditExceededSummary(sql, 1);
  assert.equal(r.n, 1);
  assert.equal(r.amount, 20000);
  // Se factura la mitad (FV-0001, 60,000 sin cobrar): el apartado BAJA a
  // 60,000 (so.total − facturado) pero lo facturado sube a 60,000 de saldo —
  // el usado total no cambia hasta que se COBRE, no con solo facturar.
  await db.exec(`insert into invoices (company_id, kind, name, partner_id, due_date, state, amount, residual, currency, order_id) values (1, 'customer', 'FV-0001', 1, current_date, 'open', 60000, 60000, 'MXN', 1)`);
  r = await creditExceededSummary(sql, 1);
  assert.equal(r.n, 1);
  assert.equal(r.amount, 20000, "facturar no libera línea; solo cobrar sí");
  // Se cobra la mitad de esa factura (residual baja a 10,000): AHORA sí baja el usado.
  await db.exec(`update invoices set residual = 10000 where name = 'FV-0001'`);
  r = await creditExceededSummary(sql, 1);
  assert.deepEqual(r, { n: 0, amount: 0 }, "10,000 facturado + 60,000 apartado = 70,000, ya cabe en 100,000");
  await db.close();
});

test("creditExceededSummary: un pedido de CONTADO no aparta línea (mismo criterio que creditExposure)", async () => {
  const db = await freshDb();
  await db.exec(`insert into partners (company_id, code, name, is_customer, credit_limit, payment_days) values (1, 'CL1', 'Contado', true, 10000, 30)`);
  await db.exec(`insert into products (company_id, code, name) values (1, 'ALB-10', 'Albendazol 10')`);
  await db.exec(`insert into locations (company_id, code, name) values (1, '001', 'Bodega')`);
  await db.exec(`insert into sales_orders (company_id, name, partner_id, date, state, total, term_kind, location_id) values (1, 'PV-0001', 1, current_date, 'confirmed', 90000, 'contado', 1)`);
  await db.exec(`insert into sales_lines (so_id, product_id, qty, unit_price) values (1, 1, 100, 900)`);
  const r = await creditExceededSummary(tagOf(db), 1);
  assert.deepEqual(r, { n: 0, amount: 0 }, "de contado no financia Azagro: no aparta línea");
  await db.close();
});

// ---------------------------------------------------------------------------
// salesLineGaps: unitPrice — para que el inicio pueda valuar "entregado sin
// facturar" en pesos, no solo en piezas.
// ---------------------------------------------------------------------------

test("salesLineGaps: cada renglón trae unitPrice, y porFacturar × unitPrice da el dinero parado (Decisión 47)", async () => {
  const db = await freshDb();
  const sql = tagOf(db);
  await db.exec(`insert into partners (company_id, code, name, is_customer, payment_days) values (1, 'CL1', 'Cliente', true, 30)`);
  await db.exec(`insert into products (company_id, code, name) values (1, 'ALB-10', 'Albendazol 10')`);
  await db.exec(`insert into locations (company_id, code, name) values (1, '001', 'Bodega')`);
  await db.exec(`insert into sales_orders (company_id, name, partner_id, date, state, total, location_id) values (1, 'PV-0001', 1, current_date, 'confirmed', 15000, 1)`);
  await db.exec(`insert into sales_lines (so_id, product_id, qty, qty_delivered, unit_price) values (1, 1, 10, 10, 1500)`);
  // Entregado 10 de $1,500, cero facturado: porFacturar = 10, dinero parado = 15,000.
  const { porFacturar } = await salesLineGaps(sql, 1);
  assert.equal(porFacturar.length, 1);
  assert.equal(porFacturar[0].unitPrice, 1500);
  assert.equal(porFacturar[0].porFacturar, 10);
  assert.equal(porFacturar[0].porFacturar * porFacturar[0].unitPrice, 15000);
  await db.close();
});

// ---------------------------------------------------------------------------
// getDashboard (azagro.ts) — cableado de lo nuevo.
// ---------------------------------------------------------------------------

test("getDashboard: 'Existencia por bodega' ya no lista ubicaciones vacías (having sobre la suma de existencia)", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "getDashboard");
  assert.match(body, /having coalesce\(sum\(q\.quantity\),0\) > 0\.0001\s*\n\s*order by l\.loc_type, l\.name/, "locStock filtra vacías");
});

test("getDashboard: lowStockList trae código, nombre, existencia y mínimo — antes solo había el conteo", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "getDashboard");
  assert.ok(body.includes("lowStockList: lowList.map"));
  assert.ok(body.includes("select p.code, p.name, coalesce(sum(q.quantity),0)::text as qty, p.min_stock::text as min"));
});

test("getDashboard: vence esta semana (por pagar), límite excedido y entregado sin facturar, todos detrás de seeCredit", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "getDashboard");
  assert.ok(body.includes("payableWeek: seeCredit ? Number(payableWeek[0]?.total ?? 0) : 0"));
  assert.ok(body.includes("due_date >= ${today}::date and due_date <= ${today}::date + 7"), "ventana de 7 días, no de mes");
  assert.ok(body.includes("const creditExceeded = seeCredit ? await creditExceededSummary(sql, cid) : { n: 0, amount: 0 };"));
  assert.ok(body.includes("const porFacturarRows = seeCredit ? (await salesLineGaps(sql, cid)).porFacturar : [];"));
  assert.ok(body.includes("r.porFacturar * r.unitPrice"), "el dinero parado se valúa con el precio de la línea");
});

test("getDashboard: pedidos confirmados sin entregar cuenta lo cerrado corto como resuelto (paso 7)", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "getDashboard");
  assert.ok(body.includes("sl.qty_delivered + coalesce(sl.qty_closed_short,0) < sl.qty - 0.0001"), "pendiente real, no solo qty_delivered < qty");
  assert.ok(body.includes("confirmedNotDeliveredN: confirmedNotDelivered[0]?.n ?? 0"));
  assert.ok(body.includes("confirmedNotDeliveredOldestDays"));
});

// ---------------------------------------------------------------------------
// getUpcomingPayable (reports.ts) — el mismo bucketing de getUpcomingDue,
// del lado de lo que Azagro debe, sin interés (no hay mora a proveedor).
// ---------------------------------------------------------------------------

test("getUpcomingPayable: agrupa por mes de due_date, kind supplier, sin TIIE ni interés", () => {
  const body = fnBody(src("src/lib/erp/reports.ts"), "getUpcomingPayable");
  assert.ok(body.includes("kind = 'supplier' and state = 'open'"));
  assert.ok(!body.includes("tiie_rates"), "no calcula interés: Azagro no le cobra mora al proveedor, el proveedor se la cobraría a Azagro");
  assert.ok(body.includes('inv.due_date.slice(0, 7)'), "mismo bucketing por mes que getUpcomingDue");
  assert.ok(body.includes('inv.due_date < today ? vencido'));
  assert.ok(body.includes('await assertCan(sql, context.userId, "credit", "view")'), "mismo permiso que getUpcomingDue");
});

// ---------------------------------------------------------------------------
// La pantalla (index.tsx) — se van las 13 tarjetas y el diagrama; entra la
// bandeja de atención ordenada por dinero.
// ---------------------------------------------------------------------------

test("index.tsx: las 13 tarjetas de atajo y el diagrama de flujo ya no están en el inicio (el menú y /ayuda ya cubren eso)", () => {
  const s = src("src/routes/index.tsx");
  assert.ok(!s.includes("FAVORITES"), "el grid de atajos se quitó");
  assert.ok(!s.includes("FlujoAzagro"), "el diagrama se quitó de aquí (sigue en /ayuda)");
  const ayuda = src("src/routes/ayuda.tsx");
  assert.ok(ayuda.includes("<FlujoAzagro"), "el diagrama sigue vivo en /ayuda");
});

test("index.tsx: la bandeja de atención muestra los ítems de dinero nuevos, cada uno con su liga", () => {
  const s = src("src/routes/index.tsx");
  for (const campo of ["creditExceededN", "deliveredNotInvoicedN", "confirmedNotDeliveredN", "lowStockList", "payableWeek"]) {
    assert.ok(s.includes(campo), `el inicio debe leer ${campo} de getDashboard`);
  }
});

test("index.tsx: usa getUpcomingPayable además de getUpcomingDue para el bloque de próximos meses", () => {
  const s = src("src/routes/index.tsx");
  assert.ok(s.includes("getUpcomingPayable"));
  assert.ok(s.includes("getUpcomingDue"));
});

// ---------------------------------------------------------------------------
// Defecto real encontrado y corregido al probar en navegador (16-sep-2026):
// `Home` renderizaba <AppShell> y llamaba useAccess() en el MISMO componente
// — useAccess() solo tiene contexto DENTRO de AppShell (mismo patrón ya
// documentado en purchases.tsx, CloseShortPurchaseButton), así que siempre
// devolvía el valor por omisión (rol vacío, sin permisos) y Caja/Por cobrar/
// Por pagar/Inventario nunca aparecían, con cualquier usuario. Ya existía en
// el inicio viejo (verificado restaurando esa versión y probándola).
// ---------------------------------------------------------------------------

test("Home separa el componente que usa useAccess() de quien renderiza AppShell (si no, el contexto siempre da el valor por omisión)", () => {
  const s = src("src/routes/index.tsx");
  const home = fnBody(s, "Home");
  assert.ok(!home.includes("const access = useAccess()"), "Home no debe llamar useAccess() directamente (el comentario de abajo SÍ puede nombrarlo)");
  assert.match(home, /<AppShell>\s*<InicioBody \/>\s*<\/AppShell>/, "Home solo renderiza AppShell con InicioBody adentro");
  const body = fnBody(s, "InicioBody");
  assert.ok(body.includes("useAccess()"), "InicioBody, que SÍ está dentro de AppShell, es quien llama useAccess()");
});
