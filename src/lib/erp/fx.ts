import type { Sql } from "@/lib/db";

/**
 * Moneda y tipo de cambio en la cadena de compra (Decisiones 76-81, 17-sep-2026,
 * MODELO-NEGOCIO.md § 11). Todo lo que convierte vive aquí y corre ANTES de
 * entrar a pricing.ts / cost.ts / stock.ts: el motor sigue recibiendo números
 * puros en pesos y no cambia de firma.
 *
 * Convención mientras L4a siga abierta: el costo de una partida de solicitud o
 * cotización (`cost`) está SIEMPRE en pesos — la unidad en que hoy viven los
 * precios y el kardex —; `cost_currency` y `cost_fx` dicen en qué moneda lo dio
 * el proveedor y con qué TC USD→MXN se convirtió. La OC guarda su `unit_price`
 * en SU moneda con SU `fx_rate` (el del proveedor, Decisión 78), y la FP nace
 * como la FV: pesos al TC de la OC, con el original en `amount_fx` (Decisión 79).
 */
export type Currency = "MXN" | "USD";
export type FxRow = { date: string; rate: number };

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

/** Un TC USD→MXN real es mayor que 1: el 1 es el default del esquema, nunca un tipo de cambio. */
export function isUsdFx(fx: number | string | null | undefined) {
  const n = Number(fx);
  return Number.isFinite(n) && n > 1;
}

export function missingFxMessage(what: string) {
  return `Sin tipo de cambio para ${what}. Captúralo: la pantalla lo propone de la tabla (Ajustes → Tipo de cambio) y se puede corregir; sin renglón en la tabla no se guarda nada en dólares.`;
}

/** La tabla de TC de la empresa, ordenada por fecha. */
export async function loadFxTable(sql: Sql, companyId: number): Promise<FxRow[]> {
  const rows = await sql<{ date: string; usd_mxn: string }>`
    select date::text, usd_mxn::text from fx_rates where company_id = ${companyId} order by date
  `;
  return rows.map((r) => ({ date: r.date, rate: Number(r.usd_mxn) }));
}

/** TC de la tabla vigente en una fecha: el renglón más reciente con fecha ≤ asOf, o null (nunca un respaldo). */
export function fxAt(table: FxRow[], asOf: string): FxRow | null {
  const t = asOf.slice(0, 10);
  let pick: FxRow | null = null;
  for (const row of [...table].sort((a, b) => a.date.localeCompare(b.date))) {
    if (row.date <= t) pick = row;
    else break;
  }
  return pick;
}

/**
 * Decisión 76: un costo dado por el proveedor en `currency`, a pesos. En MXN es
 * el mismo número; en USD exige el TC (el de la tabla a la fecha, enseñado y
 * editable) y sin él se detiene.
 */
/**
 * EL TC DE HOY, UN SOLO LUGAR (bloque A.2). Antes esto se resolvía en catorce
 * puntos del código y uno de ellos contestaba distinto (tomaba el último
 * renglón de la tabla SIN tope de fecha: si alguien capturaba el tipo de
 * cambio del lunes, un documento del viernes nacía con él).
 *
 * Devuelve el renglón vigente a la fecha — el más reciente igual o anterior,
 * misma regla que la TIIE (`nearestRate`) — o null si la tabla no lo cubre.
 * Nunca inventa un tipo de cambio: sin renglón, quien llama se detiene y avisa
 * (regla 9).
 */
export async function fxToday(sql: Sql, companyId: number, asOf: string): Promise<FxRow | null> {
  return fxAt(await loadFxTable(sql, companyId), asOf);
}

export function costToMxn(i: { cost: number; currency: Currency | string; fx?: number | string | null; what: string }) {
  if (i.currency === "USD") {
    if (!isUsdFx(i.fx)) throw new Error(missingFxMessage(i.what));
    return { mxn: r4(i.cost * Number(i.fx)), currency: "USD" as Currency, fx: Number(i.fx) };
  }
  return { mxn: r4(i.cost), currency: "MXN" as Currency, fx: null as number | null };
}

/** El costo en pesos de vuelta a la moneda del proveedor (la OC que nace de una solicitud, Decisión 78). */
export function mxnToCostCurrency(i: { mxn: number; currency: Currency | string; fx?: number | string | null; what: string }) {
  if (i.currency === "USD") {
    if (!isUsdFx(i.fx)) throw new Error(missingFxMessage(i.what));
    return r4(i.mxn / Number(i.fx));
  }
  return r4(i.mxn);
}

