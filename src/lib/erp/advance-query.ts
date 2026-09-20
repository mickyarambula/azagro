/**
 * LEER Y APLICAR EL SALDO A FAVOR (L5, Decisiones 12 y 13).
 *
 * Todo lo de aquí se **deriva** de lo que ya está escrito: un cobro con
 * `payments.amount` mayor que la suma de sus `payment_allocs` tiene saldo a
 * favor, y ese resto es el número. No hay columna «anticipo» que se pueda
 * desincronizar del dinero. La aritmética vive aparte y pura en `advance.ts`.
 *
 * Tres verbos, y los tres son el mismo mecanismo:
 *   · **Aplicar**    — insertar una aplicación: el saldo a favor baja, la
 *                      factura baja. Eso es también repartir un depósito entre
 *                      varias facturas (Decisión 13): un cobro con N
 *                      aplicaciones.
 *   · **Desaplicar** — quitarla: el dinero regresa al saldo a favor. Es la
 *                      salida para «lo apliqué a la factura equivocada», que
 *                      no es lo mismo que «este dinero nunca debió entrar»
 *                      (para eso está la reversa, `reversal.ts`).
 *   · **Proponer**   — de la más vieja a la más nueva (Decisión 13). El
 *                      sistema propone, la persona confirma o cambia.
 */
import { z } from "zod";
import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql, withTx } from "@/lib/db";
import { activeMember, assertAdminOrGerencia, assertCan } from "@/lib/erp/acl";
import { writeAudit } from "@/lib/erp/audit";
import { ensureInvoiceExtras, refreshInvoiceResidual } from "@/lib/erp/stock";
import { earlyPayDiscount, issueMoraInvoice, returnedOfInvoices } from "@/lib/erp/ops";
import { applyableCredit, isReturnCredit, moraBase, proposeSplit, unappliedOf } from "@/lib/erp/advance";
import { todayMx } from "@/lib/utils";

type Sql = Awaited<ReturnType<typeof getSql>>;

async function cid(sql: Sql, userId: string) {
  const rows = await sql<{ company_id: number }>`select company_id from members where user_id = ${userId} and status = 'active' limit 1`;
  if (!rows[0]) throw new Error("Sin empresa");
  return rows[0].company_id;
}

export type PartnerCredit = {
  paymentId: number;
  /** inbound = crédito del CLIENTE; outbound = de Azagro con el proveedor. */
  kind: string;
  name: string;
  date: string;
  /** Lo que entró con ese cobro. */
  amount: number;
  /** Lo que ya se aplicó a facturas. */
  applied: number;
  /** Lo que queda disponible: el saldo a favor. */
  available: number;
  currency: string;
  memo: string;
  /** A qué facturas se aplicó, para poder quitarlo de la equivocada. */
  applications: Array<{ invoiceId: number; invoice: string; amount: number }>;
};

/**
 * Los cobros de un socio con saldo a favor. Se excluyen las reversas y lo ya
 * revertido: un contra-PAG nace con importe negativo y no es crédito de nadie.
 */
