import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql, withTx, type Sql } from "@/lib/db";
import { activeMember, assertCan, canRevert, type ModuleId } from "@/lib/erp/acl";
import { writeAudit } from "@/lib/erp/audit";

/**
 * BLOQUE DE DESHACER, paso 4: cancelar en cascada.
 *
 *   - Una OC confirmada sin recibir.
 *   - Un pedido confirmado sin entregar, con sus OC hijas.
 *
 * Reglas (DECISIONES.md): lo que no movió nada se CANCELA — se marca, se
 * conserva, nunca se borra (15). El pedido confirmado se cancela y lo que sí
 * movió con él (la FP vieja de sus OC, la del defecto que corrigió la
 * Decisión 14) se REVIERTE en cascada (17). Revertir cartera es solo de
 * administrador o gerencia; cancelar lo que no movió nada, del permiso del
 * módulo (15, 24). Una sola acción que enseña la cadena completa y pregunta
 * una vez: todo o nada (25). La cotización de origen no se toca: queda
 * aceptada con su precio; para vender otra vez se cotiza de nuevo (18).
 *
 * Fuera de aquí: cualquier cosa que ya movió inventario o cartera de verdad
 * (entrega, recepción, pago). Eso son los pasos 5 a 8. Si la cadena topa con
 * algo así, se detiene ANTES de tocar nada y dice por qué, y el intento queda
 * en bitácora: alguien creyó que ese documento estaba mal, y eso es
 * información.
 */

export type ChainDoc = {
  kind: "sale" | "purchase" | "supplier_invoice" | "quote";
  id: number;
  name: string;
  partner: string;
  total: number;
  currency: string;
  state: string;
  residual?: number;
  dueDate?: string;
  note: string;
};

export type CancelChain = {
  root: { kind: "sale" | "purchase"; id: number; name: string };
  cancels: ChainDoc[];
  reverts: ChainDoc[];
  keeps: ChainDoc[];
  blockers: string[];
  revertsCartera: boolean;
  needsRole: "admin_gerencia" | "module";
  allowed: boolean;
  role: string;
};

async function cid(sql: Sql, userId: string) {
  const rows = await sql<{ company_id: number }>`select company_id from members where user_id = ${userId} and status = 'active' limit 1`;
  if (!rows[0]) throw new Error("Sin empresa");
  return rows[0].company_id;
}

/** ¿Hay dinero de banco o un gasto amarrado a este pedido / esta OC? */
async function moneyLinked(sql: Sql, companyId: number, col: "so_id" | "po_id", id: number) {
  // El tag sql no anida fragmentos: una consulta por columna, sin interpolar nombres.
  const bank =
    col === "so_id"
      ? await sql<{ n: number }>`select count(*)::int as n from bank_moves where company_id = ${companyId} and so_id = ${id}`
      : await sql<{ n: number }>`select count(*)::int as n from bank_moves where company_id = ${companyId} and po_id = ${id}`;
  const exp =
    col === "so_id"
      ? await sql<{ n: number }>`select count(*)::int as n from expenses where company_id = ${companyId} and so_id = ${id}`
      : await sql<{ n: number }>`select count(*)::int as n from expenses where company_id = ${companyId} and po_id = ${id}`;
  return { bank: bank[0]?.n ?? 0, expenses: exp[0]?.n ?? 0 };
}

/**
 * La cadena de una OC. Lo que se cancela, lo que se revierte y lo que la
 * detiene. No escribe nada.
 */