/**
 * Decisión 79: la FP nace con el molde de la FV y del corte — `amount` en pesos
 * al TC de la OC, `amount_fx` en la moneda de la OC, `fx_agreed` = ese TC. En
 * MXN `amount_fx` queda en 0, como en la FV.
 */
export function supplierInvoiceAmounts(i: { total: number | string; currency: string; fx: number | string | null | undefined; poName: string }) {
  const total = r2(Number(i.total) || 0);
  if (i.currency === "USD") {
    if (!isUsdFx(i.fx)) {
      throw new Error(
        `${i.poName} está en dólares sin tipo de cambio: la deuda con el proveedor no puede nacer en pesos. ` +
          `Captura el TC de la orden en Compras (columna TC) y vuelve a recibir (o a entregar, si es directa).`,
      );
    }
    const fx = Number(i.fx);
    return { amount: r2(total * fx), amountFx: total, fxAgreed: fx, currency: "USD" as Currency };
  }
  return { amount: total, amountFx: 0, fxAgreed: 1, currency: "MXN" as Currency };
}

/**
 * El costo de una partida de OC en pesos, para el P&L: USD × TC de la OC. Una OC
 * en dólares sin TC real no se convierte a nada — regresa null y el P&L excluye
 * la partida con motivo, en vez de restar dólares contra pesos.
 */
export function poCostToMxn(i: { unitPrice: number | string | null | undefined; currency: string | null | undefined; fx: number | string | null | undefined }) {
  if (i.unitPrice == null) return null;
  const unit = Number(i.unitPrice);
  if ((i.currency ?? "MXN") !== "USD") return unit;
  return isUsdFx(i.fx) ? r4(unit * Number(i.fx)) : null;
}

/** Cómo se enseña un importe de factura por fila: en USD lo pactado en dólares (`amount_fx`), en MXN los pesos. */
export function invoiceShown(i: {
  amount: number | string;
  residual: number | string;
  currency: string;
  amountFx: number | string | null | undefined;
  fxAgreed: number | string | null | undefined;
}) {
  const amount = Number(i.amount);
  const residual = Number(i.residual);
  // Una NC en dólares lleva amount_fx NEGATIVO (espejo de la FV): distinto de cero, no mayor que cero.
  if (i.currency === "USD" && isUsdFx(i.fxAgreed) && Number(i.amountFx) !== 0) {
    const fx = Number(i.fxAgreed);
    return { amount: Number(i.amountFx), residual: r2(residual / fx), paid: r2((amount - residual) / fx), currency: "USD" as Currency, fx };
  }
  return { amount, residual, paid: r2(amount - residual), currency: (i.currency === "USD" ? "USD" : "MXN") as Currency, fx: null as number | null };
}

/**
 * Decisión 80: cómo se liquida un abono según la moneda de la factura y la de
 * la cuenta de banco.
 *   - "usd-con-pesos":   factura en dólares pagada/cobrada con pesos → fxPaymentSplit
 *                        (credit.ts) y diferencial cambiario, en los dos lados.
 *   - "usd-con-dolares": factura en dólares contra la cuenta en dólares → sin
 *                        diferencial; el banco lleva dólares.
 *   - "mxn-con-dolares": factura en pesos pagada desde la cuenta en dólares →
 *                        se convierte al TC del pago; sin diferencial (la deuda es en pesos).
 *   - "mxn":             como siempre.
 */
export type SettleMode = "mxn" | "usd-con-pesos" | "usd-con-dolares" | "mxn-con-dolares";
export function settleMode(i: { usdInvoice: boolean; bankUsd: boolean }): SettleMode {
  if (i.usdInvoice) return i.bankUsd ? "usd-con-dolares" : "usd-con-pesos";
  return i.bankUsd ? "mxn-con-dolares" : "mxn";
}

/** Factura en dólares liquidada desde la cuenta en dólares: dólares contra dólares, el libro en pesos al TC pactado. */
export function usdBankSettlement(i: { amountUsd: number; fxAgreed: number; residualMxn: number }) {
  const residualUsd = i.residualMxn / i.fxAgreed;
  const usdApplied = r2(Math.min(i.amountUsd, residualUsd));
  return { usdApplied, appliedMxn: r2(usdApplied * i.fxAgreed), bankUsd: usdApplied };
}

