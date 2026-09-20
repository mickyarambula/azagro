/**
 * CUÁNTO COSTÓ EL DÓLAR EN UN PERIODO (Decisión 91).
 *
 * La pregunta del dueño, del 19-sep-2026: «si absorbo yo el movimiento del
 * dólar, quiero saber cuánto me costó al mes, para que sea una decisión y no
 * un goteo» (Decisión 90).
 *
 * **Tiene DOS mitades, y por eso se enseñan por separado.** El dólar le cuesta
 * a Azagro de dos maneras distintas, en dos momentos distintos:
 *
 *   1. **Sobre la DEUDA.** Se le debe al proveedor en dólares y se le paga con
 *      pesos: el banco convierte ese día y la diferencia contra el tipo de
 *      cambio pactado es inmediata. Igual del lado cliente, cuando paga en una
 *      moneda distinta de la pactada.
 *   2. **Sobre la CAJA.** Se pagan dólares que ya se tenían. Ese día no hay
 *      conversión, pero esos dólares habían costado algo: la diferencia entre
 *      lo que costaron y lo que valieron al usarse es igual de real. Es el
 *      kardex de los dólares (`usdCashRealized`).
 *
 * Las dos mitades son **disjuntas por construcción**: la primera solo ocurre
 * cuando la cuenta es de pesos y la factura de dólares; la segunda, solo
 * cuando salen dólares de una cuenta en dólares. Ningún peso se cuenta dos
 * veces. Y sin la segunda, cubrirse —comprar los dólares por adelantado, la
 * salida (1) de la Decisión 90— haría que el reporte dijera cero justo cuando
 * la operación se hizo bien.
 *
 * **Nada de esto se guarda: se deriva.** El diferencial de un pago es la misma
 * resta que ya hizo `fxPaymentSplit`, sobre los dos números que ese pago dejó
 * escritos (`bank_moves.amount` y `payments.amount`); y el de la caja sale del
 * mismo recorrido que el promedio. Guardarlos crearía una segunda verdad que
 * un día puede no coincidir con sus propios insumos.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { activeMember, assertCan, canSeeMargins } from "@/lib/erp/acl";
import { splitFxCost, usdCashRealized } from "@/lib/erp/fx";

type Sql = Awaited<ReturnType<typeof getSql>>;

async function cid(sql: Sql, userId: string) {
  const rows = await sql<{ company_id: number }>`select company_id from members where user_id = ${userId} and status = 'active' limit 1`;
  if (!rows[0]) throw new Error("Sin empresa");
  return rows[0].company_id;
}

/**
 * El cálculo, aparte de la puerta, para que el P&L del periodo lea EXACTAMENTE
 * el mismo número que la pantalla enseña — nunca dos cuentas del mismo hecho.
 */
