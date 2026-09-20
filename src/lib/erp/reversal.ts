import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql, withTx, type Sql } from "@/lib/db";
import { activeMember, canRevert } from "@/lib/erp/acl";
import { reversalOfAllocation } from "@/lib/erp/advance";
import { writeAudit } from "@/lib/erp/audit";
import { refreshInvoiceResidual } from "@/lib/erp/stock";
import { nextDocFolio } from "@/lib/erp/folios";
import { todayMx } from "@/lib/utils";

/**
 * BLOQUE DE DESHACER, paso 5: reversa de un cobro o pago.
 *
 * Decisión 16: NUNCA se borra un movimiento de dinero. Se mete uno contrario
 * y quedan los tres: el error, la reversa y —cuando alguien lo capture— el
 * correcto. El contrario es del mismo tipo con importe NEGATIVO (no un tipo
 * contrario): así "cobros" y "pagos" del P&L netean en cero, que es la verdad.
 * Todo queda ligado por `reverses_id`.
 *
 * La cadena de un cobro (applyInvoicePayment, ops.ts): FI de mora, PAG +
 * abono, movimiento de banco, ajuste de TC (ATC o fx_result), PAG de pronto
 * pago, paid_date. De eso:
 *   - La FI SE QUEDA (Decisión 21): ese interés sí corrió. La siguiente FI
 *     cobra solo de ahí en adelante (interestNew = total − ya facturado).
 *   - El PAG, su abono y el banco se contrarían; el pronto pago también
 *     (dependía de este cobro); el ATC se marca revertido si no tiene abonos;
 *     fx_result regresa el diferencial, que es derivable exacto:
 *     |movimiento de banco| − importe del PAG.
 *   - La reversa del banco nace SIN conciliar y el original no se toca
 *     (Decisión 22).
 *   - paid_date se limpia sola (refreshInvoiceResidual) y la mora vuelve a
 *     correr desde el plazo financiero; lo ya facturado se queda.
 *
 * Regla del último abono: solo se revierte el último abono vivo de esa
 * factura. Los campos de TC de la factura, el pronto pago y paid_date
 * asumen ese orden; revertir uno de en medio sería adivinar. Si quieren uno
 * anterior, primero el posterior — la pantalla lo dice con el folio.
 *
 * Se detiene, antes de tocar nada, con: un abono posterior vivo; el abono
 * virtual de una devolución (es parte de la NC, paso 8); una reversa (no se
 * revierte una reversa: se captura el cobro correcto); un ATC que ya tiene
 * abonos. El intento rechazado queda en bitácora (Decisión 32). Cartera y
 * banco ya movidos: solo administrador o gerencia (Decisión 15).
 */

export type ReversalLine = { name: string; detail: string; amount: number; currency: string };

export type ReversalPreview = {
  payment: { id: number; name: string; kind: "inbound" | "outbound"; amount: number; date: string; partner: string; bank: string | null; memo: string };
  invoice: { id: number; name: string; currency: string; residualNow: number; residualAfter: number; dueDate: string; moraDue: string | null };
  reverts: ReversalLine[];
  keeps: ReversalLine[];
  bank: { name: string; before: number; after: number; reconciled: boolean } | null;
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
  preview: ReversalPreview;
  companyId: number;
  invoiceId: number;
  bankMove: { id: number; bank_id: number; bank: string; amount: number; reconciled: boolean; partner_id: number | null; kind: string; invoice_id: number | null; currency: string; amount_fx: number | null; fx_rate: number | null } | null;
  discount: { id: number; name: string; amount: number } | null;
  atc: { id: number; name: string; amount: number } | null;
  fxDiff: number;
  fxPrev: { paid: number | null; treatment: string | null } | null;
  isUsdCustomer: boolean;
  /** Decisión 80: también la FP en dólares pagada con pesos tiene diferencial (signo contrario). */
  isUsd: boolean;
  fxResultDelta: number;
  /**
   * Un SALDO A FAVOR (L5, Decisión 12): un cobro sin aplicar a ninguna
   * factura. Su reversa es mucho más simple —no hay saldo que rehacer, ni FI,
   * ni ATC, ni pronto pago—: solo el contra-PAG y el contra-movimiento de
   * banco. Y el contra-PAG nace SIN aplicación, igual que el original.
   */
  isAdvance: boolean;
  /** Lo que el PAG le abonó a SU factura (puede ser menos que su importe: L5). */
  allocAmount: number;
  /** El abono contrario que se escribe. Misma cuenta que `residualAfter`. */
  contraAlloc: number;
};

