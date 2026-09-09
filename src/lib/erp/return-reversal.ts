import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql, withTx, type Sql } from "@/lib/db";
import { activeMember, canRevert } from "@/lib/erp/acl";
import { writeAudit } from "@/lib/erp/audit";
import { postStock, refreshInvoiceResidual } from "@/lib/erp/stock";
import { todayMx } from "@/lib/utils";

/**
 * BLOQUE DE DESHACER, paso 8: revertir una devolución. El que cierra el
 * bloque, y el que destraba al paso 7 (una entrega con devolución previa).
 *
 * `returnSale` deja cuatro cosas: la NC negativa, un abono VIRTUAL aplicado a
 * la FV (sin banco), el movimiento `return` al costo con el que salió (paso
 * 2) y `qty_returned` en la partida. La reversa, en orden:
 *   - Salida contraria del inventario al costo con el que REGRESÓ (tipo
 *     `reversal`, ligada al `return`). Se detiene si hubo cualquier salida
 *     posterior de ese producto desde esa bodega: la mercancía devuelta pudo
 *     haberse revendido y el kardex no lleva lotes (Decisión 35 aplicada a la
 *     entrada de devolución).
 *   - Contra-abono del PAG virtual (el que el paso 5 bloquea a propósito y
 *     manda aquí): `inbound` negativo, sin banco (nunca lo tuvo), ligado.
 *     La FV vuelve a deber ese importe y, si el abono la había cerrado,
 *     `paid_date` se limpia y la mora vuelve a correr — la venta fue real, así
 *     que una FI emitida en medio se queda (misma lógica de la Decisión 21).
 *   - La NC queda `reversed` por estado: no tiene documento contrario (como
 *     la FP, Decisión 19). Si estaba timbrada, en el SAT hay que CANCELAR ese
 *     CFDI desde Compaq; el sistema no lo hace (regla 3): avisa, marca, cuenta,
 *     y la marca se limpia cuando alguien captura `sat_cancelled_at` en el
 *     puente (Decisión 41).
 *   - `qty_returned` de regreso. El pedido sigue `done`.
 *
 * LIFO estricto (Decisión 33 aplicada aquí): solo la última devolución viva
 * del pedido. El estado de cuenta toma el último abono de la FV como fecha de
 * abono y `paid_date` es de un solo cierre; y el amarre de los movimientos
 * `return` viejos con su NC solo es determinista desde la última.
 *
 * El amarre: de aquí en adelante el `return` lleva en `origin` el folio de la
 * NC (Decisión 42), como el `receipt` lleva la OC y el `delivery` el pedido.
 * Para las devoluciones anteriores (`origin` = pedido) se amarra por producto
 * + cantidad + fecha, tomando el último sin revertir; si no cuadra exacto,
 * se bloquea diciéndolo. Nunca se adivina.
 */

type Line = { name: string; detail: string; amount: number; currency: string };

