import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql, withTx, type Sql } from "@/lib/db";
import { activeMember, canRevert } from "@/lib/erp/acl";
import { writeAudit } from "@/lib/erp/audit";
import { postStock } from "@/lib/erp/stock";
import { todayMx } from "@/lib/utils";

/**
 * BLOQUE DE DESHACER, paso 7: revertir una entrega con su factura. El más
 * grande del bloque: aquí convergen los pasos 2 (costo de salida), 3 (FP de
 * brokeraje), 4 (revertir por estado), 5 (los pagos primero) y 6 (el par en
 * el kardex).
 *
 * REVERTIR NO ES DEVOLVER (Decisión 38). Una devolución es una venta real de
 * la que el cliente regresa mercancía: la FV sigue, la mora corrió, el pedido
 * sigue entregado. Una reversa es una entrega que NO debió registrarse
 * (pedido equivocado, cliente equivocado, capturada dos veces): todo se
 * regresa como si no hubiera pasado. Si la mercancía está en casa del cliente
 * y la venta fue real, revertir es mentir — el inventario diría que está en
 * bodega.
 *
 * La cadena, en orden, y dónde se detiene:
 *   - Pagos vivos en la FV o en la FI → primero el paso 5.
 *   - Devolución previa (NC + PAG virtual + `return`) → se bloquea: son seis
 *     documentos y la reversa de devolución es el paso 8.
 *   - FV → NOTA DE CRÉDITO por el total (Decisión 19: es lo timbrado) y la FV
 *     queda `reversed`. Si la FV ya está timbrada en Compaq, NO se bloquea
 *     (Decisión 39): la NC nace sin folio fiscal, se avisa, y queda marcada
 *     hasta que alguien la timbre y capture su folio.
 *   - FI → NC por el total y `reversed` (Decisión 37): a diferencia del paso
 *     5, aquí la entrega no existió — no hubo venta, ni crédito, ni interés.
 *   - ATC → `reversed` por estado (interno, no timbrado).
 *   - FP de brokeraje (nació con esta entrega, paso 3) → `reversed` si no
 *     tiene abonos; con abonos, primero el paso 5.
 *   - Kardex: entrada contraria AL COSTO CON EL QUE SALIÓ (paso 2), tipo
 *     `reversal`, ligada; el promedio se enseña (Decisión 20).
 *   - Pedido: `done` → `confirmed`; al volver a entregar, la FV nueva toma la
 *     TIIE de la tabla A ESA FECHA (Decisión 40) — puede ser otro renglón, y
 *     es lo correcto.
 */

type Line = { name: string; detail: string; amount: number; currency: string };