export async function partnerCredits(sql: Sql, companyId: number, partnerId: number): Promise<PartnerCredit[]> {
  const rows = await sql<{
    id: number; name: string; date: string; amount: string; applied: string; currency: string; memo: string; kind: string;
  }>`
    select p.id, p.name, p.date::text, p.amount::text, coalesce(p.currency,'MXN') as currency, p.memo, p.kind,
      coalesce((select sum(pa.amount) from payment_allocs pa where pa.payment_id = p.id), 0)::text as applied
    from payments p
    where p.company_id = ${companyId} and p.partner_id = ${partnerId}
      and p.amount > 0
      and p.reverses_id is null
      and not exists (select 1 from payments r where r.reverses_id = p.id)
    order by p.date, p.id
  `;
  const out: PartnerCredit[] = [];
  for (const r of rows) {
    const available = unappliedOf(Number(r.amount), Number(r.applied));
    if (available <= 0.009) continue;
    // Agrupado por factura: una aplicación quitada dejó su contraria negativa
    // (nada se borra), así que el par suma cero y no debe aparecer como si
    // siguiera aplicado.
    const apps = await sql<{ invoice_id: number; invoice: string; amount: string }>`
      select pa.invoice_id, i.name as invoice, sum(pa.amount)::text as amount
      from payment_allocs pa join invoices i on i.id = pa.invoice_id
      where pa.payment_id = ${r.id}
      group by pa.invoice_id, i.name
      having sum(pa.amount) > 0.009
      order by min(pa.id)
    `;
    out.push({
      paymentId: r.id, kind: r.kind, name: r.name, date: r.date,
      amount: Number(r.amount), applied: Number(r.applied), available,
      currency: r.currency, memo: r.memo,
      applications: apps.map((a) => ({ invoiceId: a.invoice_id, invoice: a.invoice, amount: Number(a.amount) })),
    });
  }
  return out;
}

/** El saldo a favor de un socio y sus facturas abiertas, con la propuesta de reparto. */
export const getPartnerCredit = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ partnerId: z.number(), lado: z.enum(["cliente", "proveedor"]).optional().default("cliente") }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await assertCan(sql, context.userId, "credit", "view");
    const companyId = await cid(sql, context.userId);
    // Cartera propia también aquí: la pantalla ya filtra la lista, pero el
    // endpoint recibe un `partnerId` y nadie debe poder pedir el de otro.
    const me = await activeMember(sql, context.userId);
    if (me.own_only) {
      const mine = await sql<{ n: number }>`
        select count(*)::int as n from partners
        where id = ${data.partnerId} and company_id = ${companyId}
          and (seller_id = ${context.userId} or seller_id is null)
      `;
      if (!Number(mine[0]?.n ?? 0)) throw new Error("Ese cliente no está en tu cartera.");
    }
    // EL LADO NO SE CRUZA (regla 5). Un socio puede ser cliente y proveedor a
    // la vez; un sobrante que Azagro le pagó de más NO es crédito del cliente,
    // y aplicarlo a una factura de venta bajaría la cuenta por cobrar sin que
    // entrara un peso.
    const kindWanted = data.lado === "proveedor" ? "outbound" : "inbound";
    const invKind = data.lado === "proveedor" ? "supplier" : "customer";
    const credits = (await partnerCredits(sql, companyId, data.partnerId)).filter((c) => c.kind === kindWanted);
    // Las facturas abiertas, de la MÁS VIEJA a la más nueva: ese orden es la
    // propuesta (Decisión 13), y por eso lo pone la consulta, no la pantalla.
    const open = await sql<{ id: number; name: string; date: string; residual: string; currency: string }>`
      select i.id, i.name, i.date::text, i.residual::text, coalesce(i.currency,'MXN') as currency
      from invoices i
      where i.company_id = ${companyId} and i.partner_id = ${data.partnerId}
        and i.kind = ${invKind} and i.state = 'open' and i.residual > 0.009 and i.amount > 0
        -- Solo pesos, igual que el cobro (regla 5g): un crédito en pesos
        -- aplicado a una factura en dolares se acreditaria al TC pactado sin
        -- registrar el diferencial. Se construye cuando se decida la moneda
        -- del credito.
        and coalesce(i.currency,'MXN') = 'MXN'
      order by i.date, i.id
    `;
    const invoices = open.map((i) => ({ id: i.id, name: i.name, date: i.date, residual: Number(i.residual), currency: i.currency }));
    const total = credits.reduce((s, c) => s + c.available, 0);
    return {
      credits,
      invoices,
      total: Math.round(total * 100) / 100,
      proposal: proposeSplit(total, invoices).rows,
    };
  });

/**
 * TODO el saldo a favor vivo de la empresa, por socio. Es lo que la pantalla
 * de Cartera enseña arriba: si hay dinero de un cliente sin aplicar, tiene que
 * verse sin ir a buscarlo (Decisión 12).
 */