async function chainForPurchase(sql: Sql, companyId: number, poId: number) {
  const cancels: ChainDoc[] = [];
  const reverts: ChainDoc[] = [];
  const blockers: string[] = [];
  const po = await sql<{
    id: number;
    name: string;
    state: string;
    partner: string;
    total: string;
    currency: string;
    fulfill_kind: string;
    so_id: number | null;
    so_name: string | null;
    so_state: string | null;
  }>`
    select po.id, po.name, po.state, p.name as partner, po.total::text, coalesce(po.currency,'MXN') as currency,
      coalesce(po.fulfill_kind,'inventory') as fulfill_kind, po.so_id, so.name as so_name, so.state as so_state
    from purchase_orders po
    join partners p on p.id = po.partner_id
    left join sales_orders so on so.id = po.so_id
    where po.id = ${poId} and po.company_id = ${companyId}
  `;
  if (!po[0]) throw new Error("Orden de compra no encontrada");
  const o = po[0];
  if (o.state === "cancelled") {
    blockers.push(`${o.name} ya está cancelada.`);
    return { cancels, reverts, blockers };
  }
  // Ya movió inventario: la mercancía entró a bodega.
  const receipts = await sql<{ ref: string }>`
    select ref from stock_moves
    where company_id = ${companyId} and origin = ${o.name} and move_type = 'receipt'
    order by id
  `;
  if (o.state === "done" || receipts.length) {
    blockers.push(
      `${o.name} ya se recibió en bodega${receipts.length ? ` (${receipts.map((r) => r.ref).join(", ")})` : ""}: la mercancía ya entró al inventario. ` +
        "Eso no se cancela, se revierte — y revertir una recepción todavía no está construido.",
    );
  }
  // Directa / brokeraje: nunca se recibe, pero si su pedido ya se entregó al
  // cliente, la mercancía sí se movió (del proveedor al cliente) y su FP es
  // deuda real, no la del defecto viejo.
  if (o.fulfill_kind === "direct" && o.so_state === "done") {
    blockers.push(
      `${o.name} es directa / brokeraje y su pedido ${o.so_name ?? ""} ya se entregó al cliente: la mercancía ya se movió del proveedor al cliente. Eso no se cancela.`,
    );
  }
  const money = await moneyLinked(sql, companyId, "po_id", o.id);
  if (money.bank || money.expenses) {
    blockers.push(
      `${o.name} ya tiene dinero amarrado (${[money.bank ? `${money.bank} movimiento(s) de banco` : "", money.expenses ? `${money.expenses} gasto(s)` : ""].filter(Boolean).join(" y ")}). ` +
        "Eso ya movió cartera o banco y no se cancela por aquí.",
    );
  }
  // La FP que nació con esta OC (defecto anterior a la Decisión 14). Sin abonos
  // se revierte; con un solo abono, ya se le pagó al proveedor: paso 5.
  const fps = await sql<{ id: number; name: string; amount: string; residual: string; due_date: string; state: string; paid: string }>`
    select i.id, i.name, i.amount::text, i.residual::text, i.due_date::text, i.state,
      coalesce((select sum(amount) from payment_allocs where invoice_id = i.id), 0)::text as paid
    from invoices i
    where i.company_id = ${companyId} and i.kind = 'supplier' and i.origin = ${o.name} and i.state <> 'reversed'
    order by i.id
  `;
  for (const fp of fps) {
    if (Number(fp.paid) > 0.009 || fp.state === "paid") {
      blockers.push(
        `${fp.name} (la factura de ${o.partner} por ${o.name}) ya tiene abonos: ya se le pagó al proveedor, en todo o en parte. ` +
          "Primero habría que revertir ese pago, y eso todavía no está construido.",
      );
      continue;
    }
    reverts.push({
      kind: "supplier_invoice",
      id: fp.id,
      name: fp.name,
      partner: o.partner,
      total: Number(fp.amount),
      currency: o.currency,
      state: fp.state,
      residual: Number(fp.residual),
      dueDate: fp.due_date,
      note: "deuda que nació con la orden, antes de que la deuda naciera al recibir; la mercancía nunca llegó — sin abonos",
    });
  }
  cancels.push({
    kind: "purchase",
    id: o.id,
    name: o.name,
    partner: o.partner,
    total: Number(o.total),
    currency: o.currency,
    state: o.state,
    note: o.fulfill_kind === "direct" ? "directa / brokeraje, sin entregar" : "confirmada, sin recibir",
  });
  return { cancels, reverts, blockers };
}