/** La cadena completa de un PAG: qué se contraría, qué se queda, qué lo detiene. No escribe nada. */
async function chainForPayment(sql: Sql, companyId: number, paymentId: number, role: string): Promise<Chain> {
  const blockers: string[] = [];
  const reverts: ReversalLine[] = [];
  const keeps: ReversalLine[] = [];

  const pay = await sql<{
    id: number;
    name: string;
    kind: "inbound" | "outbound";
    amount: string;
    date: string;
    memo: string;
    partner_id: number;
    partner: string;
    reverses_id: number | null;
    reversed_by: string | null;
  }>`
    select p.id, p.name, p.kind, p.amount::text, p.date::text, p.memo, p.partner_id, pt.name as partner, p.reverses_id,
      (select r.name from payments r where r.reverses_id = p.id limit 1) as reversed_by
    from payments p join partners pt on pt.id = p.partner_id
    where p.id = ${paymentId} and p.company_id = ${companyId}
  `;
  if (!pay[0]) throw new Error("Pago no encontrado");
  const p = pay[0];
  const amount = Number(p.amount);
  const empty = (): Chain => ({
    preview: {
      payment: { id: p.id, name: p.name, kind: p.kind, amount, date: p.date, partner: p.partner, bank: null, memo: p.memo },
      invoice: { id: 0, name: "", currency: "MXN", residualNow: 0, residualAfter: 0, dueDate: "", moraDue: null },
      reverts,
      keeps,
      bank: null,
      partnerDebt: { name: p.partner, before: 0, after: 0 },
      blockers,
      allowed: canRevert(role),
      role,
    },
    companyId,
    invoiceId: 0,
    bankMove: null,
    discount: null,
    atc: null,
    fxDiff: 0,
    fxPrev: null,
    isUsdCustomer: false,
    isUsd: false,
    fxResultDelta: 0,
    isAdvance: false,
    allocAmount: 0,
    contraAlloc: 0,
  });

  if (p.reverses_id) {
    blockers.push(`${p.name} ya es una reversa. Una reversa no se revierte: para corregir, se captura el cobro o pago correcto.`);
    return empty();
  }
  if (p.reversed_by) {
    blockers.push(`${p.name} ya está revertido (${p.reversed_by}).`);
    return empty();
  }
  if (p.memo.startsWith("Devolución ")) {
    blockers.push(`${p.name} es el abono de una devolución (${p.memo.replace("Devolución ", "")}): se revierte con la devolución. Usa «Revertir devolución» en el pedido, junto a la nota de crédito ${p.memo.replace("Devolución ", "")}.`);
    return empty();
  }
  // El saldo a favor que dejó una DEVOLUCIÓN cuelga de su nota de crédito: si
  // se revirtiera solo, el crédito se extinguiría y quedarían vivos la NC, el
  // movimiento de kardex y el `qty_returned` de la partida — media reversa
  // desde la pantalla equivocada. Se va con su devolución (L3c).
  if (p.memo.startsWith("Saldo a favor (devolución ")) {
    const nc = p.memo.slice("Saldo a favor (devolución ".length).replace(/\)$/, "");
    blockers.push(
      `${p.name} es el saldo a favor que dejó la devolución ${nc}: se deshace revirtiendo esa devolución, no solo. Si lo que quieres es quitarlo de la factura a la que se aplicó, usa «Quitar de esta factura».`,
    );
    return empty();
  }
  if (p.memo.startsWith("Pronto pago ")) {
    blockers.push(`${p.name} es la bonificación de pronto pago de un cobro: se revierte junto con ese cobro, no sola.`);
    return empty();
  }

  // APLICACIONES VIVAS, no filas. Desaplicar no borra: deja la aplicación y su
  // contraria (+X, −X), que suman cero. Contando filas, un anticipo aplicado y
  // luego quitado parecía «repartido entre 2 facturas» y quedaba bloqueado —
  // y la salida que el mensaje nombraba («Quitar de esta factura») contestaba
  // «ya no le abona nada». Candado sin salida, que es peor que el bug que
  // tapa: el dinero del cliente se quedaba atrapado como crédito para siempre.
  const vivas = await sql<{ invoice_id: number; amount: string }>`
    select invoice_id, sum(amount)::text as amount from payment_allocs
    where payment_id = ${p.id} group by invoice_id having sum(amount) > 0.009 order by min(id)
  `;
  // CERO aplicaciones vivas = saldo a favor (L5, Decisión 12): dinero recibido
  // que todavía no se aplicó a nada. Se revierte por el camino corto de abajo.
  if (vivas.length === 0) {
    const bmA = await sql<{
      id: number; bank_id: number; bank: string; amount: string; reconciled: boolean; partner_id: number | null;
      kind: string; invoice_id: number | null; currency: string; amount_fx: string | null; fx_rate: string | null;
    }>`
      select m.id, m.bank_id, b.name as bank, m.amount::text, m.reconciled, m.partner_id, m.kind, m.invoice_id,
        coalesce(b.currency,'MXN') as currency, m.amount_fx::text, m.fx_rate::text
      from bank_moves m join banks b on b.id = m.bank_id
      where m.payment_id = ${p.id} and m.company_id = ${companyId} limit 1
    `;
    const bank = bmA[0]
      ? { id: bmA[0].id, bank_id: bmA[0].bank_id, bank: bmA[0].bank, amount: Number(bmA[0].amount), reconciled: bmA[0].reconciled,
          partner_id: bmA[0].partner_id, kind: bmA[0].kind, invoice_id: bmA[0].invoice_id, currency: bmA[0].currency,
          amount_fx: bmA[0].amount_fx == null ? null : Number(bmA[0].amount_fx), fx_rate: bmA[0].fx_rate == null ? null : Number(bmA[0].fx_rate) }
      : null;
    const base = empty();
    reverts.push({ name: p.name, detail: `saldo a favor de ${p.partner} sin aplicar a ninguna factura → contra-cobro por el mismo importe`, amount, currency: bank?.currency ?? "MXN" });
    if (bank) reverts.push({ name: bank.bank, detail: "el movimiento de banco se contraría; el contrario nace sin conciliar", amount: -bank.amount, currency: bank.currency });
    return { ...base, bankMove: bank, isAdvance: true };
  }
  // VARIAS aplicaciones: el dinero está bien, lo que está mal es dónde cayó.
  // La salida NO es revertir el cobro (eso devolvería dinero que sí entró):
  // es **desaplicarlo** de la factura equivocada, y entonces vuelve a ser
  // saldo a favor. Un candado sin salida sería peor que el problema.
  if (vivas.length > 1) {
    blockers.push(
      `${p.name} está repartido entre ${vivas.length} facturas. Para corregir a cuál se aplicó, usa «Quitar de esta factura» en el renglón que esté mal: el dinero regresa al saldo a favor del cliente y de ahí lo puedes aplicar a la correcta. Revertir el cobro completo solo procede si el dinero nunca debió entrar.`,
    );
    return empty();
  }
  const invoiceId = vivas[0]!.invoice_id;
  // Lo que este PAG le abonó a ESA factura. Hasta el 19-sep-2026 siempre era
  // igual al importe del PAG, porque un cobro nacía aplicado completo. Con el
  // saldo a favor (L5) un PAG puede estar aplicado en PARTE, y el contrario
  // tiene que contrariar la aplicación — si contrariara el importe del PAG,
  // la factura quedaría debiendo la diferencia, deuda que nadie contrajo.
  const allocAmount = Number(vivas[0]!.amount);
  const inv = await sql<{
    id: number;
    name: string;
    kind: string;
    currency: string;
    amount: string;
    residual: string;
    opening_paid: string;
    due_date: string;
    credit_due: string | null;
    state: string;
    fx_agreed: string;
    fx_treatment: string;
    inv_class: string;
  }>`
    select id, name, kind, coalesce(currency,'MXN') as currency, amount::text, residual::text,
      coalesce(opening_paid,0)::text as opening_paid, due_date::text, credit_due::text, state,
      coalesce(fx_agreed,0)::text as fx_agreed, coalesce(fx_treatment,'') as fx_treatment, coalesce(inv_class,'product') as inv_class
    from invoices where id = ${invoiceId} and company_id = ${companyId}
  `;
  if (!inv[0]) throw new Error("Factura del abono no encontrada");
  const i = inv[0];

  // Todos los abonos VIVOS de esa factura (sin reversas ni revertidos), en orden.
  const live = await sql<{ id: number; name: string; date: string; amount: string; memo: string; has_bank: boolean }>`
    select p2.id, p2.name, p2.date::text, pa.amount::text, p2.memo,
      exists(select 1 from bank_moves b where b.payment_id = p2.id) as has_bank
    from payment_allocs pa join payments p2 on p2.id = pa.payment_id
    where pa.invoice_id = ${invoiceId} and p2.reverses_id is null
      and not exists (select 1 from payments r where r.reverses_id = p2.id)
    order by p2.id
  `;
  // El pronto pago que nació con ESTE cobro: misma factura, misma fecha,
  // nació justo después, sin banco. Va en la cadena, no es "posterior".
  const discountRow = live.find((l) => l.id > p.id && l.date === p.date && !l.has_bank && l.memo === `Pronto pago ${i.name}`) ?? null;
  const later = live.filter((l) => l.id > p.id && l.id !== discountRow?.id);
  if (later.length) {
    blockers.push(
      `${later.map((l) => l.name).join(", ")} ${later.length === 1 ? "es un abono posterior" : "son abonos posteriores"} a ${p.name} sobre ${i.name}. Se revierte primero el último: ${later[later.length - 1]!.name}.`,
    );
  }

  // El movimiento de banco original (el pronto pago y la devolución no tienen).
  const bm = await sql<{ id: number; bank_id: number; bank: string; amount: string; reconciled: boolean; partner_id: number | null; kind: string; invoice_id: number | null; currency: string; amount_fx: string | null; fx_rate: string | null }>`
    select m.id, m.bank_id, b.name as bank, m.amount::text, m.reconciled, m.partner_id, coalesce(m.kind,'ajuste') as kind, m.invoice_id, coalesce(b.currency,'MXN') as currency,
      m.amount_fx::text, m.fx_rate::text
    from bank_moves m join banks b on b.id = m.bank_id
    where m.payment_id = ${p.id} and m.reverses_id is null
    order by m.id limit 1
  `;
  const bankMove = bm[0]
    ? { ...bm[0], amount: Number(bm[0].amount), amount_fx: bm[0].amount_fx != null ? Number(bm[0].amount_fx) : null, fx_rate: bm[0].fx_rate != null ? Number(bm[0].fx_rate) : null }
    : null;

  // Diferencial cambiario del tramo, derivable exacto: lo que entró (o salió)
  // del banco menos lo que se aplicó a la factura. Solo cuando la factura en
  // dólares se pagó con PESOS: desde la cuenta en dólares el banco lleva
  // dólares y no hay diferencial. Decisión 80: en los dos lados.
  const usdInvoice = i.currency === "USD" && Number(i.fx_agreed) > 0;
  const paidInMxn = !bankMove || bankMove.currency !== "USD";
  const isUsdCustomer = i.kind === "customer" && usdInvoice && paidInMxn;
  const isUsdSupplier = i.kind === "supplier" && usdInvoice && paidInMxn;
  const isUsd = isUsdCustomer || isUsdSupplier;
  const fxDiff = isUsdCustomer && bankMove ? r2(Math.abs(bankMove.amount) - amount) : 0;
  const fxDiffSupplier = isUsdSupplier && bankMove ? r2(Math.abs(bankMove.amount) - amount) : 0;
  const fxDelta = isUsdSupplier ? fxDiffSupplier : fxDiff;
  // Lo que se registró en fx_result: utilidad para el cliente que pagó de más, pérdida si se le pagó de más al proveedor.
  const fxResultDelta = isUsdSupplier ? r2(-fxDiffSupplier) : fxDiff;

  // El ATC que nació con este cobro (tratamiento "ajuste").
  let atc: Chain["atc"] = null;
  if (isUsd && Math.abs(fxDelta) >= 0.01) {
    const atcs = await sql<{ id: number; name: string; amount: string; state: string; paid: string }>`
      select a.id, a.name, a.amount::text, a.state,
        coalesce((select sum(amount) from payment_allocs where invoice_id = a.id), 0)::text as paid
      from invoices a
      where a.company_id = ${companyId} and a.inv_class = 'fx' and a.origin = ${"Ajuste TC " + i.name}
        and a.date = ${p.date} and a.state <> 'reversed'
      order by a.id
    `;
    if (atcs.length > 1) {
      blockers.push(`Hay ${atcs.length} ajustes de tipo de cambio de ${i.name} con fecha ${p.date}; no se puede saber cuál nació con ${p.name}.`);
    } else if (atcs[0]) {
      if (Number(atcs[0].paid) > 0.009 || atcs[0].state === "paid") {
        blockers.push(`${atcs[0].name} (el ajuste de tipo de cambio de este cobro) ya tiene abonos. Revierte ese cobro primero.`);
      } else {
        atc = { id: atcs[0].id, name: atcs[0].name, amount: Number(atcs[0].amount) };
      }
    }
  }
  // Con el último abono fuera, los campos de TC de la factura regresan al
  // abono anterior (derivable de sus propios importes) o a vacío.
  let fxPrev: Chain["fxPrev"] = null;
  if (isUsd) {
    const prev = [...live].reverse().find((l) => l.id < p.id && l.has_bank);
    if (prev) {
      const prevBank = await sql<{ amount: string; fx_rate: string | null; currency: string }>`
        select m.amount::text, m.fx_rate::text, coalesce(b.currency,'MXN') as currency
        from bank_moves m join banks b on b.id = m.bank_id where m.payment_id = ${prev.id} and m.reverses_id is null limit 1
      `;
      const usd = Number(prev.amount) / Number(i.fx_agreed);
      // Si el abono anterior salió de la cuenta en dólares, el banco lleva dólares y
      // |banco| ÷ USD daría 1: ahí no hubo TC del día (se toma el guardado, o nada).
      const paid =
        prevBank[0] && prevBank[0].currency === "USD"
          ? (prevBank[0].fx_rate != null && Number(prevBank[0].fx_rate) > 1 ? Number(prevBank[0].fx_rate) : null)
          : prevBank[0] && usd > 0
            ? Math.round((Math.abs(Number(prevBank[0].amount)) / usd) * 10000) / 10000
            : null;
      const prevAtc = await sql<{ n: number }>`
        select count(*)::int as n from invoices where company_id = ${companyId} and inv_class = 'fx' and origin = ${"Ajuste TC " + i.name} and date = ${prev.date}
      `;
      fxPrev = { paid, treatment: paid == null ? null : (prevAtc[0]?.n ?? 0) > 0 ? "ajuste" : "utilidad" };
    } else {
      fxPrev = { paid: null, treatment: null };
    }
  }

  // La FI que nació en el mismo clic: se queda (Decisión 21).
  const fis = await sql<{ name: string; amount: string }>`
    select name, amount::text from invoices
    where company_id = ${companyId} and inv_class = 'interest' and origin = ${"Mora " + i.name} and date = ${p.date} and state <> 'reversed'
    order by id
  `;

  // Números: banco y saldo antes/después.
  const bankNow = bankMove
    ? await sql<{ total: string }>`
        select (b.opening + coalesce((select sum(amount) from bank_moves m where m.bank_id = b.id),0))::text as total
        from banks b where b.id = ${bankMove.bank_id}
      `
    : [];
  const bankBefore = bankNow[0] ? Number(bankNow[0].total) : 0;
  const discount = discountRow ? { id: discountRow.id, name: discountRow.name, amount: Number(discountRow.amount) } : null;
  const residualNow = Number(i.residual);
  // Los dos números —lo que se promete y lo que se escribe— salen de la misma
  // cuenta (`reversalOfAllocation`, pura y probada con números), para que no
  // puedan volver a separarse: se prometía devolver $300 y se escribían $200.
  const rev = reversalOfAllocation({ residualNow, allocAmount, discount: discount?.amount ?? 0 });
  const residualAfter = rev.residualAfter;
  const debt = await sql<{ total: string }>`
    select coalesce(sum(residual),0)::text as total from invoices
    where company_id = ${companyId} and partner_id = ${p.partner_id} and kind = ${i.kind} and state = 'open' and amount > 0
  `;
  const debtBefore = Number(debt[0]?.total ?? 0);
  const debtAfter = r2(debtBefore + (residualAfter - residualNow) - (atc ? atc.amount : 0));

  reverts.push({ name: p.name, detail: `${p.kind === "inbound" ? "cobro" : "pago"} ${p.date} → contra-${p.kind === "inbound" ? "cobro" : "pago"} por el mismo importe, en negativo, ligado a ${p.name}`, amount: -amount, currency: i.currency });
  if (bankMove) {
    reverts.push({
      name: bankMove.bank,
      detail: `movimiento del ${p.date} (${bankMove.reconciled ? "conciliado, se queda así" : "sin conciliar"}) → contra-movimiento de hoy, sin conciliar`,
      amount: -bankMove.amount,
      currency: "MXN",
    });
  }
  if (discount) reverts.push({ name: discount.name, detail: "pronto pago que dependía de este cobro → contra-abono, sin banco", amount: -discount.amount, currency: i.currency });
  if (atc) reverts.push({ name: atc.name, detail: `ajuste de tipo de cambio de este cobro (${atc.amount < 0 ? "por devolver" : "por cobrar"}), sin abonos → se marca revertido`, amount: atc.amount, currency: "MXN" });
  if (isUsd && Math.abs(fxDelta) >= 0.01 && !atc && !blockers.some((b) => b.includes("ajuste"))) {
    reverts.push({ name: i.name, detail: `${fxResultDelta >= 0 ? "utilidad" : "pérdida"} cambiaria de este ${i.kind === "supplier" ? "pago" : "cobro"} registrada en la factura → se regresa`, amount: -fxResultDelta, currency: "MXN" });
  }
  for (const f of fis) keeps.push({ name: f.name, detail: `mora facturada con este cobro: ese interés sí corrió (Decisión 21). Lo que se facture después empieza donde ésta se detuvo`, amount: Number(f.amount), currency: "MXN" });

  return {
    preview: {
      payment: { id: p.id, name: p.name, kind: p.kind, amount, date: p.date, partner: p.partner, bank: bankMove?.bank ?? null, memo: p.memo },
      invoice: { id: i.id, name: i.name, currency: i.currency, residualNow, residualAfter, dueDate: i.due_date, moraDue: i.credit_due },
      reverts,
      keeps,
      bank: bankMove ? { name: bankMove.bank, before: bankBefore, after: r2(bankBefore - bankMove.amount), reconciled: bankMove.reconciled } : null,
      partnerDebt: { name: p.partner, before: debtBefore, after: debtAfter },
      blockers,
      allowed: canRevert(role),
      role,
    },
    companyId,
    invoiceId,
    bankMove,
    discount,
    atc,
    fxDiff,
    fxPrev,
    isUsdCustomer,
    isUsd,
    fxResultDelta,
    isAdvance: false,
    allocAmount,
    contraAlloc: rev.contraAlloc,
  };
}