export const listCredits = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    await assertCan(sql, context.userId, "credit", "view");
    const companyId = await cid(sql, context.userId);
    // CARTERA PROPIA, el mismo patrón de `listInvoices` / `getUpcomingDue`: un
    // vendedor ve los saldos a favor de SUS clientes, no los de todos. Sin
    // esto, el letrero nuevo enseñaba nombres y montos de clientes ajenos —
    // y dejaba aplicarles crédito.
    const me = await activeMember(sql, context.userId);
    const rows = await sql<{
      partner_id: number; partner: string; kind: string; id: number; name: string; date: string;
      amount: string; applied: string; currency: string; memo: string;
    }>`
      select p.partner_id, pt.name as partner, p.kind, p.id, p.name, p.date::text,
        p.amount::text, coalesce(p.currency,'MXN') as currency, p.memo,
        coalesce((select sum(pa.amount) from payment_allocs pa where pa.payment_id = p.id), 0)::text as applied
      from payments p join partners pt on pt.id = p.partner_id
      where p.company_id = ${companyId}
        and p.amount > 0
        and p.reverses_id is null
        and not exists (select 1 from payments r where r.reverses_id = p.id)
        and (${me.own_only} = false or pt.seller_id = ${context.userId} or pt.seller_id is null)
        and p.amount - coalesce((select sum(pa.amount) from payment_allocs pa where pa.payment_id = p.id), 0) > 0.009
      order by pt.name, p.date, p.id
    `;
    return rows.map((r) => ({
      partnerId: r.partner_id,
      partner: r.partner,
      /** inbound = saldo a favor del CLIENTE; outbound = de Azagro con el proveedor. */
      lado: r.kind === "inbound" ? ("cliente" as const) : ("proveedor" as const),
      paymentId: r.id,
      name: r.name,
      date: r.date,
      available: unappliedOf(Number(r.amount), Number(r.applied)),
      currency: r.currency,
      memo: r.memo,
    }));
  });

/**
 * Aplicar saldo a favor a una factura. Una aplicación por llamada: la pantalla
 * confirma la propuesta renglón por renglón, que es lo que pidió la Decisión
 * 13 (el sistema propone, la persona confirma o cambia).
 */
