// @ts-check
/**
 * BLOQUE C4 — Borrado de datos de prueba: EL PLAN (BORRADO-PRUEBAS.md § 2-3).
 *
 * JS plano, sin dependencias, importable por la app (`src/lib/erp/purge.ts`,
 * paso 4) y por las pruebas (`scripts/erp-borrado-pruebas.test.mjs`), igual que
 * `migration-plan.mjs`. Aquí vive TODA la SQL del borrado: el paso 4 la itera,
 * no escribe SQL propia (una prueba lo vigila). Es la única excepción al
 * principio "no se borra, se agregan movimientos contrarios" (`DESHACER.md`,
 * Decisiones 15 y 16), y por eso está confinada a este archivo.
 *
 * Qué es "dato de prueba": todo lo capturado en la app que NO es del corte de
 * Compaq (§ 1). Solo el corte tiene marca — `invoices.cutover_key` y los
 * `stock_moves` `opening` con origin 'Corte Compaq' —; lo demás no se puede
 * distinguir, y esa definición solo vale mientras no arranque la operación
 * real (candado `company_settings.live_since`, paso 4).
 *
 * Todo lleva `where company_id = $1`: una empresa a la vez, nunca la tabla
 * entera. Las tablas hijas (sin company_id) caen por `on delete cascade` desde
 * su padre; están listadas en `children` para que la prueba "ninguna tabla
 * olvidada" pueda clasificar cada `create table` del repo.
 *
 * El orden importa: Postgres verifica las llaves foráneas al final de cada
 * sentencia, muchas ligas dentro de la empresa son SIN cascada, y hay un ciclo
 * (`bank_moves.expense_id` ↔ `expenses.bank_move_id`) que se rompe primero.
 */

/** Tablas que SE CONSERVAN (§ 2 "Se conserva"). Motivo por tabla. */
export const KEEP = [
  { table: "companies", why: "la empresa" },
  { table: "company_settings", why: "Ajustes (y el candado live_since)" },
  { table: "members", why: "personas" },
  { table: "member_acl", why: "permisos por persona (hija de members)" },
  { table: "member_favorites", why: "estrella del menú por persona (hija de members)" },
  { table: "access_requests", why: "solicitudes de acceso" },
  { table: "user", why: "auth (better-auth)" },
  { table: "session", why: "auth (better-auth)" },
  { table: "account", why: "auth (better-auth)" },
  { table: "verification", why: "auth (better-auth)" },
  { table: "partners", why: "catálogo: clientes y proveedores" },
  { table: "partner_contacts", why: "catálogo: contactos" },
  { table: "partner_groups", why: "catálogo: grupos" },
  { table: "partner_products", why: "catálogo: qué vende cada proveedor" },
  { table: "products", why: "catálogo (su `cost` se recalcula: REBUILD)" },
  { table: "product_kinds", why: "catálogo" },
  { table: "uoms", why: "catálogo" },
  { table: "locations", why: "bodegas" },
  { table: "banks", why: "bancos, con su saldo inicial `opening`" },
  { table: "expense_categories", why: "catálogo de gastos" },
  { table: "credit_policies", why: "Ajustes: políticas de cobro" },
  { table: "credit_circuits", why: "Ajustes: circuitos" },
  { table: "tiie_rates", why: "tabla de tasas" },
  { table: "fx_rates", why: "tabla de tipos de cambio" },
  { table: "funding_rates", why: "tabla de tasas de fondeo" },
  { table: "audit_log", why: "bitácora completa (Decisión 55)" },
  { table: "_migrations", why: "control de migraciones" },
];