/** La cadena de un pedido confirmado: el pedido, sus OC hijas y las FP viejas de ésas. */
async function chainForSale(sql: Sql, companyId: number, soId: number) {
  const cancels: ChainDoc[] = [];
  const reverts: ChainDoc[] = [];
  const keeps: ChainDoc[] = [];
  const blockers: string[] = [];
  const so = await sql<{
    id: number;
    name: string;
    state: string;
    partner: string;
    total: string;
    currency: string;
    quote_id: number | null;
    quote_name: string | null;
  }>`
    select so.id, so.name, so.state, p.name as partner, so.total::text, coalesce(so.currency,'MXN') as currency,
      so.quote_id, q.name as quote_name
    from sales_orders so
    join partners p on p.id = so.partner_id
    left join quotes q on q.id = so.quote_id
    where so.id = ${soId} and so.company_id = ${companyId}
  `;
  if (!so[0]) throw new Error("Pedido no encontrado");
  const s = so[0];
  if (s.state === "cancelled") {
    blockers.push(`${s.name} ya está cancelado.`);
    return { cancels, reverts, keeps, blockers };
  }
  if (s.state === "draft") {
    blockers.push(`${s.name} sigue en borrador: se cancela desde el pedido, sin cadena (no tiene órdenes de compra hijas todavía).`);
    return { cancels, reverts, keeps, blockers };
  }
  const deliveries = await sql<{ ref: string }>`
    select ref from stock_moves where company_id = ${companyId} and origin = ${s.name} and move_type = 'delivery' order by id
  `;
  const fvs = await sql<{ name: string }>`
    select name from invoices where company_id = ${companyId} and order_id = ${s.id} and kind = 'customer' and state <> 'reversed' order by id
  `;
  if (s.state === "done" || deliveries.length || fvs.length) {
    blockers.push(
      `${s.name} ya se entregó y facturó${fvs.length ? ` (${fvs.map((f) => f.name).join(", ")})` : ""}: la mercancía ya salió y la factura ya existe. ` +
        "Eso no se cancela, se revierte — y revertir una entrega todavía no está construido.",
    );
  }
  const money = await moneyLinked(sql, companyId, "so_id", s.id);
  if (money.bank || money.expenses) {
    blockers.push(
      `${s.name} ya tiene dinero amarrado (${[money.bank ? `${money.bank} movimiento(s) de banco` : "", money.expenses ? `${money.expenses} gasto(s)` : ""].filter(Boolean).join(" y ")}). ` +
        "Eso ya movió cartera o banco y no se cancela por aquí.",
    );
  }
  cancels.push({
    kind: "sale",
    id: s.id,
    name: s.name,
    partner: s.partner,
    total: Number(s.total),
    currency: s.currency,
    state: s.state,
    note: "confirmado, sin entregar — no movió inventario ni cartera",
  });
  const pos = await sql<{ id: number }>`
    select id from purchase_orders where company_id = ${companyId} and so_id = ${s.id} and state <> 'cancelled' order by id
  `;
  for (const po of pos) {
    const sub = await chainForPurchase(sql, companyId, po.id);
    cancels.push(...sub.cancels);
    reverts.push(...sub.reverts);
    blockers.push(...sub.blockers);
  }
  if (s.quote_id && s.quote_name) {
    keeps.push({
      kind: "quote",
      id: s.quote_id,
      name: s.quote_name,
      partner: s.partner,
      total: 0,
      currency: s.currency,
      state: "accepted",
      note: "queda aceptada, con su folio y su precio; para vender otra vez, se cotiza de nuevo (Decisión 18)",
    });
  }
  return { cancels, reverts, keeps, blockers };
}

async function buildChain(sql: Sql, userId: string, kind: "sale" | "purchase", id: number): Promise<CancelChain> {
  const companyId = await cid(sql, userId);
  const module: ModuleId = kind === "sale" ? "sales" : "purchases";
  // Sin permiso de editar el módulo no se cancela nada, ni lo liviano.
  await assertCan(sql, userId, module, "edit");
  const me = await activeMember(sql, userId);
  const parts = kind === "sale" ? await chainForSale(sql, companyId, id) : { ...(await chainForPurchase(sql, companyId, id)), keeps: [] as ChainDoc[] };
  const root = parts.cancels.find((c) => c.kind === kind) ?? { kind, id, name: "" };
  // Decisión 15: revertir cartera (la FP vieja) es de administrador o gerencia;
  // cancelar lo que no movió nada, del permiso del módulo. Depende de lo que
  // la cadena contenga, y la pantalla dice cuál aplica.
  const revertsCartera = parts.reverts.length > 0;
  const needsRole = revertsCartera ? "admin_gerencia" : "module";
  const allowed = !revertsCartera || canRevert(me.role);
  return {
    root: { kind, id, name: root.name },
    cancels: parts.cancels,
    reverts: parts.reverts,
    keeps: parts.keeps,
    blockers: parts.blockers,
    revertsCartera,
    needsRole,
    allowed,
    role: me.role,
  };
}

/** Deja escrito que alguien intentó cancelar y no se pudo. Fuera de transacción: tiene que quedar aunque nada más pase. */
async function auditRejected(sql: Sql, userId: string, chain: CancelChain) {
  const companyId = await cid(sql, userId);
  await writeAudit(sql, {
    companyId,
    userId,
    action: "cancelar-rechazado",
    entity: chain.root.kind,
    entityId: chain.root.id,
    name: chain.root.name,
    detail: chain.blockers.join(" | ").slice(0, 900),
  });
}

/**
 * Lo que la pantalla enseña antes de preguntar (Decisión 25). Solo lectura,
 * salvo una cosa: si la cadena está bloqueada, el intento queda en bitácora.
 */
export const cancelChainPreview = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ kind: z.enum(["sale", "purchase"]), id: z.number() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const chain = await buildChain(sql, context.userId, data.kind, data.id);
    if (chain.blockers.length) await auditRejected(sql, context.userId, chain);
    return chain;
  });