export const applyCredit = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ paymentId: z.number(), invoiceId: z.number(), amount: z.number().positive() }))
  .handler(async ({ context, data }) => {
    const boot = await getSql();
    await assertCan(boot, context.userId, "credit", "edit");
    // Fuera de la transacción, como las otras tres entradas a la mora
    // (`azagro.ts`, y las dos de `ops.ts`): `issueMoraInvoice` documenta que
    // NO corre `alter table` porque siempre vive dentro de una transacción.
    await ensureInvoiceExtras(boot);
    return withTx(async (sql) => {
      const companyId = await cid(sql, context.userId);
      // Las dos puntas bloqueadas antes de mirar números: el cobro del que sale
      // el crédito y la factura a la que entra.
      const pay = await sql<{ id: number; name: string; amount: string; partner_id: number; reverses_id: number | null; kind: string; date: string; memo: string }>`
        select id, name, amount::text, partner_id, reverses_id, kind, date::text, coalesce(memo,'') as memo from payments
        where id = ${data.paymentId} and company_id = ${companyId} for update
      `;
      if (!pay[0]) throw new Error("Cobro no encontrado");
      if (pay[0].reverses_id) throw new Error("Una reversa no tiene saldo a favor que aplicar.");
      // YA REVERTIDO: el dinero salió del banco con su contra-movimiento, así
      // que ese crédito dejó de existir. Los cuatro lugares que LEEN el saldo
      // a favor ya lo excluían; el único que ESCRIBE no lo hacía — y abonar
      // con él borraría deuda con dinero devuelto.
      const revertido = await sql<{ name: string }>`
        select name from payments where reverses_id = ${data.paymentId} and company_id = ${companyId} limit 1
      `;
      if (revertido[0]) {
        throw new Error(`${pay[0].name} ya fue revertido (${revertido[0].name}): ese dinero salió del banco y su saldo a favor dejó de existir.`);
      }
      const inv = await sql<{ id: number; name: string; residual: string; state: string; partner_id: number; kind: string; currency: string; date: string }>`
        select id, name, residual::text, state, partner_id, kind, coalesce(currency,'MXN') as currency, date::text from invoices
        where id = ${data.invoiceId} and company_id = ${companyId} for update
      `;
      if (!inv[0]) throw new Error("Factura no encontrada");
      if (inv[0].state === "reversed") throw new Error(`${inv[0].name} está revertida: no recibe abonos (Decisión 31).`);
      if (inv[0].partner_id !== pay[0].partner_id) {
        throw new Error("El saldo a favor es de otro socio: no se puede aplicar a esta factura.");
      }
      // LOS TRES CANDADOS QUE TIENE EL COBRO Y A ESTA PUERTA LE FALTABAN.
      //
      // 1) EL LADO (regla 5). Un socio puede ser cliente y proveedor a la vez.
      //    Un sobrante que Azagro le PAGÓ de más (outbound) no es crédito del
      //    cliente: aplicarlo a una factura de venta bajaría la cuenta por
      //    cobrar sin que entrara un peso, y sin documento de compensación.
      const ladoOk = (pay[0].kind === "inbound" && inv[0].kind === "customer") || (pay[0].kind === "outbound" && inv[0].kind === "supplier");
      if (!ladoOk) {
        throw new Error(
          `${pay[0].name} es un saldo a favor ${pay[0].kind === "inbound" ? "del cliente" : "con el proveedor"} y ${inv[0].name} es una factura ${inv[0].kind === "customer" ? "de venta" : "de compra"}. No se cruzan: compensar lo que un socio debe contra lo que se le debe es una decisión aparte, con su propio documento.`,
        );
      }
      // 2) LA MONEDA (regla 5g). El saldo a favor vive en pesos. Acreditárselo
      //    a una factura en dólares lo convertiría al TC pactado sin registrar
      //    el diferencial contra el TC del día en que ese dinero entró.
      if (inv[0].currency !== "MXN") {
        throw new Error(
          `${inv[0].name} está en ${inv[0].currency} y el saldo a favor vive en pesos. Todavía no se puede aplicar un crédito en pesos a una factura en otra moneda: falta decidir con qué tipo de cambio y dónde se registra el diferencial. Cóbrala normal, con su tipo de cambio.`,
        );
      }
      const alloc = await sql<{ applied: string }>`
        select coalesce(sum(amount),0)::text as applied from payment_allocs where payment_id = ${data.paymentId}
      `;
      const available = unappliedOf(Number(pay[0].amount), Number(alloc[0]!.applied));
      const cabe = applyableCredit(available, Number(inv[0].residual));
      if (cabe.amount <= 0.009) throw new Error(cabe.reason);
      const amount = Math.min(Math.round(data.amount * 100) / 100, cabe.amount);
      // LA MORA SE FACTURA ANTES DE ABONAR, igual que en el cobro
      // (`applyInvoicePayment`). Saldar una factura vencida sin emitir su FI la
      // deja en `paid`, y ahí el botón «Mora» ya no aparece (`invoiceStillOwed`
      // es falso): el interés se perdería y no quedaría pantalla para cobrarlo.
      // En ventas a crédito SIEMPRE hay mora (Decisión 68); lo que se negocia
      // es la tasa, no si existe.
      //
      // `requireCharge: false` como en el cobro: si no hay días vencidos no
      // truena, simplemente no nace FI. La fecha del abono es la del cobro del
      // que sale el crédito — ahí estuvo el dinero desde el principio.
      //
      // LA FECHA: aquella en que el dinero estuvo disponible PARA ESTA FACTURA
      // — la más tarde entre cuándo llegó y cuándo nació la factura (criterio
      // técnico del 19-sep-2026, con aval del dueño). La mora cobra el tiempo
      // que el dinero de Azagro estuvo amarrado; si el cliente ya había
      // depositado, no lo estuvo, y cobrársela sería cobrar intereses sobre
      // dinero que ya estaba en el banco. Pero tampoco pudo pagar algo que no
      // existía, así que la fecha del depósito sola no sirve.
      //
      // **Salvo el crédito de una DEVOLUCIÓN** (L3c): la Decisión 93 mide con
      // la fecha del dinero porque ese dinero YA ESTABA en el banco y no
      // financió nada. Mercancía devuelta nunca fue dinero disponible para
      // OTRA factura, así que la premisa no se cumple: su fecha es el día en
      // que se aplica. Sin esto, un crédito guardado meses se llevaba consigo
      // toda la mora corrida — sobre la factura de referencia, $5,486.59 que
      // además ya no se podrían facturar, porque al quedar `paid` desaparece
      // el botón «Mora».
      // LA FECHA DE ESTA APLICACIÓN (migración 0046). Para el sobrante de un
      // cobro, vacía: el dinero estaba en el banco desde que llegó, y esa es su
      // fecha (Decisión 93). Para el crédito de una devolución, HOY: mercancía
      // en la bodega no era dinero disponible para esta factura hasta que
      // alguien lo aplicó (Decisión 97). Se escribe en la aplicación y de ahí
      // leen la fecha de pago, la mora y el pronto pago: un solo hecho.
      const esDevolucion = isReturnCredit(pay[0].memo);
      const appliedAt: string | null = esDevolucion ? todayMx() : null;
      const origen = appliedAt ?? pay[0].date;
      const fechaEfectiva = origen > inv[0].date ? origen : inv[0].date;
      let mora: { name: string | null; charge: number } = { name: null, charge: 0 };
      if (inv[0].kind === "customer") {
        mora = await issueMoraInvoice(sql, companyId, data.invoiceId, {
          asOf: fechaEfectiva,
          paidDate: fechaEfectiva,
          requireCharge: false,
          userId: context.userId,
        });
      }
      await sql`insert into payment_allocs (payment_id, invoice_id, amount, applied_at) values (${data.paymentId}, ${data.invoiceId}, ${amount}, ${appliedAt})`;
      let residual = await refreshInvoiceResidual(sql, data.invoiceId);
      // PRONTO PAGO, igual que por banco (19-sep-2026, criterio técnico con
      // aval del dueño). El mismo dinero por dos puertas no puede valer
      // distinto: hasta $5,416.67 que el cliente recibía cobrando por banco y
      // no al aplicarle su propio saldo a favor. Y el P&L ya descontaba ese
      // bono estimado en cuanto había fecha de pago, así que por esta vía
      // restaba utilidad de una bonificación que nadie había otorgado.
      //
      // Con la fecha EFECTIVA: si su dinero ya estaba ahí cuando nació la
      // factura, no se financió ni un día y se le devuelve el financiamiento
      // completo que el precio le cobró. Es la misma regla, no una excepción.
      // PRONTO PAGO — pero NO con el crédito de una devolución (L3c,
      // 19-sep-2026). La bonificación devuelve el financiamiento que el precio
      // cobró y que no se usó **por haber pagado antes**. Devolver mercancía no
      // es pagar antes: es deshacer una venta. Sin este candado, aplicar el
      // crédito de una devolución a otra factura le habría ganado al cliente
      // una bonificación por pago anticipado que nunca hizo — y sobre una
      // factura de $111,876.11 a 150 días son hasta $5,081.04.
      //
      // `payDate` solo fecha el documento de la bonificación: la fecha con la
      // que se MIDE la deriva `earlyPayDiscount` de los abonos vivos de la
      // factura, así que las dos puertas de DINERO miden igual por construcción.
      const bono = esDevolucion
        ? { discount: 0, detail: "", residual }
        : await earlyPayDiscount(sql, {
            companyId, userId: context.userId, invoiceId: data.invoiceId, payDate: fechaEfectiva, residual,
          });
      residual = bono.residual;
      const queda = unappliedOf(Number(pay[0].amount), Number(alloc[0]!.applied) + amount);
      await writeAudit(sql, {
        companyId, userId: context.userId,
        action: "aplicar-saldo-a-favor", entity: "invoice", entityId: data.invoiceId, name: inv[0].name,
        detail: `${amount.toFixed(2)} de ${pay[0].name} · saldo de la factura ${Number(inv[0].residual).toFixed(2)} → ${residual.toFixed(2)} · saldo a favor que queda ${queda.toFixed(2)}${mora.name ? ` · mora ${mora.name} ${mora.charge.toFixed(2)}` : ""}${bono.discount > 0.009 ? ` · pronto pago ${bono.discount.toFixed(2)}` : ""}`,
      });
      return { ok: true as const, applied: amount, residual, remaining: queda, invoice: inv[0].name, payment: pay[0].name, mora: mora.name, moraCharge: mora.charge, discount: bono.discount, discountDetail: bono.detail };
    });
  });