/**
 * El candado, ANTES de la primera sentencia. Todo el borrado cuelga de `$1`:
 * un company_id equivocado borraría la operación de otra empresa. Por eso el
 * plan mismo (no quien lo llama) verifica que la empresa exista, la bloquea
 * (`for update` en `companies` y en `company_settings`, así dos borrados o un
 * borrado y un "Arrancó la operación real" simultáneos se forman uno tras otro
 * y el segundo relee `live_since` ya escrito), y se niega si ya arrancó la
 * operación real — con el mensaje que nombra la salida (§ 4.2, B3). Devuelve
 * el nombre de la empresa: el paso 4 lo exige tecleado antes de disparar.
 *
 * Una empresa sin renglón de Ajustes se trata como "todavía en pruebas"
 * (live_since nulo): el candado solo lo prende un administrador, nunca la
 * ausencia del renglón.
 */
export const GUARD = {
  company: "select id, name from companies where id = $1 for update",
  settings: "select live_since from company_settings where company_id = $1 for update",
};

export function liveSinceMessage(name, liveSince) {
  const when = liveSince instanceof Date ? liveSince.toISOString().slice(0, 10) : String(liveSince).slice(0, 10);
  return (
    `La empresa «${name}» arrancó la operación real el ${when}: los datos de prueba ya no se pueden borrar. ` +
    `Si se marcó por error y no se ha capturado nada real, usa «Regresar a pruebas» en esta misma pantalla.`
  );
}

/** @returns {Promise<{ id: number, name: string, liveSince: unknown }>} */
export async function purgeGuard(run, companyId) {
  if (!Number.isInteger(companyId) || companyId <= 0) throw new Error(`Empresa inválida: ${String(companyId)}`);
  const company = await run(GUARD.company, [companyId]);
  if (!company[0]) throw new Error(`No existe la empresa ${companyId}: no hay nada que borrar.`);
  const settings = await run(GUARD.settings, [companyId]);
  const liveSince = settings[0]?.live_since ?? null;
  if (liveSince !== null && liveSince !== undefined) throw new Error(liveSinceMessage(company[0].name, liveSince));
  return { id: Number(company[0].id), name: String(company[0].name), liveSince: null };
}

/**
 * Lo que SE BORRA, en este orden. `sql` es la sentencia literal, con `$1` =
 * company_id. `children` = tablas sin company_id que caen en cascada con ésta.
 * `kind` = 'delete' salvo el primer paso, que es un `update` (rompe el ciclo).
 */
export const PURGE = [
  {
    step: 1,
    table: "expenses",
    kind: "update",
    why: "rompe el ciclo bank_moves.expense_id ↔ expenses.bank_move_id (0008)",
    sql: "update expenses set bank_move_id = null where company_id = $1 and bank_move_id is not null",
  },
  { step: 2, table: "bank_moves", kind: "delete", sql: "delete from bank_moves where company_id = $1" },
  { step: 3, table: "expenses", kind: "delete", sql: "delete from expenses where company_id = $1" },
  { step: 4, table: "payments", kind: "delete", children: ["payment_allocs"], sql: "delete from payments where company_id = $1" },
  {
    step: 5,
    table: "invoices",
    kind: "delete",
    children: ["invoice_lines"],
    keeps: "las del corte de Compaq (cutover_key)",
    sql: "delete from invoices where company_id = $1 and cutover_key is null",
  },
  { step: 6, table: "customer_pos", kind: "delete", children: ["customer_po_lines"], sql: "delete from customer_pos where company_id = $1" },
  { step: 7, table: "purchase_orders", kind: "delete", children: ["purchase_lines"], sql: "delete from purchase_orders where company_id = $1" },
  { step: 8, table: "sales_orders", kind: "delete", children: ["sales_lines"], sql: "delete from sales_orders where company_id = $1" },
  {
    step: 9,
    table: "vendor_rfqs",
    kind: "delete",
    children: ["vendor_rfq_suppliers", "vendor_rfq_lines", "vendor_rfq_bids", "vendor_rfq_targets"],
    sql: "delete from vendor_rfqs where company_id = $1",
  },
  { step: 10, table: "quotes", kind: "delete", children: ["quote_lines"], sql: "delete from quotes where company_id = $1" },
  { step: 11, table: "customer_requests", kind: "delete", children: ["customer_request_lines"], sql: "delete from customer_requests where company_id = $1" },
  {
    step: 12,
    table: "stock_moves",
    kind: "delete",
    keeps: "las existencias del corte (opening + 'Corte Compaq'); los 'Saldo inicial' de seedOpeningLedger se van: se regeneran solos y duplicarían el corte",
    sql: "delete from stock_moves where company_id = $1 and not (move_type = 'opening' and origin = 'Corte Compaq')",
  },
  { step: 13, table: "stock_quants", kind: "delete", why: "todas; se reconstruyen desde los movimientos que sobreviven (REBUILD)", sql: "delete from stock_quants where company_id = $1" },
  { step: 14, table: "documents", kind: "delete", sql: "delete from documents where company_id = $1" },
  {
    step: 15,
    table: "doc_files",
    kind: "delete",
    keeps: "los CSV del corte (kind = 'cutover', importar.tsx)",
    sql: "delete from doc_files where company_id = $1 and kind <> 'cutover'",
  },
  { step: 16, table: "notifications", kind: "delete", sql: "delete from notifications where company_id = $1" },
  { step: 17, table: "folio_counters", kind: "delete", why: "se re-siembra con la consulta de 0033 (REBUILD)", sql: "delete from folio_counters where company_id = $1" },
];

