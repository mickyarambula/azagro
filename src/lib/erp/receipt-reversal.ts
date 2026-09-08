import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql, withTx, type Sql } from "@/lib/db";
import { activeMember, canRevert } from "@/lib/erp/acl";
import { writeAudit } from "@/lib/erp/audit";
import { postStock } from "@/lib/erp/stock";

/**
 * BLOQUE DE DESHACER, paso 6: revertir una recepción.
 *
 * Decisión 15: lo que ya movió inventario no se cancela, se revierte — quedan
 * la entrada y la salida, ligadas. La salida va al MISMO costo con el que la
 * mercancía entró (mismo principio del paso 2), con tipo propio `reversal`
 * (un ajuste es una corrección de conteo; esto no lo es).
 *
 * Decisión 20: el promedio se acepta movido y SE MUESTRA con su número. Una
 * salida no recompone el promedio (solo las entradas promedian, `stock.ts`),
 * así que revertir una entrada deja el promedio donde la entrada lo dejó.
 * Ejemplo real: 10 TM a 9,000 + 25 a 9,500 → 35 a 9,357.142857; revertidas
 * las 25 quedan 10 TM **a 9,357.142857**, no a 9,000: 3,571.43 de más en el
 * valor. Eso se enseña antes de confirmar, no se disimula.
 *
 * Se detiene, antes de tocar nada, con:
 *   - Salida posterior del mismo producto desde esa bodega. El kardex no
 *     lleva lotes: si algo salió después no se puede saber si era de esta
 *     orden, y revertir consumiría existencia que no es del proveedor.
 *   - FP con abonos → primero se revierte el pago (paso 5).
 *   - OC cancelada, o recepción ya revertida.
 * El intento rechazado queda en bitácora (Decisión 32). Solo administrador o
 * gerencia (Decisión 24). Una acción, todo o nada (Decisión 25).
 */

export type ReceiptLine = {
  productId: number;
  code: string;
  product: string;
  uom: string;
  qty: number;
  unitCost: number;
  value: number;
  moveRef: string;
  location: string;
  qtyBefore: number;
  qtyAfter: number;
  avgNow: number;
  /** Promedio de antes de la recepción, solo si es reconstruible exacto. */
  avgBeforeReceipt: number | null;
  valueNow: number;
  valueAfter: number;
  /** Lo que se queda de más (o de menos) en el valor por el promedio movido. */
  avgLeftover: number | null;
};

export type ReceiptReversalPreview = {
  po: { id: number; name: string; partner: string; state: string; date: string; currency: string };
  lines: ReceiptLine[];
  invoice: { id: number; name: string; amount: number; residual: number; currency: string } | null;
  blockers: string[];
  allowed: boolean;
  role: string;
};