/**
 * Quitar una aplicación: el dinero regresa al saldo a favor.
 *
 * **No es una reversa.** No se mueve un peso del banco, porque el dinero sí
 * entró; lo que estaba mal era a qué factura se le acreditó. Por eso no exige
 * admin/gerencia como revertir — pero sí queda en bitácora.
 *
 * **No se borra nada** (Decisión 16). La aplicación se contraría con una
 * aplicación NEGATIVA sobre el mismo cobro, igual que `reversal.ts` contraría
 * un abono: la suma vuelve a cero, la factura vuelve a deber, el crédito vuelve
 * a estar disponible, y las dos filas se quedan para siempre.
 *
 * **Solo sobre un SALDO A FAVOR**, no sobre un cobro cualquiera. Un cobro
 * normal se deshace revirtiéndolo (`reversal.ts`, admin/gerencia): permitir
 * desaplicarlo aquí dejaría el dinero flotando y su movimiento de banco
 * apuntando a una factura que ya no abona — y, peor, permitiría deshacer con
 * `credit:edit` la mitad de cartera de una reversa que alguien hizo a
 * propósito, que es de admin/gerencia.
 *
 * La contra-aplicación lleva fecha de HOY (`applied_at`, migración 0046):
 * quitar es un hecho de hoy, así que el saldo de esa factura en un mes ya
 * cerrado no se mueve — el mismo principio que la NC de devolución y el
 * contra-PAG (Decisión 16).
 */