/**
 * Reconstrucción después del borrado, en este orden (§ 3). Cada sentencia
 * termina en `returning 1` implícito (runPurge la envuelve) para contar filas.
 */
export const REBUILD = [
  {
    name: "existencias",
    why: "stock_quants desde los movimientos que sobreviven: Σ entradas − Σ salidas por producto y bodega; promedio ponderado de las entradas (solo quedan entradas del corte, así que es exactamente el promedio móvil que dejó postStock)",
    sql: `-- OJO, quien modifique esto: el avg_cost de aquí es el promedio PONDERADO
-- de las entradas, no el promedio MÓVIL que postStock va calculando entrada
-- por entrada (movingAverage, stock.ts). Los dos coinciden SOLO mientras lo
-- que sobrevive al borrado sean puras entradas — hoy es así: quedan
-- únicamente los 'opening' del corte, una por producto y bodega. El día que
-- una salida pueda sobrevivir (p. ej. si se decide conservar un ajuste de
-- salida capturado sobre el corte), esta fórmula deja de ser exacta y hay que
-- reconstruir el promedio movimiento por movimiento, en orden, con
-- movingAverage. La prueba central lo fija comparando contra el unit_cost del
-- movimiento que sobrevive.
insert into stock_quants (company_id, product_id, location_id, quantity, avg_cost)
select m.company_id, m.product_id, m.location_id,
       sum(m.qty_in) - sum(m.qty_out),
       case when sum(m.qty_in) > 0.0001 then sum(m.qty_in * m.unit_cost) / sum(m.qty_in) else 0 end
from (
  select company_id, product_id, location_to as location_id, quantity as qty_in, 0::numeric as qty_out, unit_cost
    from stock_moves where company_id = $1 and location_to is not null
  union all
  select company_id, product_id, location_from, 0::numeric, quantity, unit_cost
    from stock_moves where company_id = $1 and location_from is not null
) m
group by m.company_id, m.product_id, m.location_id
having abs(sum(m.qty_in) - sum(m.qty_out)) > 0.0001`,
  },
  {
    name: "costo de productos",
    why: "misma fórmula que refreshProductCost (stock.ts) donde hay existencia; 0 donde no la hay (Decisión 56: regresa al costo de catálogo, que es 0). ref_cost no se toca. Cuenta solo los productos cuyo costo cambia",
    sql: `update products p
set cost = v.cost
from (
  select p2.id,
    round(coalesce((
      select case when coalesce(sum(q.quantity), 0) > 0.0001
        then sum(q.quantity * q.avg_cost) / sum(q.quantity)
        else 0 end
      from stock_quants q
      where q.company_id = p2.company_id and q.product_id = p2.id and q.quantity > 0.0001
    ), 0), 4) as cost
  from products p2 where p2.company_id = $1
) v
where p.id = v.id and p.cost <> v.cost`,
  },
  {
    name: "cartera del corte",
    why: "las facturas del corte vuelven a su estado de importación: residual = amount − opening_paid, open, y en cero lo que un cobro, una mora, un ajuste de TC o una reversa les hubieran escrito. folio_fiscal / uuid_fiscal se quedan (puente real)",
    sql: `update invoices
set residual = amount - opening_paid,
    state = 'open',
    interest_invoiced = 0,
    fega_charged = false,
    paid_date = null,
    fx_paid = null,
    fx_treatment = '',
    fx_invoiced = 0,
    fx_result = 0,
    cancelled_at = null,
    cancelled_by = null,
    cancel_reason = null,
    sat_cancelled_at = null
where company_id = $1 and cutover_key is not null`,
    // late_amount NO se resetea a propósito: nace en 0002 con default 0 y nadie
    // la escribe — ni el insert del corte (cutover.ts) ni ningún update en
    // src/, migrations/ o scripts/ (revisado 15-sep-2026). Siempre es 0; si un
    // día alguien la escribe, entra aquí junto con las demás.
  },
  {
    name: "folios de kardex",
    why: "la MISMA consulta de la migración 0033: máximo por serie de los refs que sobreviven (solo INI/ del corte); las demás series nacen en 0001 la primera vez que se pidan",
    sql: `insert into folio_counters (company_id, series, last_number)
select company_id, split_part(ref, '/', 1), max(split_part(ref, '/', 2)::int)
from stock_moves
where company_id = $1 and ref ~ '^(REC|ENT|TR|AJ|INI|DEV|REV)/[0-9]{4,}$'
group by company_id, split_part(ref, '/', 1)
on conflict (company_id, series) do update
  set last_number = greatest(folio_counters.last_number, excluded.last_number)`,
  },
];