/** Factura en pesos pagada con dólares: los dólares que salen valen pesos al TC del pago. */
export function mxnInvoicePaidInUsd(i: { amountUsd: number; fxPaid: number; residualMxn: number }) {
  if (!isUsdFx(i.fxPaid)) throw new Error("Pagar una factura en pesos desde la cuenta en dólares: captura el tipo de cambio del pago.");
  const appliedMxn = r2(Math.min(r2(i.amountUsd * i.fxPaid), i.residualMxn));
  return { appliedMxn, bankUsd: r2(appliedMxn / i.fxPaid) };
}

/**
 * El diferencial (pesos del banco − pesos al pactado) es utilidad para Azagro
 * cuando el CLIENTE pagó de más, y pérdida cuando Azagro le pagó de más al
 * PROVEEDOR: mismo número, signo contrario.
 */
export function fxResultDeltaFor(kind: string, fxDiff: number) {
  return kind === "supplier" ? r2(-fxDiff) : r2(fxDiff);
}

/**
 * Decisión 77: el costo con el que una recepción entra al kardex, en pesos —
 * `unit_price` de la OC × su TC si la OC es en dólares. Se convierte ANTES de
 * `postStock`; el kardex no sabe de monedas. Una OC en dólares sin TC real no
 * entra (misma salida que la FP: capturar el TC en Compras).
 */
export function receiptUnitCostMxn(i: { unitPrice: number | string; currency: string; fx: number | string | null | undefined; poName: string }) {
  const unit = Number(i.unitPrice) || 0;
  if (i.currency === "USD") {
    if (!isUsdFx(i.fx)) {
      throw new Error(
        `${i.poName} está en dólares sin tipo de cambio: la mercancía no puede entrar al inventario en pesos. ` +
          `Captura el TC de la orden en Compras (columna TC) y vuelve a recibir.`,
      );
    }
    return r4(unit * Number(i.fx));
  }
  return r4(unit);
}

/**
 * Decisión 81: comprar (o vender) dólares es un movimiento propio con tipo de
 * cambio y las dos patas ligadas. En cada cuenta el movimiento va en SU moneda;
 * `amount_fx` lleva los dólares del cambio con el signo de la pata.
 */
export type ExchangeKind = "compra-usd" | "venta-usd";
export function exchangeLegs(i: { direction: ExchangeKind; usd: number; fx: number }) {
  if (!isUsdFx(i.fx)) throw new Error(missingFxMessage(i.direction === "compra-usd" ? "la compra de dólares" : "la venta de dólares"));
  const usd = r2(Math.abs(i.usd));
  const mxn = r2(usd * i.fx);
  if (i.direction === "compra-usd") {
    return { usd, mxn, pesos: { amount: -mxn, amountFx: -usd }, dolares: { amount: usd, amountFx: usd } };
  }
  return { usd, mxn, pesos: { amount: mxn, amountFx: usd }, dolares: { amount: -usd, amountFx: -usd } };
}

/**
 * Decisión 81: los dólares en caja llevan su costo en pesos a promedio móvil
 * por cuenta — el patrón del kardex (`movingAverage`): cada entrada con TC
 * (compra de dólares, cobro en dólares) se pondera; cada salida sale al
 * promedio. Los dólares sin TC (el saldo inicial, un ajuste) se llevan aparte
 * como «sin TC»: no se les inventa costo (regla 9). Los movimientos van en
 * orden de captura; una salida consume primero los dólares con costo.
 */
export type UsdCashMove = {
  amount: number | string;
  /** TC con el que entró o al que salió. Nulo = sin TC conocido. */
  fxRate: number | string | null | undefined;
  reversal?: boolean;
  /** Para poder nombrar la salida en pantalla. Opcionales: el promedio no los usa. */
  ref?: string | null;
  date?: string | null;
  /** Id del movimiento, para que una reversa pueda deshacer la salida que revierte. */
  id?: number | null;
  /** A cuál movimiento revierte. */
  reversesId?: number | null;
  /** Tipo del movimiento. Un traslado entre cuentas en dólares NUNCA realiza. */
  kind?: string | null;
};

/**
 * UNA SALIDA DE DÓLARES, con lo que costaron y lo que valieron (Decisión 91).
 *
 * Los dólares en caja son como la mercancía en la bodega: entran con un costo,
 * se promedian, y cuando salen **salen a ese costo**. La diferencia contra lo
 * que valieron al usarse es una ganancia o una pérdida REALIZADA, igual que el
 * margen de una venta contra el costo del kardex.
 */