export type ReturnReversalPreview = {
  nc: { id: number; name: string; date: string; amount: number; residual: number; state: string; timbrada: { folio: string; uuid: string } | null };
  so: { id: number; name: string; partner: string; currency: string; direct: boolean };
  fv: { id: number; name: string; residualNow: number; residualAfter: number; dueDate: string } | null;
  virtualPayment: { id: number; name: string; amount: number } | null;
  stock: Array<{ code: string; product: string; uom: string; qty: number; unitCost: number; value: number; location: string; qtyBefore: number; qtyAfter: number; avg: number; moveRef: string; matchedBy: "nc" | "legacy" }>;
  keeps: Line[];
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

type Chain = {
  preview: ReturnReversalPreview;
  companyId: number;
  moves: Array<{ id: number; product_id: number; quantity: number; unit_cost: number; location_to: number }>;
  lines: Array<{ product_id: number; qty: number }>;
  partnerId: number;
};

async function chainForReturn(sql: Sql, companyId: number, ncId: number, role: string): Promise<Chain> {
  const blockers: string[] = [];
  const keeps: Line[] = [];
  const stock: ReturnReversalPreview["stock"] = [];

  const nc = await sql<{
    id: number; name: string; date: string; amount: string; residual: string; state: string; order_id: number | null; reverses_id: number | null;
    folio_fiscal: string; uuid_fiscal: string; reversed_by: string | null;
    so_name: string | null; so_partner: string | null; so_partner_id: number | null; so_currency: string | null; so_route: string | null; so_location: number | null;
  }>`
    select i.id, i.name, i.date::text, i.amount::text, i.residual::text, i.state, i.order_id, i.reverses_id,
      coalesce(i.folio_fiscal,'') as folio_fiscal, coalesce(i.uuid_fiscal,'') as uuid_fiscal,
      (select r.name from invoices r where r.reverses_id = i.id limit 1) as reversed_by,
      so.name as so_name, p.name as so_partner, so.partner_id as so_partner_id, coalesce(so.currency,'MXN') as so_currency,
      coalesce(so.route_kind,'own') as so_route, so.location_id as so_location
    from invoices i
    left join sales_orders so on so.id = i.order_id
    left join partners p on p.id = so.partner_id
    where i.id = ${ncId} and i.company_id = ${companyId} and i.kind = 'customer'
  `;
  if (!nc[0]) throw new Error("Nota de crédito no encontrada");
  const n = nc[0];
  const direct = n.so_route === "supplier" || n.so_route === "asr";
  const preview: ReturnReversalPreview = {
    nc: { id: n.id, name: n.name, date: n.date, amount: Number(n.amount), residual: Number(n.residual), state: n.state, timbrada: n.folio_fiscal || n.uuid_fiscal ? { folio: n.folio_fiscal, uuid: n.uuid_fiscal } : null },
    so: { id: n.order_id ?? 0, name: n.so_name ?? "", partner: n.so_partner ?? "", currency: n.so_currency ?? "MXN", direct },
    fv: null, virtualPayment: null, stock, keeps, partnerDebt: { name: n.so_partner ?? "", before: 0, after: 0 }, blockers, allowed: canRevert(role), role,
  };
  const empty = (): Chain => ({ preview, companyId, moves: [], lines: [], partnerId: n.so_partner_id ?? 0 });

  if (!n.name.startsWith("NC-") || !n.order_id) { blockers.push(`${n.name} no es una devolución.`); return empty(); }
  if (n.reverses_id) { blockers.push(`${n.name} es la nota de crédito de una reversa de entrega, no una devolución: no se revierte por aquí.`); return empty(); }
  if (n.state === "reversed") { blockers.push(`${n.name} ya está revertida.`); return empty(); }

  // LIFO: solo la última devolución viva del pedido.
  const later = await sql<{ name: string }>`
    select name from invoices
    where company_id = ${companyId} and order_id = ${n.order_id} and name like 'NC-%' and reverses_id is null and state <> 'reversed' and id > ${n.id}
    order by id desc
  `;
  if (later.length) blockers.push(`${n.name} no es la última devolución de ${n.so_name}. Revierte primero ${later[0]!.name}.`);

  // Los renglones de la NC: qué se devolvió (cantidades positivas).
  const lines = await sql<{ product_id: number; qty: string; code: string; product: string; uom: string }>`
    select il.product_id, il.qty::text, p.code, p.name as product, coalesce(p.uom,'') as uom
    from invoice_lines il join products p on p.id = il.product_id
    where il.invoice_id = ${n.id} order by il.id
  `;

  // El abono virtual: memo 'Devolución NC-x', sin banco, aplicado a la FV.
  const vp = await sql<{ id: number; name: string; amount: string; invoice_id: number; fv_name: string; fv_residual: string; fv_due: string }>`
    select pmt.id, pmt.name, pmt.amount::text, pa.invoice_id, fv.name as fv_name, fv.residual::text as fv_residual, fv.due_date::text as fv_due
    from payments pmt
    join payment_allocs pa on pa.payment_id = pmt.id
    join invoices fv on fv.id = pa.invoice_id
    where pmt.company_id = ${companyId} and pmt.memo = ${"Devolución " + n.name} and pmt.reverses_id is null
      and not exists (select 1 from payments r where r.reverses_id = pmt.id)
    order by pmt.id limit 1
  `;
  if (vp[0]) {
    const v = vp[0];
    preview.virtualPayment = { id: v.id, name: v.name, amount: Number(v.amount) };
    preview.fv = { id: v.invoice_id, name: v.fv_name, residualNow: Number(v.fv_residual), residualAfter: r2(Number(v.fv_residual) + Number(v.amount)), dueDate: v.fv_due };
    // Un abono REAL posterior en la FV: primero el paso 5 (regla del último abono).
    const laterPays = await sql<{ name: string }>`
      select p2.name from payment_allocs pa join payments p2 on p2.id = pa.payment_id
      where pa.invoice_id = ${v.invoice_id} and p2.id > ${v.id} and p2.reverses_id is null
        and not exists (select 1 from payments r where r.reverses_id = p2.id)
      order by p2.id desc
    `;
    if (laterPays.length) blockers.push(`${v.fv_name} tiene ${laterPays.map((x) => x.name).join(", ")} después de esta devolución. Revierte primero ese cobro (Cartera → Revertir último abono).`);
    // La FI que se haya emitido en medio se queda: la venta fue real.
    const fis = await sql<{ name: string; amount: string }>`
      select name, amount::text from invoices where company_id = ${companyId} and inv_class = 'interest' and origin = ${"Mora " + v.fv_name} and state <> 'reversed' and date >= ${n.date}
    `;
    for (const f of fis) keeps.push({ name: f.name, detail: "mora facturada después de la devolución: la venta fue real, ese interés corrió", amount: Number(f.amount), currency: "MXN" });
  }

  // Kardex: los movimientos de regreso de ESTA devolución.
  const moves: Chain["moves"] = [];
  if (!direct && n.so_location) {
    for (const l of lines) {
      const qty = Number(l.qty);
      // Amarre nuevo (Decisión 42): origin = folio de la NC.
      let mv = await sql<{ id: number; ref: string; quantity: string; unit_cost: string; location_to: number; location: string }>`
        select m.id, m.ref, m.quantity::text, coalesce(m.unit_cost,0)::text as unit_cost, m.location_to, loc.name as location
        from stock_moves m left join locations loc on loc.id = m.location_to
        where m.company_id = ${companyId} and m.move_type = 'return' and m.origin = ${n.name} and m.product_id = ${l.product_id}
          and not exists (select 1 from stock_moves r where r.reverses_id = m.id)
        order by m.id desc limit 1
      `;
      let matchedBy: "nc" | "legacy" = "nc";
      if (!mv[0]) {
        // Amarre viejo (origin = pedido): producto + cantidad + fecha, el último sin revertir.
        matchedBy = "legacy";
        mv = await sql<{ id: number; ref: string; quantity: string; unit_cost: string; location_to: number; location: string }>`
          select m.id, m.ref, m.quantity::text, coalesce(m.unit_cost,0)::text as unit_cost, m.location_to, loc.name as location
          from stock_moves m left join locations loc on loc.id = m.location_to
          where m.company_id = ${companyId} and m.move_type = 'return' and m.origin = ${n.so_name ?? ""} and m.product_id = ${l.product_id}
            and m.quantity = ${qty} and m.date = ${n.date}
            and not exists (select 1 from stock_moves r where r.reverses_id = m.id)
          order by m.id desc limit 1
        `;
      }
      if (!mv[0]) {
        blockers.push(`No se puede amarrar el movimiento de regreso de ${l.code} (${qty} ${l.uom}) con ${n.name}: en el kardex no hay una entrada de devolución de ${n.so_name} con esa cantidad y esa fecha sin revertir. No se adivina.`);
        continue;
      }
      const m = mv[0];
      const salidas = await sql<{ ref: string; quantity: string }>`
        select ref, quantity::text from stock_moves
        where company_id = ${companyId} and product_id = ${l.product_id} and location_from = ${m.location_to} and id > ${m.id}
        order by id
      `;
      if (salidas.length) {
        const total = salidas.reduce((s, x) => s + Number(x.quantity), 0);
        blockers.push(
          `Después de la devolución ${n.name} salieron ${total} ${l.uom} de ${l.code} de ${m.location} (${salidas.map((x) => x.ref).join(", ")}). ` +
            "El kardex no lleva lotes: no se puede saber si lo que salió era lo devuelto. Revierte primero esa salida.",
        );
        continue;
      }
      const q = await sql<{ quantity: string; avg_cost: string }>`
        select quantity::text, coalesce(avg_cost,0)::text as avg_cost from stock_quants
        where company_id = ${companyId} and product_id = ${l.product_id} and location_id = ${m.location_to}
      `;
      const qtyBefore = Number(q[0]?.quantity ?? 0);
      stock.push({ code: l.code, product: l.product, uom: l.uom, qty, unitCost: Number(m.unit_cost), value: r2(qty * Number(m.unit_cost)), location: m.location, qtyBefore, qtyAfter: r2(qtyBefore - qty), avg: Number(q[0]?.avg_cost ?? 0), moveRef: m.ref, matchedBy });
      moves.push({ id: m.id, product_id: l.product_id, quantity: qty, unit_cost: Number(m.unit_cost), location_to: m.location_to });
    }
  }

  const debt = await sql<{ total: string }>`
    select coalesce(sum(residual),0)::text as total from invoices
    where company_id = ${companyId} and partner_id = ${n.so_partner_id ?? 0} and kind = 'customer' and state = 'open'
  `;
  const before = Number(debt[0]?.total ?? 0);
  // La NC abierta con saldo negativo (crédito a favor) deja de contar; la FV vuelve a deber lo del abono virtual.
  const after = r2(before - (n.state === "open" ? Number(n.residual) : 0) + (preview.virtualPayment?.amount ?? 0));
  preview.partnerDebt = { name: n.so_partner ?? "", before, after };
  return { preview, companyId, moves, lines: lines.map((l) => ({ product_id: l.product_id, qty: Number(l.qty) })), partnerId: n.so_partner_id ?? 0 };
}

async function auditRejected(sql: Sql, companyId: number, userId: string, chain: Chain) {
  await writeAudit(sql, { companyId, userId, action: "revertir-rechazado", entity: "invoice", entityId: chain.preview.nc.id, name: chain.preview.nc.name, detail: chain.preview.blockers.join(" | ").slice(0, 900) });
}

export const returnReversalPreview = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ ncId: z.number() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    const me = await activeMember(sql, context.userId);
    const chain = await chainForReturn(sql, companyId, data.ncId, me.role);
    if (chain.preview.blockers.length) await auditRejected(sql, companyId, context.userId, chain);
    return chain.preview;
  });

