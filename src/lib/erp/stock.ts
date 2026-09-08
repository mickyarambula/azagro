import type { getSql } from "@/lib/db";
import { todayMx } from "@/lib/utils";

type Sql = Awaited<ReturnType<typeof getSql>>;

export type StockMoveType = "receipt" | "delivery" | "internal" | "adjust" | "opening" | "return";

const REF_PREFIX: Record<StockMoveType, string> = {
  receipt: "REC",
  delivery: "ENT",
  internal: "TR",
  adjust: "AJ",
  opening: "INI",
  return: "DEV",
};

/**
 * Costo ponderado de un conjunto de salidas: Σ(cantidad × costo) ÷ Σ(cantidad).
 *
 * Decisión 9: la mercancía devuelta regresa al costo con el que SALIÓ, no al
 * promedio de hoy. Hoy una venta sale de bodega una sola vez (`deliverSale`
 * exige pedido confirmado y lo deja en 'done'; nada lo regresa a confirmado),
 * así que este ponderado casi siempre opera sobre un solo renglón y devuelve
 * ese mismo costo. La regla queda escrita de todos modos para el día que
 * existan entregas parciales: dos salidas a costos distintos se promedian
 * por cantidad, no se elige una (Decisión 26). Sin renglones → null: quien
 * llama decide, aquí no se inventa un número.
 */
export function weightedCost(rows: Array<{ qty: number; unitCost: number }>): number | null {
  let qty = 0;
  let value = 0;
  for (const r of rows) {
    const q = Math.max(0, Number(r.qty) || 0);
    if (q <= 0.0000001) continue;
    qty += q;
    value += q * Math.max(0, Number(r.unitCost) || 0);
  }
  if (qty <= 0.0000001) return null;
  return value / qty;
}

/**
 * A qué estado va una factura después de recalcular su saldo. Regla pura,
 * separada del SQL para poder probarla con datos: 'reversed' es terminal —
 * una factura revertida se queda revertida aunque su saldo recalculado dé
 * mayor que cero (BLOQUE DE DESHACER, paso 4). Lo demás es lo de siempre:
 * saldo cero → 'paid', saldo vivo → 'open'.
 */
export function nextInvoiceState(current: string, residual: number): "reversed" | "paid" | "open" {
  if (current === "reversed") return "reversed";
  return residual <= 0.009 ? "paid" : "open";
}

/** Promedio móvil: (existencia × costo + entrada × precio) / nueva existencia. */
export function movingAverage(oldQty: number, oldAvg: number, qtyIn: number, unitCost: number) {
  const on = Math.max(0, oldQty);
  const inn = Math.max(0, qtyIn);
  const next = on + inn;
  if (next <= 0.0000001) return Math.max(0, unitCost);
  return (on * Math.max(0, oldAvg) + inn * Math.max(0, unitCost)) / next;
}

/**
 * Columnas de trazabilidad de facturas: autor, cálculo guardado (fórmula con
 * sus insumos), foto de parámetros al emitir, y el desglose interés/FEGA de
 * cada FI (para reconstruir estados de cuenta a fecha pasada).
 */
export async function ensureInvoiceExtras(sql: Sql) {
  await sql`alter table invoices add column if not exists created_by text not null default ''`;
  await sql`alter table invoices add column if not exists calc text not null default ''`;
  await sql`alter table invoices add column if not exists params_snap text not null default ''`;
  await sql`alter table invoices add column if not exists int_part numeric(14,2) not null default 0`;
  await sql`alter table invoices add column if not exists fega_part numeric(14,2) not null default 0`;
  // Explicación de la factura de intereses para el cliente (doc-text.ts).
  await sql`alter table invoices add column if not exists calc_client text not null default ''`;
  // Paso 1 del catálogo de circuitos: etiqueta por documento (migración 0025).
  await sql`alter table invoices add column if not exists circuit_code text`;
  // Puente con Compaq (migración 0027): folio fiscal + UUID del CFDI que
  // timbra Compaq (kind='customer'), folio de la factura del proveedor
  // (kind='supplier'). Se capturan después de emitido; vacío no es error.
  await sql`alter table invoices add column if not exists folio_fiscal text not null default ''`;
  await sql`alter table invoices add column if not exists uuid_fiscal text not null default ''`;
  await sql`alter table invoices add column if not exists supplier_folio text not null default ''`;
}

