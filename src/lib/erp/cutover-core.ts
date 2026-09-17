/**
 * Corazón del importador del corte Compaq (saldos abiertos y existencias),
 * SIN dependencias de servidor — solo tipos — para poder probarlo de verdad
 * contra PGlite (`scripts/erp-corte.test.mjs`), como `parciales.ts` y
 * `credit-limit.ts`. Las envolturas con permisos, transacción y bitácora
 * viven en `cutover.ts`.
 *
 * Lo que el catálogo o el kardex necesitan del mundo exterior entra por
 * parámetro (`foldName`, `postStock`, `today`): el módulo no importa nada
 * con alias en tiempo de ejecución, que es lo que dejaría fuera a las
 * pruebas de node --test.
 */
import type { Sql } from "@/lib/db";

export type InvRow = {
  partnerCode: string;
  folio: string;
  date: string;
  due: string;
  cargo: number;
  abono: number;
  saldo: number;
  currency: "MXN" | "USD";
  kind: "customer" | "supplier";
};

export type StockRow = {
  productCode: string;
  locationCode: string;
  qty: number;
  cost: number;
};

function splitCsv(text: string) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function cells(line: string) {
  if (line.includes("\t")) return line.split("\t").map((c) => c.trim());
  return line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
}

function num(v: string) {
  const n = Number(String(v || "0").replace(/,/g, "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export function parseOpenInvoices(raw: string, today: string): InvRow[] {
  const lines = splitCsv(raw);
  const out: InvRow[] = [];
  for (const line of lines) {
    const c = cells(line);
    if (!c[0] || (/codigo|código|partner|cliente|proveedor|folio/i.test(c[0]!) && out.length === 0)) continue;
    const kind = /prov|pagar|supplier|fp/i.test(c[8] || c[0] || "") ? "supplier" : "customer";
    const folio = (c[1] || c[2] || "").replace(/\s+/g, "-");
    const saldo = num(c[6] || c[5] || "0");
    if (!folio || Math.abs(saldo) < 0.009) continue;
    out.push({
      partnerCode: (c[0] || "").toUpperCase(),
      folio,
      date: (c[2] || c[3] || today).slice(0, 10),
      due: (c[3] || c[4] || c[2] || today).slice(0, 10),
      cargo: num(c[4] || c[5] || "0"),
      abono: num(c[5] || "0"),
      saldo,
      currency: /usd|dll/i.test(c[7] || "") ? "USD" : "MXN",
      kind,
    });
  }
  return out;
}

export function parseStockSnap(raw: string): StockRow[] {
  const out: StockRow[] = [];
  for (const line of splitCsv(raw)) {
    const c = cells(line);
    if (!c[0] || (/producto|codigo|código|code/i.test(c[0]!) && out.length === 0)) continue;
    const qty = num(c[2] || c[1] || "0");
    if (qty <= 0.0001) continue;
    out.push({
      productCode: (c[0] || "").toUpperCase(),
      locationCode: (c[1] || "001").toUpperCase(),
      qty,
      cost: num(c[3] || c[2] || "0"),
    });
  }
  return out;
}

export function cutoverKeyOf(r: InvRow) {
  return `${r.kind}:${r.partnerCode}:${r.folio}`;
}

export async function previewOpenInvoiceRows(sql: Sql, o: { companyId: number; rows: InvRow[] }) {
  const rows = [];
  for (const r of o.rows) {
    const key = cutoverKeyOf(r);
    const exists = await sql<{ id: number }>`
      select id from invoices where company_id = ${o.companyId} and cutover_key = ${key} limit 1
    `;
    const partner = await sql<{ id: number; name: string }>`
      select id, name from partners where company_id = ${o.companyId} and upper(code) = ${r.partnerCode} limit 1
    `;
    rows.push({
      ...r,
      key,
      partnerName: partner[0]?.name ?? "",
      partnerId: partner[0]?.id ?? 0,
      skip: Boolean(exists[0]),
    });
  }
  return { rows, open: rows.filter((r) => !r.skip).length, skipped: rows.filter((r) => r.skip).length };
}

export async function applyOpenInvoiceRows(
  sql: Sql,
  o: {
    companyId: number;
    userId: string;
    policyCode: string;
    circuitCode: string;
    rows: InvRow[];
    foldName: (s: string) => string;
  },
) {
  let inserted = 0;
  let skipped = 0;
  for (const r of o.rows) {
    const key = cutoverKeyOf(r);
    const exists = await sql<{ id: number }>`
      select id from invoices where company_id = ${o.companyId} and cutover_key = ${key} limit 1
    `;
    if (exists[0]) {
      skipped += 1;
      continue;
    }
    let partner = await sql<{ id: number }>`
      select id from partners where company_id = ${o.companyId} and upper(code) = ${r.partnerCode} limit 1
    `;
    if (!partner[0]) {
      const folded = o.foldName(r.partnerCode);
      partner = await sql<{ id: number }>`
        select id from partners where company_id = ${o.companyId} and upper(name) = ${folded} limit 1
      `;
    }
    if (!partner[0]) throw new Error(`No está en catálogo el código ${r.partnerCode} (folio ${r.folio}). Carga catálogos Compaq primero.`);
    const cargo = r.cargo || r.saldo + r.abono;
    // El abono que ya traía en Compaq queda registrado: el saldo de aquí
    // en adelante es cargo − abono de corte − pagos capturados en el sistema.
    const openingPaid = Math.max(0, cargo - r.saldo);
    await sql`
      insert into invoices (company_id, kind, name, partner_id, date, due_date, state, amount, residual, origin, currency, cutover_key, opening_paid, policy_code, created_by, circuit_code)
      values (
        ${o.companyId}, ${r.kind}, ${r.folio}, ${partner[0].id}, ${r.date}, ${r.due}, 'open',
        ${cargo}, ${r.saldo}, ${"Corte Compaq"}, ${r.currency}, ${key}, ${openingPaid}, ${o.policyCode}, ${o.userId},
        ${r.kind === "customer" ? o.circuitCode : null}
      )
    `;
    inserted += 1;
  }
  return { inserted, skipped };
}

export type PostStockFn = (
  sql: Sql,
  args: {
    companyId: number;
    userId: string;
    moveType: "opening";
    origin: string;
    productId: number;
    quantity: number;
    locationTo: number;
    unitCost: number;
  },
) => Promise<unknown>;

export async function applyStockRows(
  sql: Sql,
  o: { companyId: number; userId: string; rows: StockRow[]; postStock: PostStockFn },
) {
  let inserted = 0;
  let skipped = 0;
  for (const r of o.rows) {
    const product = await sql<{ id: number }>`
      select id from products where company_id = ${o.companyId} and upper(code) = ${r.productCode} limit 1
    `;
    if (!product[0]) throw new Error(`Producto ${r.productCode} no está en catálogo`);
    const loc = await sql<{ id: number }>`
      select id from locations
      where company_id = ${o.companyId} and (upper(code) = ${r.locationCode} or upper(name) = ${r.locationCode})
      limit 1
    `;
    if (!loc[0]) throw new Error(`Bodega ${r.locationCode} no está en catálogo`);
    const already = await sql<{ id: number }>`
      select id from stock_moves
      where company_id = ${o.companyId} and product_id = ${product[0].id} and location_to = ${loc[0].id}
        and move_type = 'opening' and origin = 'Corte Compaq'
      limit 1
      for update
    `;
    if (already[0]) {
      skipped += 1;
      continue;
    }
    await o.postStock(sql, {
      companyId: o.companyId,
      userId: o.userId,
      moveType: "opening",
      origin: "Corte Compaq",
      productId: product[0].id,
      quantity: r.qty,
      locationTo: loc[0].id,
      unitCost: r.cost,
    });
    inserted += 1;
  }
  return { inserted, skipped };
}