export type UsdCashExit = {
  ref: string | null;
  date: string | null;
  /** Id del movimiento que sacó los dólares, para poder deshacerlo al revertir. */
  id: number | null;
  /** Dólares que salieron con costo conocido. */
  usd: number;
  /** TC al que salieron: lo que valieron al usarse. */
  fxOut: number;
  /** TC al que habían entrado: el promedio móvil en ESE momento. */
  fxCost: number;
  /** Pesos ganados (+) o perdidos (−): usd × (fxOut − fxCost). */
  result: number;
};

/**
 * Dólares que salieron y NO se pudieron medir, con su motivo. Se dicen aparte
 * en vez de contarse como cero: un cero mudo haría creer que no pasó nada.
 */
export type UsdCashUnmeasured = {
  ref: string | null;
  date: string | null;
  usd: number;
  /** `sin-costo` = venían del saldo inicial, sin TC de entrada con qué comparar.
   *  `sin-tc` = tenían costo, pero el movimiento no dice a qué TC salieron. */
  motivo: "sin-costo" | "sin-tc";
};

/**
 * EL CORTE ENTRE LO ABSORBIDO Y LO QUE QUEDÓ EN CARTERA (Decisión 92), puro.
 *
 * Al pagar se elige entre dejar la diferencia como utilidad/pérdida o
 * convertirla en un ajuste por TC. Lo segundo **no es pérdida**: es una cuenta
 * viva, por cobrar o por pagar. Solo lo absorbido entra al resultado.
 *
 * El ajuste nace con `amount = −fxDiff`, mientras que el resultado derivado
 * lleva el signo de `fxResultDeltaFor`, que solo invierte del lado proveedor:
 * de ahí el `kind`. No es un ajuste de signo, es el mismo número visto desde
 * los dos lados.
 *
 * **Por qué `nacidos − revertidos` y no «los que siguen vivos»:** filtrar por
 * estado movería un mes ya cerrado. Si un ajuste de septiembre se revierte en
 * octubre, septiembre dejaría de contarlo —y su Resultado cambiaría hacia
 * atrás—, mientras el contra-pago cae en octubre sin nada que lo compense. Los
 * dos meses se moverían por un hecho que en neto no fue ni ganancia ni
 * pérdida. Contando el ajuste el día que NACE y descontándolo el día que se
 * REVIERTE, cada mes cierra en cero por su cuenta, igual que se autocancela el
 * par de pagos. Lo atrapó el revisor de dinero con $4,000 de ejemplo.
 */
export function splitFxCost(i: {
  /** Total de la mitad «deuda»: pagar en pesos lo que se debía en dólares. */
  deuda: number;
  /** Total de la mitad «caja»: usar dólares que ya se tenían. Siempre se absorbe. */
  caja: number;
  ajustes: Array<{ kind: string; nacidos: number; revertidos: number }>;
}) {
  const total = r2(i.deuda + i.caja);
  const enAjuste = r2(
    i.ajustes.reduce((s, a) => {
      const neto = Number(a.nacidos) - Number(a.revertidos);
      return s + (a.kind === "customer" ? -neto : neto);
    }, 0),
  );
  return { total, enAjuste, absorbido: r2(total - enAjuste) };
}

/**
 * EL RECORRIDO, uno solo (Decisión 91). De aquí salen las dos preguntas que se
 * le hacen a la caja en dólares —cuánto vale hoy y cuánto se ganó o se perdió
 * al usarla— para que nunca haya dos promedios distintos.
 *
 * **Una reversa nunca realiza nada: deshace, no usa.** Revertir una ENTRADA la
 * borra a su propio TC, así que el promedio queda como si no hubiera existido.
 * Revertir una SALIDA devuelve los dólares **al costo con el que salieron** y
 * borra la ganancia que se había medido — no al TC de liquidación, que es lo
 * que copia el contra-movimiento y lo que antes ensuciaba el promedio.
 *
 * Los dólares sin TC conocido (saldo inicial del corte) no tienen costo con qué
 * compararse: salen sin realizar nada y se cuentan aparte. No se les inventa uno.
 */
