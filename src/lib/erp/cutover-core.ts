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
      // Decisión 64: el costo viene SOLO de la columna 4. El respaldo viejo
      // (c[3] || c[2]) copiaba la CANTIDAD como costo cuando la columna venía
      // vacía — un número inventado que decidía dinero.
      cost: num(c[3] || "0"),
    });
  }
  return out;
}

export function cutoverKeyOf(r: InvRow) {
  return `${r.kind}:${r.partnerCode}:${r.folio}`;
}

/** ¿Dos importes son el mismo dinero? Mismo umbral que usa el parseo (± 0.009). */
function sameMoney(a: number, b: number) {
  return Math.abs(a - b) < 0.009;
}

export async function previewOpenInvoiceRows(sql: Sql, o: { companyId: number; rows: InvRow[] }) {
  const rows: (InvRow & { key: string; partnerName: string; partnerId: number; skip: boolean; differs?: string })[] = [];
  for (const r of o.rows) {
    const key = cutoverKeyOf(r);
    const exists = await sql<{ id: number; amount: string; opening_paid: string }>`
      select id, amount::text, coalesce(opening_paid, 0)::text as opening_paid
      from invoices where company_id = ${o.companyId} and cutover_key = ${key} limit 1
    `;
    const partner = await sql<{ id: number; name: string }>`
      select id, name from partners where company_id = ${o.companyId} and upper(code) = ${r.partnerCode} limit 1
    `;
    // Decisión 65: lo ya cargado que llega con OTROS importes no se ignora en
    // silencio — se compara contra lo congelado al importar (amount y
    // opening_paid no cambian con los cobros posteriores; residual sí, por
    // eso no se compara contra residual).
    let differs: string | undefined;
    if (exists[0]) {
      const storedCargo = Number(exists[0].amount);
      const storedSaldo = storedCargo - Number(exists[0].opening_paid);
      const csvCargo = r.cargo || r.saldo + r.abono;
      if (!sameMoney(storedCargo, csvCargo) || !sameMoney(storedSaldo, r.saldo)) {
        differs = `Folio ${r.folio}: ya está cargado con cargo ${storedCargo} y saldo de corte ${storedSaldo}; el CSV trae cargo ${csvCargo} y saldo ${r.saldo}. No se aplica — si el bueno es el nuevo, se corrige la factura a mano.`;
      }
    }
    rows.push({
      ...r,
      key,
      partnerName: partner[0]?.name ?? "",
      partnerId: partner[0]?.id ?? 0,
      skip: Boolean(exists[0]),
      ...(differs ? { differs } : {}),
    });
  }
  return {
    rows,
    open: rows.filter((r) => !r.skip).length,
    skipped: rows.filter((r) => r.skip).length,
    differing: rows.filter((r) => r.differs).length,
  };
}

/**
 * Preview de existencias (no existía): los mismos candados que el apply —
 * sin costo (Decisión 64), sin catálogo (Decisión 66) — y la comparación de
 * la Decisión 65 contra el saldo inicial ya cargado, ANTES de aplicar nada.
 */
export async function previewStockRows(sql: Sql, o: { companyId: number; rows: StockRow[] }) {
  const rows: (StockRow & { skip: boolean; differs?: string; problem?: string })[] = [];
  for (const r of o.rows) {
    if (!(r.cost > 0)) {
      rows.push({ ...r, skip: false, problem: `Producto ${r.productCode} sin costo en el CSV: captura el costo real (vacío no es cero).` });
      continue;
    }
    const product = await sql<{ id: number }>`
      select id from products where company_id = ${o.companyId} and upper(code) = ${r.productCode} limit 1
    `;
    if (!product[0]) {
      rows.push({ ...r, skip: false, problem: `Producto ${r.productCode} no está en catálogo` });
      continue;
    }
    const loc = await sql<{ id: number }>`
      select id from locations
      where company_id = ${o.companyId} and (upper(code) = ${r.locationCode} or upper(name) = ${r.locationCode})
      limit 1
    `;
    if (!loc[0]) {
      rows.push({ ...r, skip: false, problem: `Bodega ${r.locationCode} no está en catálogo` });
      continue;
    }
    const already = await sql<{ quantity: string; unit_cost: string }>`
      select quantity::text, coalesce(unit_cost, 0)::text as unit_cost
      from stock_moves
      where company_id = ${o.companyId} and product_id = ${product[0].id} and location_to = ${loc[0].id}
        and move_type = 'opening' and origin = 'Corte Compaq'
      limit 1
    `;
    if (!already[0]) {
      rows.push({ ...r, skip: false });
      continue;
    }
    const storedQty = Number(already[0].quantity);
    const storedCost = Number(already[0].unit_cost);
    let differs: string | undefined;
    if (!sameMoney(storedQty, r.qty) || !sameMoney(storedCost, r.cost)) {
      differs = `${r.productCode} en ${r.locationCode}: ya está el saldo inicial con ${storedQty} a ${storedCost}; el CSV trae ${r.qty} a ${r.cost}. No se aplica — si el bueno es el nuevo, se ajusta en inventario.`;
    }
    rows.push({ ...r, skip: true, ...(differs ? { differs } : {}) });
  }
  return {
    rows,
    open: rows.filter((x) => !x.skip && !x.problem).length,
    skipped: rows.filter((x) => x.skip).length,
    differing: rows.filter((x) => x.differs).length,
    problems: rows.filter((x) => x.problem).length,
  };
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
  // Decisión 66: una fila mala no aborta el lote — se reporta con su razón y
  // las válidas entran. El reintento es seguro: lo ya cargado se salta por
  // cutover_key.
  const rejected: { reason: string }[] = [];
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
    if (!partner[0]) {
      rejected.push({ reason: `No está en catálogo el código ${r.partnerCode} (folio ${r.folio}). Carga catálogos Compaq primero.` });
      continue;
    }
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
  return { inserted, skipped, rejected };
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
  const rejected: { reason: string }[] = [];
  for (const r of o.rows) {
    // Decisión 64: sin costo no hay saldo inicial — vacío no es cero (regla 9).
    // A costo $0, toda venta posterior calcularía margen y financiamiento
    // sobre un costo inventado.
    if (!(r.cost > 0)) {
      rejected.push({ reason: `Producto ${r.productCode} sin costo en el CSV: captura el costo real (vacío no es cero).` });
      continue;
    }
    const product = await sql<{ id: number }>`
      select id from products where company_id = ${o.companyId} and upper(code) = ${r.productCode} limit 1
    `;
    if (!product[0]) {
      rejected.push({ reason: `Producto ${r.productCode} no está en catálogo` });
      continue;
    }
    const loc = await sql<{ id: number }>`
      select id from locations
      where company_id = ${o.companyId} and (upper(code) = ${r.locationCode} or upper(name) = ${r.locationCode})
      limit 1
    `;
    if (!loc[0]) {
      rejected.push({ reason: `Bodega ${r.locationCode} no está en catálogo` });
      continue;
    }
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
  return { inserted, skipped, rejected };
}
