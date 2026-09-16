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

/**
 * @typedef {(text: string, params?: unknown[]) => Promise<Array<Record<string, any>>>} Run
 *   Quien corre SQL: la app pasa `sql.query`, las pruebas `db.query(...).rows`.
 * @typedef {{ expectName?: string }} NameOpts
 *   El nombre de la empresa tecleado (paso 4). Ausente = no se exige (pruebas del plan).
 * @typedef {{ id: number, name: string, liveSince: unknown }} CompanyState
 * @typedef {{ step: number, table: string, kind: "update" | "delete", sql: string, children?: string[], keeps?: string, why?: string }} PurgeStep
 * @typedef {{ name: string, why: string, sql: string }} RebuildStep
 */

/** Tablas que SE CONSERVAN (§ 2 "Se conserva"). Motivo por tabla. @type {Array<{ table: string, why: string }>} */
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

/** @param {string} name @param {unknown} liveSince */
export function liveSinceMessage(name, liveSince) {
  const when = liveSince instanceof Date ? liveSince.toISOString().slice(0, 10) : String(liveSince).slice(0, 10);
  return (
    `La empresa «${name}» arrancó la operación real el ${when}: los datos de prueba ya no se pueden borrar. ` +
    `Si se marcó por error y no se ha capturado nada real, usa «Regresar a pruebas» en esta misma pantalla.`
  );
}

/**
 * Lectura del estado (paso 4). `companySql` / `settingsSql` son las dos
 * sentencias del candado (con `for update`, para escribir) o las de LIVE (sin
 * bloquear, para el preview). No juzga: devuelve `liveSince` tal cual.
 * @param {Run} run @param {number} companyId @param {string} companySql @param {string} settingsSql
 * @returns {Promise<CompanyState>}
 */
async function readState(run, companyId, companySql, settingsSql) {
  if (!Number.isInteger(companyId) || companyId <= 0) throw new Error(`Empresa inválida: ${String(companyId)}`);
  const company = await run(companySql, [companyId]);
  if (!company[0]) throw new Error(`No existe la empresa ${companyId}: no hay nada que borrar.`);
  const settings = await run(settingsSql, [companyId]);
  return { id: Number(company[0].id), name: String(company[0].name), liveSince: settings[0]?.live_since ?? null };
}

/**
 * El nombre de la empresa tecleado (paso 4, § 4.4): exacto, recortado. Sin `expectName` no se exige (las pruebas del plan).
 * @param {CompanyState} company @param {string | undefined} expectName
 */
function assertName(company, expectName) {
  if (expectName === undefined) return;
  if (String(expectName).trim() !== company.name.trim()) {
    throw new Error(`El nombre tecleado no coincide con «${company.name}». No se tocó nada.`);
  }
}

/**
 * El candado de escritura: bloquea, relee `live_since`, se niega si arrancó, exige el nombre si se lo pasan.
 * @param {Run} run @param {number} companyId @param {NameOpts} [opts]
 */
export async function purgeGuard(run, companyId, opts = {}) {
  const s = await readState(run, companyId, GUARD.company, GUARD.settings);
  if (s.liveSince !== null && s.liveSince !== undefined) throw new Error(liveSinceMessage(s.name, s.liveSince));
  assertName(s, opts.expectName);
  return s;
}

/**
 * Lo mismo SIN bloquear y SIN negarse: lo que el preview enseña (si `liveSince` viene, es un bloqueo en pantalla).
 * @param {Run} run @param {number} companyId
 */
export async function purgeState(run, companyId) {
  return readState(run, companyId, LIVE.readCompany, LIVE.read);
}

// ---------------------------------------------------------------------------
// La marca de arranque (§ 4.2, B3): `company_settings.live_since`.
// ---------------------------------------------------------------------------

/**
 * Acciones de bitácora que NO escriben documentos (Ajustes, catálogos,
 * permisos, rechazos, y las de este mismo bloque). Cualquier otra acción
 * posterior a la marca cuenta como "se capturó algo" y bloquea «Regresar a
 * pruebas»: lo desconocido bloquea, no pasa. La bitácora tiene reloj propio
 * (`created_at` lo pone la base), así que no se puede antedatar como la
 * fecha de un documento.
 */
export const LIVE_HARMLESS_ACTIONS = [
  "arranque-real",
  "arranque-real-retirado",
  "borrado-de-pruebas",
  "borrado-rechazado",
  "rechazado-permiso",
  "cancelar-rechazado",
  "revertir-rechazado",
  "rechazado-credito",
  "importacion-fallida",
  "tiie",
  "tasas",
  "tipo-cambio",
  "parametros",
  "politica-cobro",
  "circuito",
  "margen",
  "precio-producto",
  "credito-cliente",
  "saldo-banco",
  "permisos-usuario",
  "alta-usuario",
  "correo",
  "recordatorio",
];

const harmlessList = LIVE_HARMLESS_ACTIONS.map((a) => `'${a}'`).join(", ");