function walkUsdCash(i: { opening: number; moves: UsdCashMove[] }) {
  let tracked = 0;
  let costMxn = 0;
  let untracked = Math.max(0, Number(i.opening) || 0);
  const exits: UsdCashExit[] = [];
  const noMedidos: UsdCashUnmeasured[] = [];
  for (const m of i.moves) {
    const amount = Number(m.amount) || 0;
    // REVERSA DE UNA SALIDA (importe POSITIVO: el contra-movimiento copia el
    // original con signo opuesto). Deshace, no usa: los dólares vuelven **al
    // costo con el que salieron** y la ganancia que se había medido se borra.
    // Antes caía por la rama de entrada normal: entraba al TC de liquidación
    // —no al costo— y dejaba publicada una ganancia de una operación que se
    // deshizo. Lo atrapó el revisor de dinero con $5,000 de ejemplo.
    if (m.reversal && amount > 0 && m.reversesId != null) {
      const k = exits.findIndex((e) => e.id === m.reversesId);
      if (k >= 0) {
        const e = exits[k]!;
        tracked += e.usd;
        costMxn += e.usd * e.fxCost;
        exits.splice(k, 1);
        continue;
      }
    }
    if (m.reversal && isUsdFx(m.fxRate) && amount < 0) {
      const out = Math.min(-amount, tracked);
      costMxn -= out * Number(m.fxRate);
      tracked -= out;
      untracked = Math.max(0, untracked - (-amount - out));
      continue;
    }
    if (amount > 0) {
      if (isUsdFx(m.fxRate)) {
        tracked += amount;
        costMxn += amount * Number(m.fxRate);
      } else {
        untracked += amount;
      }
    } else if (amount < 0) {
      let out = -amount;
      const fromTracked = Math.min(out, tracked);
      if (fromTracked > 0 && tracked > 0) {
        // El promedio EN ESTE MOMENTO: lo que costaron los dólares que salen.
        const avgNow = costMxn / tracked;
        // UN TRASLADO ENTRE CUENTAS EN DÓLARES NO REALIZA NADA (Decisión 86):
        // son los mismos dólares cambiados de cuenta. Sale del tipo, no de
        // comparar números: el traslado se estampa con el promedio YA
        // REDONDEADO a cuatro decimales, así que restarlo contra el promedio
        // sin redondear publicaba centavos —y hasta $24 en un traslado grande—
        // de ganancia inventada. Lo atrapó el revisor de dinero.
        if (m.kind === "transferencia") {
          // no realiza
        } else if (isUsdFx(m.fxRate)) {
          exits.push({
            ref: m.ref ?? null,
            date: m.date ?? null,
            id: m.id ?? null,
            usd: r2(fromTracked),
            fxOut: r4(Number(m.fxRate)),
            fxCost: r4(avgNow),
            result: r2(fromTracked * (Number(m.fxRate) - avgNow)),
          });
        } else {
          // Tenían costo, pero el movimiento no dice a qué TC salieron: no se
          // inventa uno (regla 9) y no se esconde en un cero.
          noMedidos.push({ ref: m.ref ?? null, date: m.date ?? null, usd: r2(fromTracked), motivo: "sin-tc" });
        }
        costMxn -= avgNow * fromTracked;
        tracked -= fromTracked;
        out -= fromTracked;
      }
      // Lo que salió de los dólares sin TC de entrada no realiza nada: no hay
      // con qué comparar. Se dice con su fecha, para poder recortarlo al periodo.
      if (out > 0.0000001) {
        const sin = Math.min(out, untracked);
        if (sin > 0.0000001 && m.kind !== "transferencia") {
          noMedidos.push({ ref: m.ref ?? null, date: m.date ?? null, usd: r2(sin), motivo: "sin-costo" });
        }
      }
      untracked = Math.max(0, untracked - out);
    }
  }
  const avgFx = tracked > 0.0000001 ? Math.round((costMxn / tracked) * 10000) / 10000 : null;
  return { tracked, untracked, avgFx, exits, noMedidos };
}

export function usdCashAverage(i: { opening: number; moves: Array<{ amount: number | string; fxRate: number | string | null | undefined; reversal?: boolean }> }) {
  const w = walkUsdCash(i);
  return {
    usd: r2(w.tracked + w.untracked),
    tracked: r2(w.tracked),
    sinTc: r2(w.untracked),
    avgFx: w.avgFx,
    mxn: w.avgFx != null ? r2(w.tracked * w.avgFx) : null,
  };
}