export async function ensureStock(sql: Sql) {
  await sql`alter table stock_moves add column if not exists unit_cost numeric(14,4) not null default 0`;
  await sql`alter table stock_quants add column if not exists avg_cost numeric(14,4) not null default 0`;
  await ensureInvoiceExtras(sql);
  await sql`
    update stock_quants q
    set avg_cost = p.cost
    from products p
    where q.product_id = p.id and q.avg_cost = 0 and p.cost > 0
  `;
}

async function nextRef(sql: Sql, companyId: number, type: StockMoveType) {
  const n = await sql<{ c: number }>`select count(*)::int as c from stock_moves where company_id = ${companyId}`;
  return `${REF_PREFIX[type]}/${String((n[0]?.c ?? 0) + 1).padStart(4, "0")}`;
}

export async function qtyFromMoves(sql: Sql, companyId: number, productId: number, locationId: number) {
  const rows = await sql<{ q: string }>`
    select (
      coalesce((select sum(quantity) from stock_moves
        where company_id = ${companyId} and product_id = ${productId} and location_to = ${locationId}), 0)
      - coalesce((select sum(quantity) from stock_moves
        where company_id = ${companyId} and product_id = ${productId} and location_from = ${locationId}), 0)
    )::text as q
  `;
  return Number(rows[0]?.q ?? 0);
}

/**
 * Con qué costo salió de bodega la mercancía de un pedido (Decisión 9).
 *
 * El amarre es por el folio del pedido, que es lo que `deliverSale` escribe en
 * `origin` — no hay llave: `stock_moves` no guarda el id del pedido
 * (DESHACER.md § 1). Es determinista de todos modos: los folios son únicos por
 * empresa (0015_folios_unicos.sql) y las series no chocan (PV- vs OC-).
 *
 * `null` = no hay salida registrada para ese pedido y producto: quien llama
 * avisa, no inventa. Pasa con datos anteriores a esta lógica; un pedido
 * directo/brokeraje ni siquiera llega aquí (no movió inventario).
 */
export async function deliveredUnitCost(sql: Sql, companyId: number, origin: string, productId: number) {
  const rows = await sql<{ quantity: string; unit_cost: string }>`
    select quantity::text, coalesce(unit_cost, 0)::text as unit_cost
    from stock_moves
    where company_id = ${companyId} and origin = ${origin}
      and product_id = ${productId} and move_type = 'delivery'
    order by id
  `;
  return weightedCost(rows.map((r) => ({ qty: Number(r.quantity), unitCost: Number(r.unit_cost) })));
}

/** Promedio de una bodega para un producto, tal como está ahora (Decisión 20: se enseña). */
export async function avgCostAt(sql: Sql, companyId: number, productId: number, locationId: number) {
  return (await readQuant(sql, companyId, productId, locationId)).avg;
}

async function readQuant(sql: Sql, companyId: number, productId: number, locationId: number) {
  const rows = await sql<{ quantity: string; avg_cost: string }>`
    select quantity::text, coalesce(avg_cost, 0)::text as avg_cost
    from stock_quants
    where company_id = ${companyId} and product_id = ${productId} and location_id = ${locationId}
  `;
  const product = await sql<{ cost: string }>`select cost::text from products where id = ${productId}`;
  const fallback = Number(product[0]?.cost ?? 0);
  return {
    qty: Number(rows[0]?.quantity ?? 0),
    avg: Number(rows[0]?.avg_cost ?? 0) || fallback,
    fallback,
  };
}

async function writeQuant(sql: Sql, companyId: number, productId: number, locationId: number, qty: number, avg: number) {
  await sql`
    insert into stock_quants (company_id, product_id, location_id, quantity, avg_cost)
    values (${companyId}, ${productId}, ${locationId}, ${qty}, ${avg})
    on conflict (company_id, product_id, location_id)
    do update set quantity = excluded.quantity, avg_cost = excluded.avg_cost
  `;
}