async function cid(sql: Sql, userId: string) {
  const rows = await sql<{ company_id: number }>`select company_id from members where user_id = ${userId} and status = 'active' limit 1`;
  if (!rows[0]) throw new Error("Sin empresa");
  return rows[0].company_id;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

type Chain = {
  preview: ReceiptReversalPreview;
  companyId: number;
  moves: Array<{ id: number; product_id: number; quantity: number; unit_cost: number; location_to: number; ref: string }>;
  invoiceId: number | null;
};

async function chainForReceipt(sql: Sql, companyId: number, poId: number, role: string): Promise<Chain> {
  const blockers: string[] = [];
  const lines: ReceiptLine[] = [];

  const po = await sql<{ id: number; name: string; state: string; partner: string; date: string; currency: string; location_id: number }>`
    select po.id, po.name, po.state, p.name as partner, po.date::text, coalesce(po.currency,'MXN') as currency, po.location_id
    from purchase_orders po join partners p on p.id = po.partner_id
    where po.id = ${poId} and po.company_id = ${companyId}
  `;
  if (!po[0]) throw new Error("Orden de compra no encontrada");
  const o = po[0];

  // Los movimientos de entrada de ESTA orden que no estén ya revertidos.
  const moves = await sql<{
    id: number;
    ref: string;
    product_id: number;
    quantity: string;
    unit_cost: string;
    location_to: number;
    code: string;
    product: string;
    uom: string;
    location: string;
    reversed_by: string | null;
  }>`
    select m.id, m.ref, m.product_id, m.quantity::text, coalesce(m.unit_cost,0)::text as unit_cost,
      m.location_to, p.code, p.name as product, coalesce(p.uom,'') as uom, l.name as location,
      (select r.ref from stock_moves r where r.reverses_id = m.id limit 1) as reversed_by
    from stock_moves m
    join products p on p.id = m.product_id
    left join locations l on l.id = m.location_to
    where m.company_id = ${companyId} and m.origin = ${o.name} and m.move_type = 'receipt'
    order by m.id
  `;
  const live = moves.filter((m) => !m.reversed_by);

  if (o.state === "cancelled") blockers.push(`${o.name} está cancelada.`);
  if (!moves.length) blockers.push(`${o.name} no tiene entradas registradas en el kardex: no hay recepción que revertir.`);
  else if (!live.length) blockers.push(`La recepción de ${o.name} ya está revertida (${moves.map((m) => m.reversed_by).join(", ")}).`);

  for (const m of live) {
    const qty = Number(m.quantity);
    const unitCost = Number(m.unit_cost);
    // El kardex no lleva lotes: si salió mercancía de este producto desde esta
    // bodega DESPUÉS de la entrada, no se puede saber si era de esta orden.
    const salidas = await sql<{ ref: string; quantity: string; move_type: string; date: string }>`
      select ref, quantity::text, move_type, date::text from stock_moves
      where company_id = ${companyId} and product_id = ${m.product_id}
        and location_from = ${m.location_to} and id > ${m.id}
      order by id
    `;
    if (salidas.length) {
      const total = salidas.reduce((s, x) => s + Number(x.quantity), 0);
      blockers.push(
        `Después de recibir ${o.name} salieron ${total} ${m.uom} de ${m.code} de ${m.location} (${salidas.map((x) => x.ref).join(", ")}). ` +
          "El kardex no lleva lotes: no se puede saber si lo que salió era de esta orden, y revertir se llevaría existencia que no es del proveedor. " +
          "Revierte primero esa salida.",
      );
      continue;
    }
    const q = await sql<{ quantity: string; avg_cost: string }>`
      select quantity::text, coalesce(avg_cost,0)::text as avg_cost from stock_quants
      where company_id = ${companyId} and product_id = ${m.product_id} and location_id = ${m.location_to}
    `;
    const qtyBefore = Number(q[0]?.quantity ?? 0);
    const avgNow = Number(q[0]?.avg_cost ?? 0);
    const qtyAfter = r2(qtyBefore - qty);
    // El promedio de antes de la recepción solo se reconstruye si NO entró
    // nada más a esa bodega después: si entró, el número sería una estimación
    // y aquí no se estima — se dice que no se puede.
    const entradasDespues = await sql<{ n: number }>`
      select count(*)::int as n from stock_moves
      where company_id = ${companyId} and product_id = ${m.product_id}
        and location_to = ${m.location_to} and id > ${m.id}
    `;
    const puro = (entradasDespues[0]?.n ?? 0) === 0 && qtyAfter > 0.0001;
    const avgBeforeReceipt = puro ? r2((qtyBefore * avgNow - qty * unitCost) / (qtyBefore - qty)) : null;
    const valueNow = r2(qtyBefore * avgNow);
    const valueAfter = r2(qtyAfter * avgNow);
    lines.push({
      productId: m.product_id,
      code: m.code,
      product: m.product,
      uom: m.uom,
      qty,
      unitCost,
      value: r2(qty * unitCost),
      moveRef: m.ref,
      location: m.location,
      qtyBefore,
      qtyAfter,
      avgNow,
      avgBeforeReceipt,
      valueNow,
      valueAfter,
      avgLeftover: avgBeforeReceipt == null ? null : r2(valueAfter - qtyAfter * avgBeforeReceipt),
    });
  }

  // La FP que nació con la recepción (paso 3). Con abonos, primero el paso 5.
  const fps = await sql<{ id: number; name: string; amount: string; residual: string; state: string; paid: string }>`
    select i.id, i.name, i.amount::text, i.residual::text, i.state,
      coalesce((select sum(amount) from payment_allocs where invoice_id = i.id), 0)::text as paid
    from invoices i
    where i.company_id = ${companyId} and i.kind = 'supplier' and i.origin = ${o.name} and i.state <> 'reversed'
    order by i.id
  `;
  let invoice: ReceiptReversalPreview["invoice"] = null;
  let invoiceId: number | null = null;
  for (const fp of fps) {
    if (Number(fp.paid) > 0.009 || fp.state === "paid") {
      blockers.push(
        `${fp.name} (la factura de ${o.partner} por ${o.name}) ya tiene abonos: ya se le pagó al proveedor, en todo o en parte. Revierte primero ese pago.`,
      );
      continue;
    }
    invoice = { id: fp.id, name: fp.name, amount: Number(fp.amount), residual: Number(fp.residual), currency: o.currency };
    invoiceId = fp.id;
  }

  return {
    preview: {
      po: { id: o.id, name: o.name, partner: o.partner, state: o.state, date: o.date, currency: o.currency },
      lines,
      invoice,
      blockers,
      allowed: canRevert(role),
      role,
    },
    companyId,
    moves: live.map((m) => ({ id: m.id, product_id: m.product_id, quantity: Number(m.quantity), unit_cost: Number(m.unit_cost), location_to: m.location_to, ref: m.ref })),
    invoiceId,
  };
}

async function auditRejected(sql: Sql, companyId: number, userId: string, chain: Chain) {
  await writeAudit(sql, {
    companyId,
    userId,
    action: "revertir-rechazado",
    entity: "purchase",
    entityId: chain.preview.po.id,
    name: chain.preview.po.name,
    detail: chain.preview.blockers.join(" | ").slice(0, 900),
  });
}

/** Lo que la pantalla enseña antes de preguntar una vez (Decisión 25). */
export const receiptReversalPreview = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ poId: z.number() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    const me = await activeMember(sql, context.userId);
    const chain = await chainForReceipt(sql, companyId, data.poId, me.role);
    if (chain.preview.blockers.length) await auditRejected(sql, companyId, context.userId, chain);
    return chain.preview;
  });