/**
 * CUÁNTO SE GANÓ O SE PERDIÓ AL USAR LOS DÓLARES (Decisión 91).
 *
 * Mismo recorrido que el promedio, otra pregunta. Hay que recorrer SIEMPRE
 * desde el principio —el costo de una salida depende de todo lo que entró
 * antes—, y luego quedarse con las salidas del periodo que se pregunta.
 */
export function usdCashRealized(i: { opening: number; moves: UsdCashMove[] }) {
  const w = walkUsdCash(i);
  return {
    exits: w.exits,
    total: r2(w.exits.reduce((s, e) => s + e.result, 0)),
    /** Salidas que no se pudieron medir, con su motivo y su fecha (para recortarlas al periodo). */
    noMedidos: w.noMedidos,
  };
}

/**
 * Decisión 82 (cierra L4a): el precio de venta se CAPTURA en la moneda del
 * documento, con la etiqueta puesta, y se GUARDA en pesos al TC del documento —
 * el espejo de la Decisión 76 del lado venta. Los lectores en pesos (límite de
 * crédito, estado de cuenta, P&L, FV) no cambian.
 */
export function saleToMxn(i: { price: number | string; currency: string; fx?: number | string | null; what: string }) {
  const price = Number(i.price) || 0;
  if (i.currency === "USD") {
    if (!isUsdFx(i.fx)) throw new Error(missingFxMessage(i.what));
    return r4(price * Number(i.fx));
  }
  return r4(price);
}

/** Pesos → lo que se enseña y se imprime: en USD el precio en dólares (÷ TC del documento), en MXN los pesos. */
export function salePriceShown(mxn: number | string, currency: string, fx?: number | string | null) {
  const n = Number(mxn) || 0;
  if (currency === "USD" && isUsdFx(fx)) return r4(n / Number(fx));
  return n;
}

/**
 * Al re-guardar un documento en dólares, la pantalla manda el precio en dólares
 * que ella misma derivó (pesos ÷ TC, a 4 decimales). Si es el mismo número que
 * ya estaba, se conserva el precio en pesos guardado — nunca un ida y vuelta
 * que mueva centavos y ensucie la bitácora. Si cambió, se convierte.
 */
/**
 * Base del financiamiento del precio (comisión + interés anual por unidad),
 * calculada por el servidor en pesos, llevada a la moneda en que se captura
 * el precio: en dólares se divide por el TC del documento. Sin TC válido se
 * queda en pesos (el servidor no deja guardar en dólares sin TC).
 */
export function finShown<T extends { commission: number; interestYear: number }>(fin: T, currency: string, fx: number | string | null | undefined): T {
  if (currency !== "USD" || !isUsdFx(fx)) return fin;
  const f = Number(fx);
  return { ...fin, commission: r4(fin.commission / f), interestYear: r4(fin.interestYear / f) };
}

/**
 * Un precio que la pantalla enseña en una moneda, re-enseñado en otra: cuando
 * cambia la moneda del documento (o aparece el TC que faltaba), lo ya escrito
 * se lleva a pesos con el TC anterior y de ahí a la moneda nueva. "USD sin TC
 * válido" cuenta como pesos, igual que en salePriceShown. Con la misma moneda
 * efectiva y otro TC, lo escrito en dólares sigue siendo esos dólares.
 */
export function reshowPrice(shown: number, prev: { currency: string; fx: number | string | null | undefined }, next: { currency: string; fx: number | string | null | undefined }) {
  const prevUsd = prev.currency === "USD" && isUsdFx(prev.fx);
  const nextUsd = next.currency === "USD" && isUsdFx(next.fx);
  if (prevUsd === nextUsd) return shown;
  const mxn = prevUsd ? (Number(shown) || 0) * Number(prev.fx) : Number(shown) || 0;
  return salePriceShown(mxn, next.currency, next.fx);
}

export function snapOrConvert(i: { sent: number | string; prevMxn: number | string | null | undefined; currency: string; fx?: number | string | null; what: string }) {
  const sent = Number(i.sent) || 0;
  if (i.currency !== "USD") return r4(sent);
  if (i.prevMxn != null && Math.abs(salePriceShown(i.prevMxn, "USD", i.fx) - sent) < 0.00005) return r4(Number(i.prevMxn));
  return saleToMxn({ price: sent, currency: "USD", fx: i.fx, what: i.what });
}