async function refreshProductCost(sql: Sql, companyId: number, productId: number) {
  const row = await sql<{ avg: string }>`
    select (
      case when coalesce(sum(quantity), 0) > 0.0001
        then sum(quantity * avg_cost) / sum(quantity)
        else 0
      end
    )::text as avg
    from stock_quants
    where company_id = ${companyId} and product_id = ${productId} and quantity > 0.0001
  `;
  const avg = Number(row[0]?.avg ?? 0);
  if (avg > 0) {
    await sql`update products set cost = ${avg} where id = ${productId} and company_id = ${companyId}`;
  }
}

async function assertStockLocation(sql: Sql, companyId: number, locationId: number) {
  const loc = await sql<{ loc_type: string }>`
    select loc_type from locations where id = ${locationId} and company_id = ${companyId}
  `;
  if (!loc[0]) throw new Error("Bodega no encontrada");
  if (loc[0].loc_type === "customer") {
    throw new Error("Un punto de entrega no es bodega. El stock se mueve entre Azagro, proveedor o tránsito.");
  }
  return loc[0].loc_type;
}

/**
 * Escribe un movimiento inmutable y deja la existencia como suma del kardex.
 * El costo promedio de la bodega se recalcula solo en entradas.
 */
export async function postStock(
  sql: Sql,
  opts: {
    companyId: number;
    userId: string;
    moveType: StockMoveType;
    origin: string;
    productId: number;
    quantity: number;
    locationFrom?: number | null;
    locationTo?: number | null;
    unitCost?: number;
    date?: string;
  },
) {
  await ensureStock(sql);
  const qty = Math.abs(Number(opts.quantity) || 0);
  if (qty <= 0.0000001) throw new Error("La cantidad tiene que ser mayor a 0");
  const fromId = opts.locationFrom || null;
  const toId = opts.locationTo || null;
  if (!fromId && !toId) throw new Error("Indica bodega de origen o destino");
  if (fromId && toId && fromId === toId) throw new Error("Origen y destino no pueden ser la misma bodega");

  if (fromId) await assertStockLocation(sql, opts.companyId, fromId);
  if (toId) await assertStockLocation(sql, opts.companyId, toId);

  await sql`select id from products where id = ${opts.productId} and company_id = ${opts.companyId} for update`;
  if (fromId) {
    await sql`
      select id from stock_quants
      where company_id = ${opts.companyId} and product_id = ${opts.productId} and location_id = ${fromId}
      for update
    `;
  }
  if (toId) {
    await sql`
      select id from stock_quants
      where company_id = ${opts.companyId} and product_id = ${opts.productId} and location_id = ${toId}
      for update
    `;
  }

  let unitCost = Math.max(0, Number(opts.unitCost) || 0);

  if (fromId) {
    const onHand = await qtyFromMoves(sql, opts.companyId, opts.productId, fromId);
    const cached = await readQuant(sql, opts.companyId, opts.productId, fromId);
    const have = Math.abs(onHand - cached.qty) < 0.0001 ? cached.qty : onHand;
    if (have + 0.0001 < qty) {
      throw new Error(
        opts.moveType === "delivery"
          ? "Stock insuficiente. Recibe primero la OC en bodega, o marca el pedido como directo / brokeraje."
          : "Stock insuficiente en origen. Revisa el kardex.",
      );
    }
    if (unitCost <= 0) unitCost = cached.avg;
  }

  if (toId && unitCost <= 0) {
    const dest = await readQuant(sql, opts.companyId, opts.productId, toId);
    unitCost = dest.avg || dest.fallback;
  }

  const ref = await nextRef(sql, opts.companyId, opts.moveType);
  const day = (opts.date || todayMx()).slice(0, 10);

  await sql`
    insert into stock_moves (
      company_id, ref, move_type, date, origin, location_from, location_to,
      product_id, quantity, unit_cost, created_by
    )
    values (
      ${opts.companyId}, ${ref}, ${opts.moveType}, ${day}, ${opts.origin},
      ${fromId}, ${toId}, ${opts.productId}, ${qty}, ${unitCost}, ${opts.userId}
    )
  `;

  if (fromId) {
    const nextQty = await qtyFromMoves(sql, opts.companyId, opts.productId, fromId);
    const prev = await readQuant(sql, opts.companyId, opts.productId, fromId);
    await writeQuant(sql, opts.companyId, opts.productId, fromId, nextQty, nextQty > 0.0001 ? prev.avg : prev.avg);
  }
  if (toId) {
    const nextQty = await qtyFromMoves(sql, opts.companyId, opts.productId, toId);
    const prev = await readQuant(sql, opts.companyId, opts.productId, toId);
    const qtyBefore = nextQty - qty;
    const avg = movingAverage(Math.max(0, qtyBefore), prev.avg || prev.fallback, qty, unitCost);
    await writeQuant(sql, opts.companyId, opts.productId, toId, nextQty, avg);
  }

  await refreshProductCost(sql, opts.companyId, opts.productId);
  return { ref, unitCost };
}