/** Revertir la recepción: salida contraria al costo de la entrada, OC de vuelta a confirmada, FP revertida. */
export const reverseReceipt = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ poId: z.number(), reason: z.string().trim().min(1, "Escribe el motivo") }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    const me = await activeMember(sql, context.userId);
    const chain = await chainForReceipt(sql, companyId, data.poId, me.role);
    if (chain.preview.blockers.length) {
      await auditRejected(sql, companyId, context.userId, chain);
      throw new Error(chain.preview.blockers[0]);
    }
    if (!canRevert(me.role)) throw new Error("Solo un administrador o gerencia puede revertir una recepción: ya movió inventario.");
    return withTx(async (tx) => {
      await tx`select id from purchase_orders where id = ${data.poId} and company_id = ${companyId} for update`;
      const fresh = await chainForReceipt(tx, companyId, data.poId, me.role);
      if (fresh.preview.blockers.length) throw new Error(fresh.preview.blockers[0]);
      const refs: string[] = [];
      for (const m of fresh.moves) {
        // Sale al MISMO costo con el que entró, ligada a su entrada. postStock
        // vuelve a verificar existencia: si no alcanza, se detiene aquí.
        const mv = await postStock(tx, {
          companyId,
          userId: context.userId,
          moveType: "reversal",
          origin: fresh.preview.po.name,
          productId: m.product_id,
          quantity: m.quantity,
          locationFrom: m.location_to,
          unitCost: m.unit_cost,
          reversesId: m.id,
        });
        refs.push(mv.ref);
        await tx`
          update purchase_lines set qty_received = 0
          where po_id = ${data.poId} and product_id = ${m.product_id}
        `;
      }
      await tx`update purchase_orders set state = 'confirmed' where id = ${data.poId} and company_id = ${companyId}`;
      if (fresh.invoiceId) {
        await tx`
          update invoices set state = 'reversed', cancelled_at = now(), cancelled_by = ${context.userId}, cancel_reason = ${data.reason}
          where id = ${fresh.invoiceId} and company_id = ${companyId}
        `;
        await writeAudit(tx, {
          companyId,
          userId: context.userId,
          action: "revertir-fp",
          entity: "invoice",
          entityId: fresh.invoiceId,
          name: fresh.preview.invoice?.name ?? "",
          detail: `Revertida al revertir la recepción de ${fresh.preview.po.name} · sin abonos · ${data.reason}`,
        });
      }
      const promedios = fresh.preview.lines
        .map((l) => `${l.code}: ${l.qtyBefore} → ${l.qtyAfter} ${l.uom}, promedio ${l.avgNow.toFixed(4)} (no se mueve)${l.avgLeftover != null ? `, quedan ${l.avgLeftover.toFixed(2)} de más en el valor` : ""}`)
        .join(" · ");
      await writeAudit(tx, {
        companyId,
        userId: context.userId,
        action: "revertir-recepcion",
        entity: "purchase",
        entityId: data.poId,
        name: fresh.preview.po.name,
        detail: `${refs.join(", ")} · ${promedios}${fresh.preview.invoice ? ` · ${fresh.preview.invoice.name} revertida` : ""} · ${data.reason}`,
      });
      return { ok: true as const, refs, invoice: fresh.preview.invoice?.name ?? null };
    });
  });