export const unapplyCredit = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ paymentId: z.number(), invoiceId: z.number() }))
  .handler(async ({ context, data }) => {
    const boot = await getSql();
    await assertCan(boot, context.userId, "credit", "edit");
    return withTx(async (sql) => {
      const companyId = await cid(sql, context.userId);
      const pay = await sql<{ id: number; name: string; memo: string; amount: string; reverses_id: number | null }>`
        select id, name, memo, amount::text, reverses_id from payments
        where id = ${data.paymentId} and company_id = ${companyId} for update
      `;
      if (!pay[0]) throw new Error("Cobro no encontrado");
      // Solo un saldo a favor. Todo lo demás —un cobro normal, el abono de una
      // devolución, la bonificación de pronto pago, una reversa— se deshace
      // revirtiendo su documento, que es otra acción y otro permiso.
      if (pay[0].reverses_id || Number(pay[0].amount) <= 0) {
        throw new Error(`${pay[0].name} es una reversa: no se desaplica, ya es el contrario de otro movimiento.`);
      }
      // YA REVERTIDO — el mismo candado que `applyCredit`, que a esta puerta
      // le faltaba. Su contra-PAG ya dejó un abono negativo en la factura;
      // escribir aquí un segundo negativo la dejaría debiendo MÁS de su
      // importe: sobre una FV de $1,000 con un anticipo de $300 aplicado y
      // luego revertido, +300 −300 −300 = −300 y `refreshInvoiceResidual`
      // escribiría $1,300 de saldo. No hay tope superior que lo ataje.
      const revertido = await sql<{ name: string }>`
        select name from payments where reverses_id = ${data.paymentId} and company_id = ${companyId} limit 1
      `;
      if (revertido[0]) {
        throw new Error(`${pay[0].name} ya fue revertido (${revertido[0].name}): su reversa ya deshizo la aplicación, no hay nada que quitar.`);
      }
      // El memo lo teclea la persona: quien escriba «Saldo a favor de Juan» en
      // un cobro normal pasaría este filtro. Por eso además se exige la marca
      // ESTRUCTURAL de un saldo a favor: su movimiento de banco no cuelga de
      // ninguna factura (`invoice_id is null`), mientras el de un cobro normal
      // apunta a la factura que abonó. Sin esto, desaplicar sería media
      // reversa con permiso de cartera, y revertir es de admin/gerencia.
      const ligado = await sql<{ n: number }>`
        select count(*)::int as n from bank_moves
        where payment_id = ${data.paymentId} and company_id = ${companyId} and invoice_id is not null
      `;
      if (Number(ligado[0]?.n ?? 0) > 0 || !pay[0].memo.startsWith("Saldo a favor")) {
        throw new Error(
          `${pay[0].name} no es un saldo a favor, es ${pay[0].memo.startsWith("Devolución ") ? "el abono de una devolución" : pay[0].memo.startsWith("Pronto pago ") ? "la bonificación de pronto pago de un cobro" : "un cobro registrado contra esa factura"}. Para deshacerlo se revierte el documento del que cuelga (Cartera → revertir), que es una acción de administración porque mueve dinero.`,
        );
      }
      const inv = await sql<{ id: number; name: string; residual: string; state: string }>`
        select id, name, residual::text, state from invoices where id = ${data.invoiceId} and company_id = ${companyId} for update
      `;
      if (!inv[0]) throw new Error("Factura no encontrada");
      if (inv[0].state === "reversed") {
        throw new Error(`${inv[0].name} está revertida: su saldo ya no se recalcula (Decisión 31).`);
      }
      const rows = await sql<{ id: number; amount: string }>`
        select id, amount::text from payment_allocs
        where payment_id = ${data.paymentId} and invoice_id = ${data.invoiceId} order by id
      `;
      if (!rows.length) throw new Error(`${pay[0].name} no está aplicado a ${inv[0].name}.`);
      // La suma, no la primera fila: puede haber aplicaciones y contrarias.
      const quitado = Math.round(rows.reduce((s, r) => s + Number(r.amount), 0) * 100) / 100;
      if (quitado <= 0.009) throw new Error(`${pay[0].name} ya no le abona nada a ${inv[0].name}.`);
      // Contrario, no borrado (Decisión 16): la suma vuelve a cero y las dos
      // filas se quedan.
      // Con la fecha de HOY (migración 0046): quitar es un hecho de hoy, y así
      // el saldo de esa factura en un corte ya cerrado no se mueve — el mismo
      // principio que la NC de devolución y el contra-PAG (Decisión 16).
      await sql`insert into payment_allocs (payment_id, invoice_id, amount, applied_at) values (${data.paymentId}, ${data.invoiceId}, ${-quitado}, ${todayMx()})`;
      const residual = await refreshInvoiceResidual(sql, data.invoiceId);
      await writeAudit(sql, {
        companyId, userId: context.userId,
        action: "quitar-saldo-a-favor", entity: "invoice", entityId: data.invoiceId, name: inv[0].name,
        detail: `${quitado.toFixed(2)} de ${pay[0].name} regresa al saldo a favor (aplicación contraria, nada borrado) · saldo de la factura ${Number(inv[0].residual).toFixed(2)} → ${residual.toFixed(2)}`,
      });
      return { ok: true as const, removed: quitado, residual, invoice: inv[0].name, payment: pay[0].name };
    });
  });