/** Todas las tablas que el borrado toca: las de PURGE más sus hijas en cascada. */
export function purgeTables() {
  const out = new Set();
  for (const s of PURGE) {
    out.add(s.table);
    for (const c of s.children ?? []) out.add(c);
  }
  return [...out];
}

export function keepTables() {
  return KEEP.map((k) => k.table);
}

/** 'purge' | 'keep' | null (sin clasificar: la prueba "ninguna tabla olvidada" falla). */
export function classify(table) {
  if (purgeTables().includes(table)) return "purge";
  if (keepTables().includes(table)) return "keep";
  return null;
}

/**
 * Corre el plan completo para UNA empresa. `run(text, params)` devuelve las
 * filas (la app: `sql.query`; las pruebas: PGlite `db.query(...).rows`). No
 * abre transacción: quien llama la abre (paso 4: `withTx`; pruebas:
 * `db.transaction`). Primero el candado (`purgeGuard`); luego PURGE y REBUILD.
 * Devuelve la empresa y el conteo por paso — es lo que va a bitácora.
 */
export async function runPurge(run, companyId) {
  const company = await purgeGuard(run, companyId);
  const deleted = [];
  for (const s of PURGE) {
    const rows = await run(`with d as (${s.sql} returning 1) select count(*)::int as n from d`, [companyId]);
    deleted.push({ step: s.step, table: s.table, kind: s.kind, count: Number(rows[0]?.n ?? 0) });
  }
  const rebuilt = [];
  for (const r of REBUILD) {
    const rows = await run(`with d as (${r.sql} returning 1) select count(*)::int as n from d`, [companyId]);
    rebuilt.push({ name: r.name, count: Number(rows[0]?.n ?? 0) });
  }
  return { company, deleted, rebuilt };
}
