import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { assertCan, canSeeMargins, activeMember } from "@/lib/erp/acl";
import { fxToday, isUsdFx, usdCashAverage } from "@/lib/erp/fx";
import { bucketize, classifyDeal, coverageByBucket, netPosition, revaluation, type DealFx, type FxCash, type FxDoc } from "@/lib/erp/fx-position";
import { todayMx } from "@/lib/utils";

type Sql = Awaited<ReturnType<typeof getSql>>;

async function cid(sql: Sql, userId: string) {
  const rows = await sql<{ company_id: number }>`select company_id from members where user_id = ${userId} and status = 'active' limit 1`;
  if (!rows[0]) throw new Error("Sin empresa");
  return rows[0].company_id;
}

/**
 * BLOQUE A.2 — la consulta que alimenta la posición cambiaria (Decisiones 83-86).
 * Todo se lee en vivo de los documentos; no hay ninguna columna "exposición" y
 * no hizo falta ninguna migración. La aritmética vive en `fx-position.ts`.
 */
export const getFxPosition = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    // Es tesorería de la empresa: la ve quien ve bancos. La parte de resultado
    // (sensibilidad y revaluación) exige además ver márgenes, como el P&L.
    await assertCan(sql, context.userId, "banks", "view");
    const me = await activeMember(sql, context.userId);
    const verResultado = canSeeMargins(me.role);
    const asOf = todayMx();

    // ---------------------------------------------------------------------
    // 1. Facturas vivas en dólares (FV del cliente y FP del proveedor).
    //
    // `inv_class = 'product'` deja fuera la mora (FI) y el ajuste por TC
    // (ATC): los dos NACEN en pesos aunque vengan de una factura en dólares,
    // así que no son exposición al dólar (Decisión 83) — se enseñan aparte.
    // Una NC abierta entra con su saldo negativo: es saldo a favor y baja la
    // exposición de ese lado.
    // ---------------------------------------------------------------------
    const facturas = await sql<{
      name: string;
      kind: string;
      partner: string;
      residual: string;
      fx_agreed: string;
      due_date: string;
      deal: string | null;
    }>`
      select i.name, i.kind, p.name as partner, i.residual::text, coalesce(i.fx_agreed,0)::text as fx_agreed,
        i.due_date::text,
        case when i.kind = 'customer'
          then (select so.name from sales_orders so where so.id = i.order_id)
          else (select so2.name from purchase_orders po
                join sales_orders so2 on so2.id = po.so_id
                where po.company_id = i.company_id and po.name = i.origin limit 1)
        end as deal
      from invoices i
      join partners p on p.id = i.partner_id
      where i.company_id = ${companyId}
        and i.kind in ('customer','supplier')
        and i.state = 'open'
        and coalesce(i.inv_class,'product') = 'product'
        and coalesce(i.currency,'MXN') = 'USD'
        and abs(i.residual) > 0.009
      order by i.due_date, i.id
    `;

    const docs: FxDoc[] = [];
    for (const f of facturas) {
      const pactado = isUsdFx(f.fx_agreed) ? Number(f.fx_agreed) : null;
      // Sin TC pactado no se puede pasar el saldo (pesos) a dólares: se cuenta
      // el documento pero no se valúa, y la pantalla lo dice (Decisión 85).
      const usd = pactado ? Math.round((Number(f.residual) / pactado) * 100) / 100 : Number(f.residual);
      docs.push({
        kind: f.kind === "customer" ? "FV" : "FP",
        name: f.name,
        partner: f.partner,
        side: f.kind === "customer" ? "cobrar" : "pagar",
        committed: false,
        usd,
        fxAgreed: pactado,
        due: f.due_date,
        deal: f.deal,
      });
    }

    // ---------------------------------------------------------------------
    // 2. Lo comprometido de VENTA: pedidos en dólares confirmados o entregados
    //    a los que todavía les falta factura. `state in ('confirmed','done')`
    //    porque en bodega propia entregar NO factura (Decisión 47) y el pedido
    //    pasa a `done` con la factura pendiente. El de CONTADO también entra:
    //    la posición mide moneda, no línea de crédito (Decisión 83).
    //
    //    «Facturado» es la MISMA regla que `creditExposure` (Decisión 51): solo
    //    FV vivas — `name like 'FV-%' and reverses_id is null` —, porque la NC
    //    espejo de una entrega revertida y la NC de una devolución también
    //    cuelgan del pedido y entrarían como facturación NEGATIVA, doblando lo
    //    comprometido (regla 5d: ningún lector cuenta una revertida ni su NC
    //    contraria). Y se resta lo CERRADO CORTO (Decisión 62): lo que ya nunca
    //    va a salir no se va a facturar, así que no expone al dólar.
    //    Sin fecha de pago convenida no se le inventa una (Decisión 83): un
    //    pedido de contado sin facturar cae en la cubeta «Sin fecha», no en
    //    «Vencido» por la fecha en que se capturó.
    // ---------------------------------------------------------------------
    const pedidos = await sql<{ name: string; partner: string; total: string; fx_rate: string; facturado: string; corto: string; due: string | null }>`
      select so.name, p.name as partner, so.total::text, coalesce(so.fx_rate,0)::text as fx_rate,
        coalesce((
          select sum(i.amount) from invoices i
          where i.order_id = so.id and i.kind = 'customer' and i.name like 'FV-%'
            and i.reverses_id is null and i.state <> 'reversed'
            and coalesce(i.inv_class,'product') = 'product'
        ), 0)::text as facturado,
        coalesce((
          select sum(coalesce(sl.qty_closed_short, 0) * sl.unit_price) from sales_lines sl where sl.so_id = so.id
        ), 0)::text as corto,
        coalesce(so.invoice_due, so.credit_due)::text as due
      from sales_orders so
      join partners p on p.id = so.partner_id
      where so.company_id = ${companyId}
        and so.state in ('confirmed','done')
        and coalesce(so.currency,'MXN') = 'USD'
      order by so.id
    `;
    for (const s of pedidos) {
      const pactado = isUsdFx(s.fx_rate) ? Number(s.fx_rate) : null;
      const pendienteMxn = Number(s.total) - Number(s.facturado) - Number(s.corto);
      if (pendienteMxn <= 0.009) continue;
      docs.push({
        kind: "PV",
        name: s.name,
        partner: s.partner,
        side: "cobrar",
        committed: true,
        usd: pactado ? Math.round((pendienteMxn / pactado) * 100) / 100 : pendienteMxn,
        fxAgreed: pactado,
        due: s.due,
        deal: s.name,
      });
    }

    // ---------------------------------------------------------------------
    // 3. Lo comprometido de COMPRA: órdenes en dólares confirmadas a las que
    //    todavía no les nace la deuda. Se cuenta `po.total − Σ FP nacidas`,
    //    NUNCA por cantidad recibida: una orden directa/brokeraje jamás se
    //    recibe (su `qty_received` se queda en 0 para siempre) y contarla por
    //    cantidad la contaría dos veces — como orden y como factura (D83).
    //    La FP se amarra a su OC por `origin` (texto), como todo el sistema.
    //
    //    OJO con la unidad: `purchase_orders.total` vive en la MONEDA DE LA
    //    ORDEN (dólares en una OC en USD), al revés que `sales_orders.total`,
    //    que vive en pesos desde L4a. Por eso lo comprometido de compra se
    //    compara contra `amount_fx` de las FP (sus dólares), sin dividir nada.
    //
    //    Sin fecha: una orden de compra no tiene ninguna fecha de vencimiento
    //    en la base, solo el día en que se capturó. No se le inventa una.
    // ---------------------------------------------------------------------
    const ordenes = await sql<{ name: string; partner: string; total: string; fx_rate: string; facturado: string; deal: string | null }>`
      select po.name, p.name as partner, po.total::text, coalesce(po.fx_rate,0)::text as fx_rate,
        coalesce((
          select sum(i.amount_fx) from invoices i
          where i.company_id = ${companyId} and i.kind = 'supplier' and i.origin = po.name and i.state <> 'reversed'
        ), 0)::text as facturado,
        (select so.name from sales_orders so where so.id = po.so_id) as deal
      from purchase_orders po
      join partners p on p.id = po.partner_id
      where po.company_id = ${companyId}
        and po.state = 'confirmed'
        and coalesce(po.currency,'MXN') = 'USD'
      order by po.id
    `;
    for (const o of ordenes) {
      const pactado = isUsdFx(o.fx_rate) ? Number(o.fx_rate) : null;
      // Los dos ya están en dólares: el total de la orden y los `amount_fx` de
      // sus facturas. No se divide entre el TC (ése fue el error que atrapó la
      // verificación en navegador: US$540.54 en vez de US$10,000).
      const pendienteUsd = Math.round((Number(o.total) - Number(o.facturado)) * 100) / 100;
      if (pendienteUsd <= 0.009) continue;
      docs.push({
        kind: "OC",
        name: o.name,
        partner: o.partner,
        side: "pagar",
        committed: true,
        usd: pendienteUsd,
        fxAgreed: pactado,
        due: null,
        deal: o.deal,
      });
    }

    // ---------------------------------------------------------------------
    // 4. Dólares en caja, con su costo a promedio móvil por cuenta
    //    (`usdCashAverage`, la misma regla pura y los mismos datos que Bancos:
    //    el mismo promedio tiene que salir en las dos pantallas).
    // ---------------------------------------------------------------------
    const cuentas = await sql<{ id: number; name: string; opening: string }>`
      select id, name, coalesce(opening,0)::text as opening from banks
      where company_id = ${companyId} and coalesce(currency,'MXN') = 'USD' order by id
    `;
    // `order by id` y el `amount` crudo, IGUAL que Bancos (`listBanks`): en una
    // cuenta en dólares el movimiento lleva dólares en `amount`. Si aquí se
    // ordenara por fecha, un cobro retrofechado daría un promedio distinto al
    // de Bancos para la misma cuenta, y las dos pantallas dirían números que
    // no se pueden conciliar.
    const movs = await sql<{ bank_id: number; amount: string; fx_rate: string | null; reverses_id: number | null }>`
      select bank_id, amount::text, fx_rate::text, reverses_id from bank_moves
      where company_id = ${companyId} order by id
    `;
    let cajaUsd = 0;
    let cajaTracked = 0;
    let cajaSinTc = 0;
    let cajaCostoMxn = 0;
    const cuentasUsd: Array<{ name: string; usd: number; avgFx: number | null; mxn: number | null; sinTc: number }> = [];
    for (const c of cuentas) {
      const ms = movs
        .filter((m) => m.bank_id === c.id)
        .map((m) => ({ amount: m.amount, fxRate: m.fx_rate, reversal: m.reverses_id != null }));
      const avg = usdCashAverage({ opening: Number(c.opening), moves: ms });
      cuentasUsd.push({ name: c.name, usd: avg.usd, avgFx: avg.avgFx, mxn: avg.mxn, sinTc: avg.sinTc });
      cajaUsd += avg.usd;
      cajaTracked += avg.tracked;
      cajaSinTc += avg.sinTc;
      cajaCostoMxn += avg.mxn ?? 0;
    }
    const cash: FxCash = {
      usd: Math.round(cajaUsd * 100) / 100,
      tracked: Math.round(cajaTracked * 100) / 100,
      sinTc: Math.round(cajaSinTc * 100) / 100,
      avgFx: cajaTracked > 0.0000001 ? Math.round((cajaCostoMxn / cajaTracked) * 10000) / 10000 : null,
    };

    // ---------------------------------------------------------------------
    // 5. Los deals, para derivar la cobertura de la dinámica 2 (Decisión 84):
    //    se compara la moneda y el TC de la compra contra los de la venta.
    //    Una OC de inventario no tiene `so_id` y por eso no pertenece a ningún
    //    deal: su exposición es de la empresa, sin pata de venta que la cubra.
    // ---------------------------------------------------------------------
    const deals = await sql<{
      so_name: string;
      partner: string;
      so_currency: string;
      so_fx: string;
      po_currency: string | null;
      po_fx: string | null;
    }>`
      select so.name as so_name, p.name as partner,
        coalesce(so.currency,'MXN') as so_currency, coalesce(so.fx_rate,0)::text as so_fx,
        (select coalesce(po.currency,'MXN') from purchase_orders po
          where po.so_id = so.id and po.state <> 'cancelled' order by po.id limit 1) as po_currency,
        (select coalesce(po.fx_rate,0)::text from purchase_orders po
          where po.so_id = so.id and po.state <> 'cancelled' order by po.id limit 1) as po_fx
      from sales_orders so
      join partners p on p.id = so.partner_id
      where so.company_id = ${companyId} and so.state in ('confirmed','done')
      order by so.id
    `;
    // USD abierto por deal, de los DOS lados: facturas vivas más lo
    // comprometido. Un documento sin pedido (OC de inventario, factura suelta)
    // no entra: su exposición es de la empresa, no de un deal.
    const porPedido = new Map<string, { venta: number; compra: number }>();
    for (const d of docs) {
      if (!d.deal || d.fxAgreed == null) continue;
      const acum = porPedido.get(d.deal) ?? { venta: 0, compra: 0 };
      if (d.side === "cobrar") acum.venta += d.usd;
      else acum.compra += d.usd;
      porPedido.set(d.deal, acum);
    }
    const dealsClasificados = deals
      .map((d) => {
        const acum = porPedido.get(d.so_name) ?? { venta: 0, compra: 0 };
        const fx: DealFx = {
          soName: d.so_name,
          partner: d.partner,
          saleCurrency: d.so_currency,
          saleFx: isUsdFx(d.so_fx) ? Number(d.so_fx) : null,
          buyCurrency: d.po_currency ?? "MXN",
          buyFx: isUsdFx(d.po_fx) ? Number(d.po_fx) : null,
          saleUsd: acum.venta,
          buyUsd: acum.compra,
          hasBuy: d.po_currency != null,
        };
        return { ...fx, ...classifyDeal(fx) };
      })
      .filter((d) => d.estado !== "sin-exposicion");

    // ---------------------------------------------------------------------
    // 6. El TC de hoy y todo lo que se deriva de él. Sin renglón, la pantalla
    //    sigue diciendo los dólares y los TC pactados; lo que no dice es el
    //    equivalente en pesos (regla 9: nunca un TC inventado).
    // ---------------------------------------------------------------------
    const hoy = await fxToday(sql, companyId, asOf);
    const rows = bucketize(docs, asOf);
    const cobertura = coverageByBucket(rows, cash.usd);
    const posicion = netPosition(rows, cash);
    // La regla del TC vive en `isUsdFx` y se aplica AQUÍ, en la frontera: el
    // motor puro recibe un número usable o null, nunca decide qué es un TC.
    const tcHoy = isUsdFx(hoy?.rate) ? Number(hoy!.rate) : null;
    const reval = verResultado ? revaluation(docs, cash, tcHoy) : null;

    const sinTc = docs.filter((d) => d.fxAgreed == null);

    return {
      asOf,
      fxToday: hoy,
      verResultado,
      posicion,
      cubetas: cobertura,
      documentos: docs
        .slice()
        .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.name.localeCompare(b.name)),
      deals: dealsClasificados,
      caja: { ...cash, cuentas: cuentasUsd },
      revaluacion: reval,
      // Decisión 85: los documentos en dólares SIN TC pactado se enseñan
      // aparte, nunca dentro de un total en pesos. Corregirlos no es capturar
      // un campo: hay que revertir la recepción y volver a recibir.
      sinTcPactado: { n: sinTc.length, docs: sinTc },
    };
  });