/**
 * APAGAR (o volver a encender) EL AJUSTE DE MORA DE UNA FACTURA — la segunda
 * mitad de la Decisión 10 (L3b, 20-sep-2026).
 *
 * Por omisión, la mora de una factura se calcula sobre el cargo MENOS lo
 * devuelto: sobre la mercancía que regresó nunca hubo venta que financiar. Pero
 * el dueño lo dejó dicho: «es el comportamiento por omisión, no una regla fija
 * — quien tenga permiso puede decidir lo contrario caso por caso, con bitácora
 * (depende de por qué devolvió: error de Azagro no es lo mismo que sobrante del
 * cliente)».
 *
 * Es admin o gerencia, como revertir: mueve dinero que ya se le dijo al cliente
 * y no se deshace con un botón cualquiera. El motivo es obligatorio — sin la
 * razón, dentro de un mes nadie va a saber por qué esta factura cobra interés
 * sobre mercancía que el cliente ya no tiene.
 *
 * No escribe ningún número: solo el interruptor. Lo que cambie de aquí en
 * adelante lo calculan los seis lectores con `moraBase`, y la FI ya emitida
 * se queda como está (Decisión 21) — lo que se cobró de más se finiquita con su
 * propio documento, que es otra pieza.
 */
export const setMoraAjusta = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ invoiceId: z.number(), ajusta: z.boolean(), reason: z.string().min(3, "Escribe el motivo: dentro de un mes nadie va a recordar por qué.") }))
  .handler(async ({ context, data }) => {
    const boot = await getSql();
    await assertCan(boot, context.userId, "credit", "edit");
    return withTx(async (sql) => {
      const companyId = await cid(sql, context.userId);
      await assertAdminOrGerencia(sql, context.userId);
      const inv = await sql<{ id: number; name: string; kind: string; inv_class: string; state: string; amount: string; mora_ajusta: boolean }>`
        select id, name, kind, coalesce(inv_class,'product') as inv_class, state, amount::text,
          coalesce(mora_ajusta, true) as mora_ajusta
        from invoices where id = ${data.invoiceId} and company_id = ${companyId} for update
      `;
      if (!inv[0]) throw new Error("Factura no encontrada");
      if (inv[0].kind !== "customer" || inv[0].inv_class !== "product" || Number(inv[0].amount) <= 0) {
        throw new Error(`${inv[0].name} no es una factura de venta: el ajuste de mora al devolver solo aplica a lo que el cliente debe por producto.`);
      }
      if (inv[0].state === "reversed") throw new Error(`${inv[0].name} está revertida (Decisión 31): ya no se le calcula mora.`);
      if (inv[0].mora_ajusta === data.ajusta) {
        throw new Error(`${inv[0].name} ya está así: la mora ${data.ajusta ? "SÍ" : "NO"} se ajusta por lo devuelto.`);
      }
      const devuelto = (await returnedOfInvoices(sql, companyId, [inv[0].id])).get(inv[0].id) ?? 0;
      await sql`update invoices set mora_ajusta = ${data.ajusta} where id = ${inv[0].id} and company_id = ${companyId}`;
      await writeAudit(sql, {
        companyId, userId: context.userId,
        action: data.ajusta ? "mora-ajusta-si" : "mora-ajusta-no",
        entity: "invoice", entityId: inv[0].id, name: inv[0].name,
        detail: `${data.ajusta ? "La mora vuelve a ajustarse" : "La mora deja de ajustarse"} por lo devuelto · cargo ${Number(inv[0].amount).toFixed(2)} · devuelto ${devuelto.toFixed(2)} · base ${moraBase(Number(inv[0].amount), devuelto, data.ajusta).toFixed(2)} · ${data.reason}`,
      });
      return {
        ok: true as const,
        invoice: inv[0].name,
        ajusta: data.ajusta,
        base: moraBase(Number(inv[0].amount), devuelto, data.ajusta),
        devuelto,
      };
    });
  });