export type DeliveryReversalPreview = {
  so: { id: number; name: string; partner: string; date: string; currency: string; circuit: string | null; creditDays: number; direct: boolean };
  stock: Array<{ code: string; product: string; uom: string; qty: number; unitCost: number; value: number; location: string; qtyBefore: number; qtyAfter: number; avgBefore: number; avgAfter: number }>;
  reverts: Line[];
  fiscal: { name: string; folio: string; uuid: string } | null;
  partnerDebt: { name: string; before: number; after: number };
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

type Doc = { id: number; name: string; amount: number; residual: number; inv_class: string };
type Chain = {
  preview: DeliveryReversalPreview;
  companyId: number;
  fv: Doc | null;
  fis: Doc[];
  atcs: Doc[];
  fps: Doc[];
  moves: Array<{ id: number; product_id: number; quantity: number; unit_cost: number; location_from: number }>;
  partnerId: number;
};

async function chainForDelivery(sql: Sql, companyId: number, soId: number, role: string): Promise<Chain> {
  const blockers: string[] = [];
  const reverts: Line[] = [];
  const stock: DeliveryReversalPreview["stock"] = [];

  const so = await sql<{
    id: number; name: string; state: string; partner: string; partner_id: number; date: string; currency: string;
    route_kind: string; location_id: number; circuit_code: string | null; credit_days: number;
  }>`
    select so.id, so.name, so.state, p.name as partner, so.partner_id, so.date::text, coalesce(so.currency,'MXN') as currency,
      coalesce(so.route_kind,'own') as route_kind, so.location_id, so.circuit_code, coalesce(so.credit_days,0)::int as credit_days
    from sales_orders so join partners p on p.id = so.partner_id
    where so.id = ${soId} and so.company_id = ${companyId}
  `;
  if (!so[0]) throw new Error("Pedido no encontrado");
  const s = so[0];
  const direct = s.route_kind === "supplier" || s.route_kind === "asr";
  const preview: DeliveryReversalPreview = {
    so: { id: s.id, name: s.name, partner: s.partner, date: s.date, currency: s.currency, circuit: s.circuit_code, creditDays: s.credit_days, direct },
    stock, reverts, fiscal: null, partnerDebt: { name: s.partner, before: 0, after: 0 }, blockers, allowed: canRevert(role), role,
  };
  const empty = (): Chain => ({ preview, companyId, fv: null, fis: [], atcs: [], fps: [], moves: [], partnerId: s.partner_id });

  if (s.state === "cancelled") { blockers.push(`${s.name} está cancelado.`); return empty(); }
  if (s.state !== "done") { blockers.push(`${s.name} no se ha entregado: no hay entrega que revertir.`); return empty(); }

  // Devolución previa: NC + PAG virtual + movimiento 'return'. Seis documentos
  // en cadena y la reversa de devolución es el paso 8. Se bloquea.
  const devs = await sql<{ name: string; qty: string }>`
    select i.name, coalesce((select sum(-il.qty) from invoice_lines il where il.invoice_id = i.id), 0)::text as qty
    from invoices i
    where i.company_id = ${companyId} and i.order_id = ${s.id} and i.name like 'NC-%' and i.reverses_id is null and i.state <> 'reversed'
    order by i.id
  `;
  const returned = await sql<{ q: string }>`select coalesce(sum(qty_returned),0)::text as q from sales_lines where so_id = ${s.id}`;
  if (devs.length || Number(returned[0]?.q ?? 0) > 0.0001) {
    blockers.push(
      `${s.name} ya tiene una devolución (${devs.map((d) => d.name).join(", ") || "mercancía devuelta"}). Primero habría que revertir esa devolución, y eso todavía no está construido.`,
    );
  }

  // La FV viva del pedido.
  const docs = await sql<{ id: number; name: string; amount: string; residual: string; inv_class: string; origin: string; folio_fiscal: string; uuid_fiscal: string; paid: string; reversed_by: string | null }>`
    select i.id, i.name, i.amount::text, i.residual::text, coalesce(i.inv_class,'product') as inv_class, coalesce(i.origin,'') as origin,
      coalesce(i.folio_fiscal,'') as folio_fiscal, coalesce(i.uuid_fiscal,'') as uuid_fiscal,
      coalesce((select sum(amount) from payment_allocs where invoice_id = i.id), 0)::text as paid,
      (select r.name from invoices r where r.reverses_id = i.id limit 1) as reversed_by
    from invoices i
    where i.company_id = ${companyId} and i.kind = 'customer' and i.reverses_id is null
      and (i.order_id = ${s.id} or i.origin like ${"% " + s.name})
    order by i.id
  `;
  const fvRow = docs.find((d) => d.name.startsWith("FV-") && !d.reversed_by && d.origin === s.name);
  const alreadyReversed = docs.find((d) => d.name.startsWith("FV-") && d.reversed_by);
  if (!fvRow) {
    blockers.push(alreadyReversed ? `La entrega de ${s.name} ya está revertida (${alreadyReversed.reversed_by}).` : `${s.name} no tiene factura viva: no hay entrega que revertir.`);
    return empty();
  }
  const toDoc = (d: typeof fvRow): Doc => ({ id: d.id, name: d.name, amount: Number(d.amount), residual: Number(d.residual), inv_class: d.inv_class });
  const fv = toDoc(fvRow);
  if (Number(fvRow.paid) > 0.009) blockers.push(`${fv.name} tiene abonos: revierte ese cobro primero (Cartera → Revertir último abono).`);
  if (fvRow.folio_fiscal || fvRow.uuid_fiscal) preview.fiscal = { name: fv.name, folio: fvRow.folio_fiscal, uuid: fvRow.uuid_fiscal };
  reverts.push({ name: fv.name, detail: `saldo ${fv.residual.toFixed(2)} · sin abonos → nota de crédito por el total, factura revertida`, amount: fv.amount, currency: s.currency });

  const fis: Doc[] = [];
  for (const d of docs.filter((x) => x.inv_class === "interest" && x.origin === `Mora ${fv.name}` && !x.reversed_by)) {
    if (Number(d.paid) > 0.009) { blockers.push(`${d.name} (mora facturada de ${fv.name}) tiene abonos: revierte ese cobro primero.`); continue; }
    fis.push(toDoc(d));
    reverts.push({ name: d.name, detail: "mora facturada · sin abonos → nota de crédito por el total, revertida (si la entrega no existió, la mora tampoco)", amount: Number(d.amount), currency: "MXN" });
  }
  const atcs: Doc[] = [];
  for (const d of docs.filter((x) => x.inv_class === "fx" && x.origin === `Ajuste TC ${fv.name}` && !x.reversed_by)) {
    if (Number(d.paid) > 0.009) { blockers.push(`${d.name} (ajuste de tipo de cambio de ${fv.name}) tiene abonos: revierte ese cobro primero.`); continue; }
    atcs.push(toDoc(d));
    reverts.push({ name: d.name, detail: "ajuste de tipo de cambio · sin abonos → se marca revertido", amount: Number(d.amount), currency: "MXN" });
  }

  // Brokeraje: la FP que nació con esta entrega (paso 3).
  const fps: Doc[] = [];
  if (direct) {
    const rows = await sql<{ id: number; name: string; amount: string; residual: string; partner: string; paid: string; po: string }>`
      select i.id, i.name, i.amount::text, i.residual::text, p.name as partner, po.name as po,
        coalesce((select sum(amount) from payment_allocs where invoice_id = i.id), 0)::text as paid
      from purchase_orders po
      join invoices i on i.company_id = po.company_id and i.kind = 'supplier' and i.origin = po.name and i.state <> 'reversed'
      join partners p on p.id = i.partner_id
      where po.company_id = ${companyId} and po.so_id = ${s.id} and coalesce(po.fulfill_kind,'inventory') = 'direct'
      order by i.id
    `;
    for (const d of rows) {
      if (Number(d.paid) > 0.009) { blockers.push(`${d.name} (la factura de ${d.partner} por ${d.po}, brokeraje) tiene abonos: revierte ese pago primero.`); continue; }
      fps.push({ id: d.id, name: d.name, amount: Number(d.amount), residual: Number(d.residual), inv_class: "supplier" });
      reverts.push({ name: d.name, detail: `${d.partner} · brokeraje, nació con esta entrega · sin abonos → revertida`, amount: Number(d.amount), currency: s.currency });
    }
  }

  // Kardex: las salidas de esta entrega, de regreso al costo con el que salieron.
  const moves: Chain["moves"] = [];
  if (!direct) {
    const outs = await sql<{ id: number; product_id: number; quantity: string; unit_cost: string; location_from: number; code: string; product: string; uom: string; location: string; reversed_by: string | null }>`
      select m.id, m.product_id, m.quantity::text, coalesce(m.unit_cost,0)::text as unit_cost, m.location_from,
        p.code, p.name as product, coalesce(p.uom,'') as uom, l.name as location,
        (select r.ref from stock_moves r where r.reverses_id = m.id limit 1) as reversed_by
      from stock_moves m join products p on p.id = m.product_id left join locations l on l.id = m.location_from
      where m.company_id = ${companyId} and m.origin = ${s.name} and m.move_type = 'delivery'
      order by m.id
    `;
    for (const m of outs.filter((x) => !x.reversed_by)) {
      const qty = Number(m.quantity);
      const unitCost = Number(m.unit_cost);
      const q = await sql<{ quantity: string; avg_cost: string }>`
        select quantity::text, coalesce(avg_cost,0)::text as avg_cost from stock_quants
        where company_id = ${companyId} and product_id = ${m.product_id} and location_id = ${m.location_from}
      `;
      const qtyBefore = Number(q[0]?.quantity ?? 0);
      const avgBefore = Number(q[0]?.avg_cost ?? 0);
      const qtyAfter = r2(qtyBefore + qty);
      // Es una ENTRADA: sí promedia. Al costo con el que salió, casi siempre
      // regresa al mismo promedio; si entró algo a otro costo mientras tanto,
      // se mueve — y se enseña (Decisión 20).
      const avgAfter = qtyAfter > 0.0000001 ? (qtyBefore * avgBefore + qty * unitCost) / qtyAfter : unitCost;
      stock.push({ code: m.code, product: m.product, uom: m.uom, qty, unitCost, value: r2(qty * unitCost), location: m.location, qtyBefore, qtyAfter, avgBefore, avgAfter });
      moves.push({ id: m.id, product_id: m.product_id, quantity: qty, unit_cost: unitCost, location_from: m.location_from });
    }
  }

  const debt = await sql<{ total: string }>`
    select coalesce(sum(residual),0)::text as total from invoices
    where company_id = ${companyId} and partner_id = ${s.partner_id} and kind = 'customer' and state = 'open'
  `;
  const before = Number(debt[0]?.total ?? 0);
  preview.partnerDebt = { name: s.partner, before, after: r2(before - fv.residual - fis.reduce((a, d) => a + d.residual, 0) - atcs.reduce((a, d) => a + d.residual, 0)) };
  return { preview, companyId, fv, fis, atcs, fps, moves, partnerId: s.partner_id };
}

async function auditRejected(sql: Sql, companyId: number, userId: string, chain: Chain) {
  await writeAudit(sql, { companyId, userId, action: "revertir-rechazado", entity: "sale", entityId: chain.preview.so.id, name: chain.preview.so.name, detail: chain.preview.blockers.join(" | ").slice(0, 900) });
}

export const deliveryReversalPreview = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ soId: z.number() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    const me = await activeMember(sql, context.userId);
    const chain = await chainForDelivery(sql, companyId, data.soId, me.role);
    if (chain.preview.blockers.length) await auditRejected(sql, companyId, context.userId, chain);
    return chain.preview;
  });