/**
 * Documentos del grupo A fechados DESPUÉS de la marca. Fechas de negocio
 * (`date`, `po_date`): estrictamente un día posterior — lo del mismo día es
 * ambiguo (pudo capturarse antes de marcar) y de eso se encarga la bitácora.
 * Reloj de la base (`created_at`): posterior al instante. Lo del corte nunca
 * cuenta (no es captura de la app).
 */
export const LIVE = {
  readCompany: "select id, name from companies where id = $1",
  read: "select live_since from company_settings where company_id = $1",
  set: `insert into company_settings (company_id, live_since) values ($1, now())
on conflict (company_id) do update set live_since = now() where company_settings.live_since is null
returning live_since`,
  clear: "update company_settings set live_since = null where company_id = $1 and live_since is not null returning 1",
  docs: [
    { what: "expenses", sql: "select count(*)::int as n from expenses where company_id = $1 and (date > ($2::timestamptz)::date or created_at > $2::timestamptz)" },
    { what: "bank_moves", sql: "select count(*)::int as n from bank_moves where company_id = $1 and date > ($2::timestamptz)::date" },
    { what: "payments", sql: "select count(*)::int as n from payments where company_id = $1 and date > ($2::timestamptz)::date" },
    { what: "invoices", sql: "select count(*)::int as n from invoices where company_id = $1 and cutover_key is null and date > ($2::timestamptz)::date" },
    { what: "customer_pos", sql: "select count(*)::int as n from customer_pos where company_id = $1 and (po_date > ($2::timestamptz)::date or created_at > $2::timestamptz)" },
    { what: "purchase_orders", sql: "select count(*)::int as n from purchase_orders where company_id = $1 and date > ($2::timestamptz)::date" },
    { what: "sales_orders", sql: "select count(*)::int as n from sales_orders where company_id = $1 and date > ($2::timestamptz)::date" },
    { what: "vendor_rfqs", sql: "select count(*)::int as n from vendor_rfqs where company_id = $1 and created_at > $2::timestamptz" },
    { what: "quotes", sql: "select count(*)::int as n from quotes where company_id = $1 and date > ($2::timestamptz)::date" },
    { what: "customer_requests", sql: "select count(*)::int as n from customer_requests where company_id = $1 and date > ($2::timestamptz)::date" },
    { what: "stock_moves", sql: "select count(*)::int as n from stock_moves where company_id = $1 and not (move_type = 'opening' and origin = 'Corte Compaq') and date > ($2::timestamptz)::date" },
    { what: "documents", sql: "select count(*)::int as n from documents where company_id = $1 and created_at > $2::timestamptz" },
    { what: "doc_files", sql: "select count(*)::int as n from doc_files where company_id = $1 and kind <> 'cutover' and created_at > $2::timestamptz" },
    { what: "notifications", sql: "select count(*)::int as n from notifications where company_id = $1 and created_at > $2::timestamptz" },
  ],
  audit: `select count(*)::int as n from audit_log where company_id = $1 and created_at > $2::timestamptz and action not in (${harmlessList})`,
};

/** @param {unknown} v */
const tsOf = (v) => (v instanceof Date ? v.toISOString() : String(v));

/**
 * @param {Run} run @param {number} companyId @param {unknown} liveSince
 * @returns {Promise<Array<{ what: string, count: number }>>} vacío = se puede regresar a pruebas.
 */
export async function liveBlockers(run, companyId, liveSince) {
  const since = tsOf(liveSince);
  /** @type {Array<{ what: string, count: number }>} */
  const out = [];
  for (const d of LIVE.docs) {
    const n = Number((await run(d.sql, [companyId, since]))[0]?.n ?? 0);
    if (n > 0) out.push({ what: d.what, count: n });
  }
  const a = Number((await run(LIVE.audit, [companyId, since]))[0]?.n ?? 0);
  if (a > 0) out.push({ what: "bitácora", count: a });
  return out;
}

/** @param {string} name @param {Array<{ what: string, count: number }>} blockers */
export function liveBlockersMessage(name, blockers) {
  const docs = blockers.filter((b) => b.what !== "bitácora");
  const audit = blockers.find((b) => b.what === "bitácora");
  const n = docs.reduce((s, b) => s + b.count, 0);
  const parts = [];
  if (n) parts.push(`${n} documento${n === 1 ? "" : "s"} fechado${n === 1 ? "" : "s"} después del arranque (${docs.map((b) => `${b.what}: ${b.count}`).join(", ")})`);
  if (audit) parts.push(`${audit.count} renglón${audit.count === 1 ? "" : "es"} de bitácora posterior${audit.count === 1 ? "" : "es"} que escribió documentos`);
  return (
    `No se puede regresar a pruebas: la empresa «${name}» tiene ${parts.join(" y ")}. ` +
    `Cancela o revierte esos ${n || audit?.count || 0} documentos primero (bloque de deshacer); si son reales, la operación ya arrancó y no hay regreso.`
  );
}

/**
 * «Arrancó la operación real»: una sola vez; crea el renglón de Ajustes si falta.
 * @param {Run} run @param {number} companyId @param {NameOpts} [opts]
 */