async function applyChain(sql: Sql, userId: string, chain: CancelChain, reason: string) {
  const companyId = await cid(sql, userId);
  const cancelled: string[] = [];
  const reverted: string[] = [];
  for (const fp of chain.reverts) {
    await sql`
      update invoices
      set state = 'reversed', cancelled_at = now(), cancelled_by = ${userId}, cancel_reason = ${reason}
      where id = ${fp.id} and company_id = ${companyId} and state <> 'reversed'
    `;
    reverted.push(fp.name);
    await writeAudit(sql, {
      companyId,
      userId,
      action: "revertir-fp",
      entity: "invoice",
      entityId: fp.id,
      name: fp.name,
      detail: `Revertida al cancelar ${chain.root.name} · importe ${fp.total.toFixed(2)} ${fp.currency} · saldo ${(fp.residual ?? 0).toFixed(2)} · sin abonos · ${reason}`,
    });
  }
  for (const doc of chain.cancels) {
    if (doc.kind === "purchase") {
      await sql`
        update purchase_orders
        set state = 'cancelled', cancelled_at = now(), cancelled_by = ${userId}, cancel_reason = ${reason}
        where id = ${doc.id} and company_id = ${companyId} and state <> 'cancelled'
      `;
      cancelled.push(doc.name);
      await writeAudit(sql, {
        companyId,
        userId,
        action: "cancelar-oc",
        entity: "purchase",
        entityId: doc.id,
        name: doc.name,
        detail: `${doc.note} · ${doc.total.toFixed(2)} ${doc.currency}${chain.root.kind === "sale" ? ` · en cascada por ${chain.root.name}` : ""} · ${reason}`,
      });
    }
  }
  const sale = chain.cancels.find((c) => c.kind === "sale");
  if (sale) {
    await sql`
      update sales_orders
      set state = 'cancelled', cancelled_at = now(), cancelled_by = ${userId}, cancel_reason = ${reason}
      where id = ${sale.id} and company_id = ${companyId} and state <> 'cancelled'
    `;
    cancelled.push(sale.name);
    await writeAudit(sql, {
      companyId,
      userId,
      action: "cancelar-pedido",
      entity: "sale",
      entityId: sale.id,
      name: sale.name,
      detail: `${sale.note} · ${sale.total.toFixed(2)} ${sale.currency} · cadena: ${[...cancelled.filter((n) => n !== sale.name), ...reverted.map((n) => `${n} revertida`)].join(", ") || "sin órdenes hijas"}${
        chain.keeps.length ? ` · ${chain.keeps.map((k) => `${k.name} queda aceptada`).join(", ")}` : ""
      } · ${reason}`,
    });
  }
  return { cancelled, reverted };
}

async function runCancel(userId: string, kind: "sale" | "purchase", id: number, reason: string) {
  const sql = await getSql();
  const chain = await buildChain(sql, userId, kind, id);
  if (chain.blockers.length) {
    await auditRejected(sql, userId, chain);
    throw new Error(chain.blockers[0]);
  }
  if (!chain.allowed) {
    throw new Error("Esta cancelación revierte una deuda ya registrada: solo un administrador o gerencia puede hacerla.");
  }
  return withTx(async (tx) => {
    // Candado real: bloquear los renglones y volver a leer la cadena adentro
    // de la transacción. Si algo cambió entre la pantalla y el clic, se
    // detiene aquí y no se toca nada.
    const companyId = await cid(tx, userId);
    if (kind === "sale") {
      await tx`select id from sales_orders where id = ${id} and company_id = ${companyId} for update`;
      await tx`select id from purchase_orders where so_id = ${id} and company_id = ${companyId} for update`;
    } else {
      await tx`select id from purchase_orders where id = ${id} and company_id = ${companyId} for update`;
    }
    const fresh = await buildChain(tx, userId, kind, id);
    if (fresh.blockers.length) throw new Error(fresh.blockers[0]);
    if (!fresh.allowed) throw new Error("Solo un administrador o gerencia puede revertir una deuda ya registrada");
    return applyChain(tx, userId, fresh, reason);
  });
}

/** Cancelar un pedido confirmado sin entregar, con sus OC hijas (y las FP viejas de ésas, revertidas). */
export const cancelSalesOrderChain = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ soId: z.number(), reason: z.string().trim().min(1, "Escribe el motivo") }))
  .handler(async ({ context, data }) => runCancel(context.userId, "sale", data.soId, data.reason));

/** Cancelar una OC confirmada sin recibir (y su FP vieja, si la trae y no tiene abonos). */
export const cancelPurchaseOrderChain = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ poId: z.number(), reason: z.string().trim().min(1, "Escribe el motivo") }))
  .handler(async ({ context, data }) => runCancel(context.userId, "purchase", data.poId, data.reason));