/** NC por el total de un documento de cliente timbrado (FV o FI): espejo de sus renglones, nace saldada, ligada. */
async function creditNoteFor(sql: Sql, companyId: number, userId: string, doc: Doc, so: { id: number; name: string; partnerId: number; currency: string; circuit: string | null }, reason: string, today: string) {
  const n = await sql<{ c: number }>`select count(*)::int as c from invoices where company_id = ${companyId} and name like 'NC-%'`;
  const ncName = `NC-${String((n[0]?.c ?? 0) + 1).padStart(4, "0")}`;
  const nc = await sql<{ id: number }>`
    insert into invoices (company_id, kind, name, partner_id, date, due_date, state, amount, residual, origin, currency, order_id, inv_class, created_by, circuit_code, reverses_id, paid_date)
    values (${companyId}, 'customer', ${ncName}, ${so.partnerId}, ${today}, ${today}, 'paid', ${-doc.amount}, 0, ${doc.name}, ${so.currency}, ${so.id}, ${doc.inv_class}, ${userId}, ${so.circuit}, ${doc.id}, ${today})
    returning id
  `;
  const lines = await sql<{ product_id: number | null; qty: string; unit_price: string; amount: string; description: string | null }>`
    select product_id, qty::text, unit_price::text, amount::text, description from invoice_lines where invoice_id = ${doc.id} order by id
  `;
  for (const l of lines) {
    await sql`
      insert into invoice_lines (invoice_id, product_id, qty, unit_price, amount, description)
      values (${nc[0]!.id}, ${l.product_id}, ${Number(l.qty)}, ${Number(l.unit_price)}, ${-Number(l.amount)}, ${l.description})
    `;
  }
  await sql`update invoices set state = 'reversed', cancelled_at = now(), cancelled_by = ${userId}, cancel_reason = ${reason} where id = ${doc.id} and company_id = ${companyId}`;
  await writeAudit(sql, { companyId, userId, action: "revertir-fv", entity: "invoice", entityId: doc.id, name: doc.name, detail: `${ncName} por el total (${doc.amount.toFixed(2)}) al revertir la entrega de ${so.name} · ${reason}` });
  return ncName;
}