export async function fxCostOfPeriod(sql: Sql, companyId: number, from: string, to: string) {

    // -----------------------------------------------------------------------
    // MITAD 1 — sobre la DEUDA: factura en dólares, cuenta en PESOS.
    //
    // `fxPaymentSplit` calcula `diff = bankMxn − appliedMxn` con los dos ya
    // redondeados (credit.ts), y el código guarda `bankMxn` en
    // `bank_moves.amount` y `appliedMxn` en `payments.amount`. Restarlos aquí
    // NO es una segunda fórmula: es la misma resta sobre los mismos números.
    //
    // Sin filtro de `reverses_id` en el pago, a propósito: el contra-PAG nace
    // con importe negativo y su contra-movimiento con el opuesto, así que el
    // par se cancela solo — en el mes de la reversa, que es cuando ocurrió.
    //
    // El filtro es la moneda de la FACTURA y la de la CUENTA (como la reversa),
    // nunca `bank_moves.amount_fx`/`fx_rate`, que están en null para todo lo
    // anterior a la migración 0044.
    // -----------------------------------------------------------------------
    const pagos = await sql<{
      pago: string;
      fecha: string;
      factura: string;
      socio: string;
      kind: string;
      banco: string;
      aplicado: string;
      fx_agreed: string | null;
      fx_pago: string | null;
    }>`
      select distinct on (p.id) p.name as pago, p.date::text as fecha, pt.name as socio, i.kind,
        bm.amount::text as banco,
        -- POR PAGO, no por aplicación (L5, Decisión 13): un cobro puede
        -- repartirse entre varias facturas. Con pa.amount suelto, el mismo
        -- bm.amount se repetía en cada renglón y el diferencial se contaba
        -- tantas veces como facturas tuviera el pago.
        --
        -- Se suman TODAS las aplicaciones del pago, no solo las de facturas en
        -- dólares: payment_allocs.amount y bank_moves.amount están los dos
        -- en pesos, así que la resta es correcta venga de donde venga; una
        -- aplicación a una factura en pesos aporta cero diferencial y no
        -- estorba. Lo que sí se exige es que el pago toque al menos una
        -- factura en dólares, que es de lo que trata esta mitad.
        (select coalesce(sum(pa2.amount),0) from payment_allocs pa2 where pa2.payment_id = p.id)::text as aplicado,
        i.name as factura, i.fx_agreed::text as fx_agreed, p.fx_rate::text as fx_pago
      from payments p
      join payment_allocs pa on pa.payment_id = p.id
      join invoices i on i.id = pa.invoice_id
      join partners pt on pt.id = p.partner_id
      join bank_moves bm on bm.payment_id = p.id
      join banks b on b.id = bm.bank_id
      where p.company_id = ${companyId}
        and p.date between ${from} and ${to}
        and coalesce(i.currency,'MXN') = 'USD'
        and coalesce(b.currency,'MXN') = 'MXN'
        -- SOLO PAGOS COMPLETAMENTE APLICADOS (L5, 19-sep-2026). La resta
        -- banco - aplicado mide movimiento del dolar SOLO cuando el pago se
        -- aplico entero; si le queda saldo a favor, esa resta mide lo que
        -- falta por aplicar y mete un diferencial fantasma en el Resultado del
        -- mes. Con un sobrante de 300 aplicado 200 daria 100.
        --
        -- Es una prueba ESTRUCTURAL, no de texto: el memo lo teclea la
        -- persona, asi que un cobro real cuyo memo empezara con las palabras
        -- equivocadas se habria salido del diferencial del periodo. Y ademas
        -- atrapa al contra-PAG de un cobro aplicado en parte (importe -300,
        -- aplicaciones -200), que por memo no se distinguia.
        and abs(p.amount - coalesce((select sum(pa4.amount) from payment_allocs pa4 where pa4.payment_id = p.id), 0)) <= 0.009
      -- distinct on (p.id): un pago con varias aplicaciones a facturas en
      -- dolares (o dos a la MISMA) daria un renglon por cada una, todos con el
      -- mismo total, y el diferencial se contaria de mas. Se queda uno.
      order by p.id, i.id
    `;
    const deudaFilas = [...pagos].sort((a, b) => (a.fecha === b.fecha ? 0 : a.fecha < b.fecha ? -1 : 1))
      .map((r) => {
        const banco = Number(r.banco);
        const aplicado = Number(r.aplicado);
        // Signo por lado, el mismo que `fxResultDeltaFor`: al proveedor el
        // movimiento del banco es negativo, así que la resta se vuelve suma.
        const result = Math.round((r.kind === "customer" ? banco - aplicado : banco + aplicado) * 100) / 100;
        return {
          pago: r.pago,
          fecha: r.fecha,
          factura: r.factura,
          socio: r.socio,
          lado: r.kind === "customer" ? ("cliente" as const) : ("proveedor" as const),
          fxPactado: r.fx_agreed == null ? null : Number(r.fx_agreed),
          fxPagado: r.fx_pago == null ? null : Number(r.fx_pago),
          result,
        };
      })
      .filter((r) => Math.abs(r.result) > 0.009);
    const deudaTotal = Math.round(deudaFilas.reduce((s, r) => s + r.result, 0) * 100) / 100;
    // Aparte el del lado PROVEEDOR: es el único que se puede comparar contra
    // «Pagado a proveedores», que solo suma pagos salientes. Mezclarle el del
    // cliente decía que del banco salió un dinero que nunca salió.
    const deudaProveedor = Math.round(deudaFilas.filter((r) => r.lado === "proveedor").reduce((s, r) => s + r.result, 0) * 100) / 100;

    // -----------------------------------------------------------------------
    // MITAD 2 — sobre la CAJA: dólares que salieron de una cuenta en dólares.
    //
    // Hay que recorrer SIEMPRE desde el principio de cada cuenta: lo que costó
    // una salida depende de todo lo que entró antes. Del recorrido completo se
    // toman después solo las salidas del periodo.
    //
    // El orden es `by id`, el mismo de Bancos y de la posición cambiaria: así
    // el costo de una salida lo fijan los movimientos capturados antes que
    // ella, y capturar algo retrofechado no mueve un resultado ya medido.
    // -----------------------------------------------------------------------
    const cuentas = await sql<{ id: number; name: string; opening: string }>`
      select id, name, coalesce(opening,0)::text as opening from banks
      where company_id = ${companyId} and coalesce(currency,'MXN') = 'USD' order by id
    `;
    const cajaFilas: Array<{ cuenta: string; ref: string; fecha: string; usd: number; fxCost: number; fxOut: number; result: number }> = [];
    const cajaNoMedido: Array<{ cuenta: string; ref: string; fecha: string; usd: number; motivo: string }> = [];
    for (const c of cuentas) {
      const ms = await sql<{ id: number; amount: string; fx_rate: string | null; reverses_id: number | null; memo: string; date: string; kind: string }>`
        select id, amount::text, fx_rate::text, reverses_id, memo, date::text, kind from bank_moves
        where bank_id = ${c.id} and company_id = ${companyId} order by id
      `;
      const r = usdCashRealized({
        opening: Number(c.opening),
        moves: ms.map((m) => ({
          amount: m.amount,
          fxRate: m.fx_rate,
          reversal: m.reverses_id != null,
          reversesId: m.reverses_id,
          id: m.id,
          kind: m.kind,
          ref: m.memo,
          date: m.date,
        })),
      });
      for (const e of r.exits) {
        if (!e.date || e.date < from || e.date > to) continue;
        if (Math.abs(e.result) <= 0.009) continue;
        cajaFilas.push({ cuenta: c.name, ref: e.ref ?? "", fecha: e.date, usd: e.usd, fxCost: e.fxCost, fxOut: e.fxOut, result: e.result });
      }
      // Lo que no se pudo medir se recorta al MISMO periodo: decir «salieron
      // 20,000 sin costo» en el reporte de septiembre cuando salieron en marzo
      // sería otro número inventado.
      for (const n of r.noMedidos) {
        if (!n.date || n.date < from || n.date > to) continue;
        cajaNoMedido.push({ cuenta: c.name, ref: n.ref ?? "", fecha: n.date, usd: n.usd, motivo: n.motivo });
      }
    }
    cajaFilas.sort((a, b) => (a.fecha === b.fecha ? a.cuenta.localeCompare(b.cuenta) : a.fecha.localeCompare(b.fecha)));
    const cajaTotal = Math.round(cajaFilas.reduce((s, r) => s + r.result, 0) * 100) / 100;

    // -----------------------------------------------------------------------
    // LO QUE SE ABSORBIÓ, que es lo único que es RESULTADO (Decisión 92).
    //
    // Al pagar se elige entre dejar la diferencia como utilidad/pérdida o
    // convertirla en un documento de ajuste (ATC). Lo segundo NO es pérdida:
    // es una cuenta por cobrar o por pagar todavía viva — cartera. Es la regla
    // que el Excel del dueño ya fijaba del lado cliente («lo que se convirtió
    // en documento ATC es cartera, no utilidad», `reports.ts` en dealPnlCore),
    // y aquí se aplica igual del lado proveedor.
    //
    // El ATC nace con `amount = −fxDiff`, mientras que el resultado derivado
    // lleva el signo de `fxResultDeltaFor` — que solo invierte del lado
    // proveedor. De ahí el `kind` en la resta: no es un ajuste, es la misma
    // cantidad vista desde los dos lados.
    // El ajuste cuenta el día que NACE y se descuenta el día que se REVIERTE
    // (`cancelled_at`, que `reversal.ts` sí escribe), nunca por su estado de
    // hoy: filtrar por estado movería hacia atrás el Resultado de un mes ya
    // cerrado. El porqué completo está en `splitFxCost`.
    const atcs = await sql<{ kind: string; nacidos: string; revertidos: string }>`
      select kind,
        coalesce(sum(amount) filter (where date between ${from} and ${to}), 0)::text as nacidos,
        coalesce(sum(amount) filter (where state = 'reversed' and cancelled_at::date between ${from} and ${to}), 0)::text as revertidos
      from invoices
      where company_id = ${companyId} and inv_class = 'fx'
      group by kind
    `;
    // La caja siempre se absorbe: usar dólares propios nunca abre un documento.
    const { total, enAjuste, absorbido } = splitFxCost({
      deuda: deudaTotal,
      caja: cajaTotal,
      ajustes: atcs.map((a) => ({ kind: a.kind, nacidos: Number(a.nacidos), revertidos: Number(a.revertidos) })),
    });

    return {
      from,
      to,
      deuda: { total: deudaTotal, proveedor: deudaProveedor, filas: deudaFilas },
      caja: {
        total: cajaTotal,
        filas: cajaFilas,
        noMedido: cajaNoMedido,
        sinCosto: Math.round(cajaNoMedido.filter((n) => n.motivo === "sin-costo").reduce((s, n) => s + n.usd, 0) * 100) / 100,
        sinTc: Math.round(cajaNoMedido.filter((n) => n.motivo === "sin-tc").reduce((s, n) => s + n.usd, 0) * 100) / 100,
      },
      total,
      /** Lo que de verdad se absorbió: lo único que entra al Resultado. */
      absorbido,
      /** Lo que se convirtió en documento de ajuste: cartera, todavía recuperable. */
      enAjuste,
    };
}

export const getFxCost = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ from: z.string(), to: z.string() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    // Los mismos dos candados que el P&L por periodo: es un total de empresa,
    // no tiene «mi parte», y enseña resultado.
    await assertCan(sql, context.userId, "credit", "view");
    const me = await activeMember(sql, context.userId);
    if (!canSeeMargins(me.role)) throw new Error("Sin permiso para ver márgenes");
    const companyId = await cid(sql, context.userId);
    return await fxCostOfPeriod(sql, companyId, data.from.slice(0, 10), data.to.slice(0, 10));
  });