export const reverseReturn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ ncId: z.number(), reason: z.string().trim().min(1, "Escribe el motivo") }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    const me = await activeMember(sql, context.userId);
    const chain = await chainForReturn(sql, companyId, data.ncId, me.role);
    if (chain.preview.blockers.length) { await auditRejected(sql, companyId, context.userId, chain); throw new Error(chain.preview.blockers[0]); }
    if (!canRevert(me.role)) throw new Error("Solo un administrador o gerencia puede revertir una devolución: ya movió inventario y cartera.");
    return withTx(async (tx) => {
      await tx`select id from invoices where id = ${data.ncId} and company_id = ${companyId} for update`;
      await tx`select id from sales_orders where id = ${chain.preview.so.id} and company_id = ${companyId} for update`;
      const fresh = await chainForReturn(tx, companyId, data.ncId, me.role);
      if (fresh.preview.blockers.length) throw new Error(fresh.preview.blockers[0]);
      const today = todayMx();
      const pv = fresh.preview;
      const written: string[] = [];
      // 1) Kardex: sale al costo con el que regresó, ligado a su entrada.
      for (const m of fresh.moves) {
        const mv = await postStock(tx, { companyId, userId: context.userId, moveType: "reversal", origin: pv.nc.name, productId: m.product_id, quantity: m.quantity, locationFrom: m.location_to, unitCost: m.unit_cost, reversesId: m.id });
        written.push(mv.ref);
      }
      // 2) El abono virtual: contra-abono, sin banco, ligado. La FV vuelve a deber.
      if (pv.virtualPayment && pv.fv) {
        const c = await tx<{ c: number }>`select count(*)::int as c from payments where company_id = ${companyId}`;
        const cname = `PAG-${String((c[0]?.c ?? 0) + 1).padStart(4, "0")}`;
        const contra = await tx<{ id: number }>`
          insert into payments (company_id, kind, name, partner_id, amount, memo, created_by, date, reverses_id)
          values (${companyId}, 'inbound', ${cname}, ${fresh.partnerId}, ${-pv.virtualPayment.amount}, ${`Reversa de ${pv.virtualPayment.name} · devolución ${pv.nc.name}`}, ${context.userId}, ${today}, ${pv.virtualPayment.id})
          returning id
        `;
        await tx`insert into payment_allocs (payment_id, invoice_id, amount) values (${contra[0]!.id}, ${pv.fv.id}, ${-pv.virtualPayment.amount})`;
        await refreshInvoiceResidual(tx, pv.fv.id);
        written.push(cname);
      }
      // 3) La NC queda revertida por estado (sin documento contrario).
      await tx`update invoices set state = 'reversed', cancelled_at = now(), cancelled_by = ${context.userId}, cancel_reason = ${data.reason} where id = ${pv.nc.id} and company_id = ${companyId}`;
      // 4) La partida: lo devuelto, de regreso.
      for (const l of fresh.lines) {
        await tx`update sales_lines set qty_returned = greatest(0, qty_returned - ${l.qty}) where so_id = ${pv.so.id} and product_id = ${l.product_id}`;
      }
      await writeAudit(tx, {
        companyId, userId: context.userId, action: "revertir-devolucion", entity: "invoice", entityId: pv.nc.id, name: pv.nc.name,
        detail: `${pv.so.name} · ${written.join(", ")}${pv.fv ? ` · ${pv.fv.name} saldo ${pv.fv.residualNow.toFixed(2)} → ${pv.fv.residualAfter.toFixed(2)}` : ""}${
          pv.nc.timbrada ? ` · ${pv.nc.name} estaba TIMBRADA (${pv.nc.timbrada.uuid || pv.nc.timbrada.folio}): cancelar ante el SAT desde Compaq y capturar la fecha` : ""
        }${pv.stock.length ? ` · ${pv.stock.map((l) => `${l.code} ${l.qtyBefore} → ${l.qtyAfter} ${l.uom} (${l.moveRef}, amarre ${l.matchedBy === "nc" ? "por NC" : "por producto/cantidad/fecha"})`).join(" · ")}` : ""} · ${data.reason}`,
      });
      return { ok: true as const, written };
    });
  });