async function auditRejected(sql: Sql, companyId: number, userId: string, chain: Chain) {
  await writeAudit(sql, {
    companyId,
    userId,
    action: "revertir-rechazado",
    entity: "payment",
    entityId: chain.preview.payment.id,
    name: chain.preview.payment.name,
    detail: chain.preview.blockers.join(" | ").slice(0, 900),
  });
}

/** Lo que la pantalla enseña antes de preguntar una vez (Decisión 25). Si está bloqueado, el intento queda en bitácora. */
export const reversalPreview = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ paymentId: z.number() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    const me = await activeMember(sql, context.userId);
    const chain = await chainForPayment(sql, companyId, data.paymentId, me.role);
    if (chain.preview.blockers.length) await auditRejected(sql, companyId, context.userId, chain);
    return chain.preview;
  });

async function applyReversal(sql: Sql, userId: string, chain: Chain, reason: string) {
  const { companyId, invoiceId } = chain;
  const pv = chain.preview;
  const today = todayMx();
  const written: string[] = [];

  const nextPag = () => nextDocFolio(sql, companyId, "PAG");
  const partnerId = (await sql<{ partner_id: number }>`select partner_id from payments where id = ${pv.payment.id}`)[0]!.partner_id;

  // 1) El pronto pago que dependía de este cobro: contra-abono, sin banco.
  if (chain.discount) {
    const dname = await nextPag();
    const d = await sql<{ id: number }>`
      insert into payments (company_id, kind, name, partner_id, amount, memo, created_by, date, reverses_id)
      values (${companyId}, 'inbound', ${dname}, ${partnerId}, ${-chain.discount.amount}, ${`Reversa de ${chain.discount.name} · pronto pago de ${pv.payment.name}`}, ${userId}, ${today}, ${chain.discount.id})
      returning id
    `;
    await sql`insert into payment_allocs (payment_id, invoice_id, amount) values (${d[0]!.id}, ${invoiceId}, ${-chain.discount.amount})`;
    written.push(dname);
  }

  // 2) Tipo de cambio: el ATC se marca revertido; el diferencial en la factura se regresa.
  if (chain.atc) {
    await sql`
      update invoices set state = 'reversed', cancelled_at = now(), cancelled_by = ${userId}, cancel_reason = ${reason}
      where id = ${chain.atc.id} and company_id = ${companyId}
    `;
    await writeAudit(sql, { companyId, userId, action: "revertir-atc", entity: "invoice", entityId: chain.atc.id, name: chain.atc.name, detail: `Revertido con ${pv.payment.name} · ${chain.atc.amount.toFixed(2)} · sin abonos · ${reason}` });
    written.push(`${chain.atc.name} revertida`);
  }
  if (chain.isUsd) {
    const fxBack = chain.atc ? 0 : chain.fxResultDelta;
    await sql`
      update invoices set
        fx_result = fx_result - ${fxBack},
        fx_invoiced = greatest(0, fx_invoiced - ${Math.max(0, -chain.fxDiff)}),
        fx_paid = ${chain.fxPrev?.paid ?? null},
        fx_treatment = ${chain.fxPrev?.treatment ?? ""}
      where id = ${invoiceId} and company_id = ${companyId}
    `;
  }

  // 3) El contra-PAG y su contra-abono: mismo tipo, importe negativo, ligado.
  const cname = await nextPag();
  const contra = await sql<{ id: number }>`
    insert into payments (company_id, kind, name, partner_id, amount, memo, created_by, date, reverses_id)
    values (${companyId}, ${pv.payment.kind}, ${cname}, ${partnerId}, ${-pv.payment.amount}, ${`Reversa de ${pv.payment.name} · ${reason}`}, ${userId}, ${today}, ${pv.payment.id})
    returning id
  `;
  // Un saldo a favor no está aplicado a ninguna factura: su contrario tampoco.
  if (!chain.isAdvance) {
    await sql`insert into payment_allocs (payment_id, invoice_id, amount) values (${contra[0]!.id}, ${invoiceId}, ${chain.contraAlloc})`;
  }
  written.push(cname);

  // 4) El contra-movimiento de banco: importe opuesto, nace sin conciliar, ligado.
  if (chain.bankMove) {
    await sql`
      insert into bank_moves (company_id, bank_id, date, amount, memo, partner_id, kind, invoice_id, payment_id, amount_fx, fx_rate, created_by, reconciled, reverses_id)
      values (${companyId}, ${chain.bankMove.bank_id}, ${today}, ${-chain.bankMove.amount}, ${`Reversa de ${pv.payment.name}`},
        ${chain.bankMove.partner_id}, ${chain.bankMove.kind}, ${chain.bankMove.invoice_id}, ${contra[0]!.id}, ${chain.bankMove.amount_fx != null ? -chain.bankMove.amount_fx : null}, ${chain.bankMove.fx_rate}, ${userId}, false, ${chain.bankMove.id})
    `;
  }

  // 5) La factura vuelve a deber: el saldo se rehace desde los abonos (+A −A) y
  //    paid_date se limpia; 'paid' → 'open' es justo la transición que
  //    nextInvoiceState permite (una 'reversed' no se toca).
  const residual = chain.isAdvance ? 0 : await refreshInvoiceResidual(sql, invoiceId);

  await writeAudit(sql, {
    companyId,
    userId,
    action: chain.isAdvance ? "revertir-saldo-a-favor" : "revertir-pago",
    entity: chain.isAdvance ? "payment" : "invoice",
    entityId: chain.isAdvance ? pv.payment.id : invoiceId,
    name: chain.isAdvance ? pv.payment.name : pv.invoice.name,
    detail: `${pv.payment.name} ${pv.payment.kind === "inbound" ? "cobro" : "pago"} ${pv.payment.amount.toFixed(2)} del ${pv.payment.date} → ${written.join(", ")}${
      chain.bankMove ? ` · ${chain.bankMove.bank} ${(-chain.bankMove.amount).toFixed(2)} sin conciliar` : ""
    } · saldo ${pv.invoice.residualNow.toFixed(2)} → ${residual.toFixed(2)}${pv.keeps.length ? ` · se queda ${pv.keeps.map((k) => k.name).join(", ")}` : ""} · ${reason}`,
  });
  return { ok: true as const, reversal: cname, written, residual };
}