export const reverseDelivery = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ soId: z.number(), reason: z.string().trim().min(1, "Escribe el motivo") }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    const me = await activeMember(sql, context.userId);
    const chain = await chainForDelivery(sql, companyId, data.soId, me.role);
    if (chain.preview.blockers.length) { await auditRejected(sql, companyId, context.userId, chain); throw new Error(chain.preview.blockers[0]); }
    if (!canRevert(me.role)) throw new Error("Solo un administrador o gerencia puede revertir una entrega: ya movió inventario y cartera.");
    return withTx(async (tx) => {
      await tx`select id from sales_orders where id = ${data.soId} and company_id = ${companyId} for update`;
      const fresh = await chainForDelivery(tx, companyId, data.soId, me.role);
      if (fresh.preview.blockers.length) throw new Error(fresh.preview.blockers[0]);
      const today = todayMx();
      const so = { id: fresh.preview.so.id, name: fresh.preview.so.name, partnerId: fresh.partnerId, currency: fresh.preview.so.currency, circuit: fresh.preview.so.circuit };
      const written: string[] = [];
      // 1) Kardex: de regreso al costo con el que salió, ligado a su salida.
      for (const m of fresh.moves) {
        const mv = await postStock(tx, { companyId, userId: context.userId, moveType: "reversal", origin: so.name, productId: m.product_id, quantity: m.quantity, locationTo: m.location_from, unitCost: m.unit_cost, reversesId: m.id });
        written.push(mv.ref);
      }
      // 2) Lo timbrado: NC por el total. Lo interno: por estado.
      if (fresh.fv) written.push(await creditNoteFor(tx, companyId, context.userId, fresh.fv, so, data.reason, today));
      for (const fi of fresh.fis) written.push(await creditNoteFor(tx, companyId, context.userId, fi, so, data.reason, today));
      for (const atc of fresh.atcs) {
        await tx`update invoices set state = 'reversed', cancelled_at = now(), cancelled_by = ${context.userId}, cancel_reason = ${data.reason} where id = ${atc.id} and company_id = ${companyId}`;
        await writeAudit(tx, { companyId, userId: context.userId, action: "revertir-atc", entity: "invoice", entityId: atc.id, name: atc.name, detail: `Revertido al revertir la entrega de ${so.name} · ${data.reason}` });
        written.push(`${atc.name} revertida`);
      }
      for (const fp of fresh.fps) {
        await tx`update invoices set state = 'reversed', cancelled_at = now(), cancelled_by = ${context.userId}, cancel_reason = ${data.reason} where id = ${fp.id} and company_id = ${companyId}`;
        await writeAudit(tx, { companyId, userId: context.userId, action: "revertir-fp", entity: "invoice", entityId: fp.id, name: fp.name, detail: `Brokeraje: nació con la entrega de ${so.name}; si la entrega no existió, esa deuda tampoco · ${data.reason}` });
        written.push(`${fp.name} revertida`);
      }
      // 3) El pedido vuelve a "confirmado, por entregar".
      await tx`update sales_lines set qty_delivered = 0 where so_id = ${so.id}`;
      await tx`update sales_orders set state = 'confirmed' where id = ${so.id} and company_id = ${companyId}`;
      await writeAudit(tx, {
        companyId, userId: context.userId, action: "revertir-entrega", entity: "sale", entityId: so.id, name: so.name,
        detail: `${written.join(", ")}${fresh.preview.fiscal ? ` · ${fresh.preview.fiscal.name} estaba TIMBRADA (${fresh.preview.fiscal.uuid || fresh.preview.fiscal.folio}): la NC se timbra en Compaq` : ""}${
          fresh.preview.stock.length ? ` · ${fresh.preview.stock.map((l) => `${l.code} ${l.qtyBefore} → ${l.qtyAfter} ${l.uom}, promedio ${l.avgBefore.toFixed(4)} → ${l.avgAfter.toFixed(4)}`).join(" · ")}` : ""
        } · ${data.reason}`,
      });
      return { ok: true as const, written };
    });
  });