export async function setLive(run, companyId, opts = {}) {
  const s = await readState(run, companyId, GUARD.company, GUARD.settings);
  assertName(s, opts.expectName);
  if (s.liveSince !== null && s.liveSince !== undefined) throw new Error(`La empresa «${s.name}» ya arrancó la operación real el ${tsOf(s.liveSince).slice(0, 10)}.`);
  const rows = await run(LIVE.set, [companyId]);
  if (!rows[0]) throw new Error(`La empresa «${s.name}» ya arrancó la operación real.`);
  return { id: s.id, name: s.name, liveSince: rows[0].live_since };
}

/**
 * «Regresar a pruebas»: solo si nada se capturó después de la marca (documentos ni bitácora).
 * @param {Run} run @param {number} companyId @param {NameOpts} [opts]
 */
export async function clearLive(run, companyId, opts = {}) {
  const s = await readState(run, companyId, GUARD.company, GUARD.settings);
  assertName(s, opts.expectName);
  if (s.liveSince === null || s.liveSince === undefined) throw new Error(`La empresa «${s.name}» no está marcada como en operación real: no hay nada que quitar.`);
  const blockers = await liveBlockers(run, companyId, s.liveSince);
  if (blockers.length) throw new Error(liveBlockersMessage(s.name, blockers));
  await run(LIVE.clear, [companyId]);
  return { id: s.id, name: s.name, liveSince: s.liveSince };
}

/**
 * Lo que SE BORRA, en este orden. `sql` es la sentencia literal, con `$1` =
 * company_id. `children` = tablas sin company_id que caen en cascada con ésta.
 * `kind` = 'delete' salvo el primer paso, que es un `update` (rompe el ciclo).
 * @type {PurgeStep[]}
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
 * @type {RebuildStep[]}
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

/**
 * Lo que el preview (paso 4) pregunta antes de borrar, con la MISMA sentencia
 * de cada paso convertida a conteo — así el número que se enseña es el número
 * que después se borra (la prueba central lo compara paso por paso).
 */
/** @param {PurgeStep} step */
export function countSql(step) {
  const m = step.sql.match(/^(?:delete from|update) (\w+)(?: set [\s\S]*?)? where ([\s\S]*)$/);
  if (!m) throw new Error(`Paso ${step.step}: no se pudo derivar el conteo de: ${step.sql}`);
  return `select count(*)::int as n from ${m[1]} where ${m[2]}`;
}

/** @param {Run} run @param {number} companyId */
export async function previewCounts(run, companyId) {
  /** @type {Array<{ step: number, table: string, kind: string, count: number }>} */
  const out = [];
  for (const s of PURGE) {
    const rows = await run(countSql(s), [companyId]);
    out.push({ step: s.step, table: s.table, kind: s.kind, count: Number(rows[0]?.n ?? 0) });
  }
  return out;
}

export const PREVIEW = {
  /** Cuántos productos cambiarían de costo (Decisión 56): el promedio ponderado de sus INI del corte, o 0 si no tiene. Misma aritmética que REBUILD. */
  productCost: `select count(*)::int as n from products p
where p.company_id = $1 and p.cost <> round(coalesce((
  select case when sum(m.quantity) > 0.0001 then sum(m.quantity * m.unit_cost) / sum(m.quantity) else 0 end
  from stock_moves m
  where m.company_id = p.company_id and m.product_id = p.id
    and m.move_type = 'opening' and m.origin = 'Corte Compaq' and m.location_to is not null
), 0), 4)`,
};

/** Todas las tablas que el borrado toca: las de PURGE más sus hijas en cascada. */
export function purgeTables() {
  /** @type {Set<string>} */
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
/** @param {string} table */
export function classify(table) {
  if (purgeTables().includes(table)) return "purge";
  if (keepTables().includes(table)) return "keep";
  return null;
}

/**
 * Corre el plan completo para UNA empresa. `run(text, params)` devuelve las
 * filas (la app: `sql.query`; las pruebas: PGlite `db.query(...).rows`). No
 * abre transacción: quien llama la abre (paso 4: `withTx`; pruebas:
 * `db.transaction`). Primero el candado (`purgeGuard`, que con `expectName`
 * exige además el nombre de la empresa tecleado — paso 4); luego PURGE y
 * REBUILD. Devuelve la empresa y el conteo por paso — es lo que va a bitácora.
 */
/** @param {Run} run @param {number} companyId @param {NameOpts} [opts] */
export async function runPurge(run, companyId, opts = {}) {
  const company = await purgeGuard(run, companyId, opts);
  /** @type {Array<{ step: number, table: string, kind: string, count: number }>} */
  const deleted = [];
  for (const s of PURGE) {
    const rows = await run(`with d as (${s.sql} returning 1) select count(*)::int as n from d`, [companyId]);
    deleted.push({ step: s.step, table: s.table, kind: s.kind, count: Number(rows[0]?.n ?? 0) });
  }
  /** @type {Array<{ name: string, count: number }>} */
  const rebuilt = [];
  for (const r of REBUILD) {
    const rows = await run(`with d as (${r.sql} returning 1) select count(*)::int as n from d`, [companyId]);
    rebuilt.push({ name: r.name, count: Number(rows[0]?.n ?? 0) });
  }
  return { company, deleted, rebuilt };
}