/** Revertir un cobro o pago: una acción, todo o nada. Solo administrador o gerencia. */
export const reversePayment = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ paymentId: z.number(), reason: z.string().trim().min(1, "Escribe el motivo") }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    const me = await activeMember(sql, context.userId);
    const chain = await chainForPayment(sql, companyId, data.paymentId, me.role);
    if (chain.preview.blockers.length) {
      await auditRejected(sql, companyId, context.userId, chain);
      throw new Error(chain.preview.blockers[0]);
    }
    if (!canRevert(me.role)) throw new Error("Solo un administrador o gerencia puede revertir un cobro o pago: ya movió cartera y banco.");
    return withTx(async (tx) => {
      // Candado real: bloquear y volver a leer la cadena adentro de la transacción.
      await tx`select id from payments where id = ${data.paymentId} and company_id = ${companyId} for update`;
      await tx`select id from invoices where id = ${chain.invoiceId} and company_id = ${companyId} for update`;
      if (chain.bankMove) await tx`select id from banks where id = ${chain.bankMove.bank_id} for update`;
      const fresh = await chainForPayment(tx, companyId, data.paymentId, me.role);
      if (fresh.preview.blockers.length) throw new Error(fresh.preview.blockers[0]);
      return applyReversal(tx, context.userId, fresh, data.reason);
    });
  });