/** Si hay existencia sin movimiento, abre el kardex con un saldo inicial (una sola vez). */
export async function seedOpeningLedger(sql: Sql, companyId: number, userId: string) {
  await ensureStock(sql);
  const quants = await sql<{ product_id: number; location_id: number; quantity: string; avg_cost: string }>`
    select q.product_id, q.location_id, q.quantity::text, coalesce(nullif(q.avg_cost, 0), p.cost)::text as avg_cost
    from stock_quants q
    join products p on p.id = q.product_id
    join locations l on l.id = q.location_id
    where q.company_id = ${companyId} and l.loc_type <> 'customer' and abs(q.quantity) > 0.0001
  `;
  for (const q of quants) {
    const ledger = await qtyFromMoves(sql, companyId, q.product_id, q.location_id);
    const gap = Number(q.quantity) - ledger;
    if (Math.abs(gap) <= 0.0001) continue;
    await postStock(sql, {
      companyId,
      userId,
      moveType: "opening",
      origin: "Saldo inicial",
      productId: q.product_id,
      quantity: Math.abs(gap),
      locationFrom: gap < 0 ? q.location_id : null,
      locationTo: gap > 0 ? q.location_id : null,
      unitCost: Number(q.avg_cost) || 0,
    });
  }
}

export async function refreshInvoiceResidual(sql: Sql, invoiceId: number) {
  await sql`alter table invoices add column if not exists paid_date date`;
  await sql`alter table invoices add column if not exists opening_paid numeric(14,2) not null default 0`;
  const row = await sql<{ amount: string; opening_paid: string; paid: string; state: string }>`
    select i.amount::text, coalesce(i.opening_paid, 0)::text as opening_paid,
      coalesce((select sum(amount) from payment_allocs where invoice_id = i.id), 0)::text as paid,
      i.state
    from invoices i
    where i.id = ${invoiceId}
  `;
  if (!row[0]) return 0;
  // opening_paid = abonos que la factura traía desde el corte de Compaq; no
  // existen como pagos aquí, pero el saldo debe respetarlos siempre.
  const residual = Math.max(0, Number(row[0].amount) - Number(row[0].opening_paid) - Number(row[0].paid));
  const next = nextInvoiceState(row[0].state, residual);
  if (next === "reversed") {
    // Una factura revertida NO revive por aquí. Sin este candado, cualquier
    // cosa que tocara sus abonos la regresaría a 'open' con todo su saldo, y
    // la deuda que alguien revirtió a propósito volvería a la vida sin que
    // nadie lo pidiera — rompería el principio completo del BLOQUE DE
    // DESHACER (Decisión 16: queda rastro, no se decide solo).
    return 0;
  }
  const paid = next === "paid";
  if (paid) {
    await sql`
      update invoices
      set residual = 0, state = 'paid',
        paid_date = coalesce(paid_date, ${todayMx()}::date)
      where id = ${invoiceId}
    `;
    return 0;
  }
  // Al reabrir, paid_date se limpia: mora (estado de cuenta) y P&L la leen
  // como fin de los días vencidos, y un pago revertido dejaría el interés
  // sin correr si se quedara puesta (DESHACER.md § 2.1, hueco confirmado).
  await sql`update invoices set residual = ${residual}, state = 'open', paid_date = null where id = ${invoiceId}`;
  return residual;
}
