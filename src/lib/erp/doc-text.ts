import { pctRate, splitFegaBundle } from "@/lib/erp/credit";
import { dateDMY, moneyIn } from "@/lib/utils";

/**
 * TODO EL TEXTO QUE SALE DE LA EMPRESA vive aquí.
 *
 * Cada documento tiene dos versiones: la de pantalla, que puede llevar todo el
 * texto explicativo que ayude a operar, y la que sale hacia un tercero
 * (cliente, proveedor, fletero), que solo lleva lo que ese tercero necesita.
 *
 * Regla del dueño (4-sep-2026): el documento que sale NUNCA cuenta cómo
 * funciona el sistema por dentro — ni el nombre del sistema anterior, ni
 * migraciones, ni tasas de costo, ni umbrales de configuración, ni nombres de
 * pantallas, ni fórmulas internas, ni instrucciones de interacción. Sí explica
 * cómo se calcula lo que se cobra, porque el tercero tiene derecho a
 * verificarlo: "interés = cargo × tasa × días / 360" sí; el origen de la tasa,
 * no.
 *
 * `scripts/erp-documento-limpio.test.mjs` barre este archivo y las plantillas
 * de `print-doc.ts` y falla si vuelve una palabra interna. Las pantallas siguen
 * con su texto; los papeles y los envíos solo leen de aquí.
 */

/** Lo que se imprime en una celda cuando no hay nada que cobrar (la pantalla dice por qué). */
export const PAPER_DASH = "—";
/**
 * Lo que se imprime cuando el interés existe pero todavía no se determina
 * (falta la tasa del vencimiento o la condición de cobro del documento). El
 * cliente entiende que falta determinar algo y no se sorprende cuando llegue
 * la factura de intereses; el motivo real se queda en pantalla.
 */
export const PAPER_PENDING = "Pendiente de cálculo";

export type DocAudience = "cliente" | "proveedor";

// Series de folio que cada tercero puede ver en un "Expediente". Nunca
// cruzadas: el cliente no ve que se fue con proveedores (SC/OC) y el
// proveedor no ve el pedido del cliente (SOL/COT/PV/FV).
const SERIES: Record<DocAudience, string[]> = {
  cliente: ["SOL", "COT", "PV", "FV"],
  proveedor: ["SC", "OC"],
};

/**
 * Filtra la cadena de folios del expediente ("SOL-1 → SC-2 · SC-3 → COT-4")
 * dejando solo las series que ese tercero puede ver. Conserva el orden y la
 * agrupación; un grupo que se queda vacío desaparece.
 */
export function dealLineFor(line: string | null | undefined, audience: DocAudience) {
  if (!line) return "";
  const keep = SERIES[audience];
  const visible = (folio: string) => keep.some((s) => folio.toUpperCase().startsWith(`${s}-`));
  return line
    .split("→")
    .map((group) =>
      group
        .split("·")
        .map((f) => f.trim())
        .filter((f) => f && visible(f))
        .join(" · "),
    )
    .filter(Boolean)
    .join(" → ");
}

/** "Expediente …" ya filtrado para ese tercero, o vacío si no queda nada que mostrar. */
export function expedienteFor(line: string | null | undefined, audience: DocAudience) {
  const l = dealLineFor(line, audience);
  return l ? `Expediente ${l}` : "";
}

// ---------------------------------------------------------------------------
// Estado de cuenta (al cliente)
// ---------------------------------------------------------------------------

/** Notas al pie del estado de cuenta: solo lo que el cliente necesita para comprobar la cuenta. */
export function statementNotes(rates: { annual: string; commission: string; fega: string; total: string }) {
  return [
    `Interés = cargo × (${rates.annual}) × días vencidos / 360, solo a partir del día que vence.`,
    `Comisión ${rates.commission} + FEGA ${rates.fega} = ${rates.total} sobre el cargo, una sola vez, cuando el documento ya venció; se factura por separado.`,
    "Lo que aún no vence no lleva interés, ni comisión, ni FEGA: se muestran los días que faltan.",
    "Saldo = cargo − abonos; no incluye intereses. Ut. cambiaria = USD × (TC pactado − TC pagado).",
  ].join("\n");
}

/** El consolidado es de uso interno, pero se imprime: también sale limpio. */
export const CONSOLIDADO_NOTE = "Totales por cliente y moneda.";

/** Encabezado del mensaje del estado de cuenta: la regla con la que se puede comprobar cada renglón. */
export function statementSendHeader(rates: { annual: string; commission: string; fega: string }) {
  return `Interés = cargo × (${rates.annual}) × días vencidos / 360, a partir del vencimiento · comisión ${rates.commission} + FEGA ${rates.fega} sobre el cargo, una sola vez al vencer.`;
}

/** Un renglón del estado de cuenta, como va en el mensaje de correo o WhatsApp. */
export function statementSendLine(r: {
  serie?: string | null;
  folio?: string | null;
  name: string;
  date: string;
  plazo?: number | null;
  currency?: string | null;
  cargo: number;
  abono: number;
  saldo: number;
  due_date: string;
  vencido: boolean;
  sinMora: boolean;
  daysVencidos: number;
  diasPorVencer: number;
  interes: number;
  comisionFega: number;
}) {
  const cur = r.currency || "MXN";
  const head = [
    `${r.serie || ""} ${r.folio || r.name}`.trim(),
    dateDMY(r.date),
    `plazo ${r.plazo || "—"}`,
    `cargo ${moneyIn(r.cargo, cur)}`,
    `abono ${r.abono ? moneyIn(r.abono, cur) : "—"}`,
    `saldo ${moneyIn(r.saldo, cur)}`,
  ];
  if (r.sinMora) return [...head, "sin intereses"].join("  ");
  if (r.vencido) {
    return [
      ...head,
      `${r.daysVencidos} días vencidos`,
      `interés ${moneyIn(r.interes, cur)}`,
      `comisión + FEGA ${moneyIn(r.comisionFega, cur)}`,
    ].join("  ");
  }
  // La bonificación por pronto pago no se anuncia en el estado de cuenta: se
  // ofrece cuando conviene. Y su importe, dividido entre cargo y días,
  // despeja la tasa de costo. Solo en pantalla.
  return [...head, `vence ${dateDMY(r.due_date)} (faltan ${r.diasPorVencer} días)`, "sin interés ni comisión ni FEGA"].join("  ");
}

// ---------------------------------------------------------------------------
// Cotización y pedido (al cliente)
// ---------------------------------------------------------------------------

/**
 * Notas de la cotización: las del vendedor y el lugar de entrega. El cliente ve
 * el precio de contado y el del plazo; la diferencia la entiende solo — no se
 * le explica qué lleva adentro ni se le invita a preguntar por la tasa.
 */
export function quoteNotes(o: { notes?: string | null; deliveryTo?: string | null }) {
  return [o.notes || "", o.deliveryTo ? `Entrega: ${o.deliveryTo}` : ""].filter(Boolean).join(" · ");
}

// ---------------------------------------------------------------------------
// Orden de compra y solicitud de cotización (al proveedor)
// ---------------------------------------------------------------------------

/** Nota de la orden de compra. Sin etiquetas para nosotros mismos. */
export const PURCHASE_ORDER_NOTE = "Entregar en la ubicación indicada en cada partida.";

/** Mensaje de la solicitud de cotización. Nunca dice para qué compramos. */
export const RFQ_MESSAGE = "Favor de cotizar estas partidas y responder precio por unidad.";

export function rfqMessage(deliveryNote?: string | null) {
  return deliveryNote ? `Condiciones de entrega: ${deliveryNote}\n${RFQ_MESSAGE}` : RFQ_MESSAGE;
}

// ---------------------------------------------------------------------------
// Factura, factura de intereses, ajuste de tipo de cambio
// ---------------------------------------------------------------------------

export function invoicePaperTitle(kind: string, invClass?: string | null) {
  if (kind !== "customer") return "Factura de proveedor";
  if (invClass === "interest") return "Factura de intereses";
  if (invClass === "fx") return "Ajuste por tipo de cambio";
  return "Factura";
}

/**
 * Descripción de la partida en el papel. El `origin` de la factura es una
 * referencia nuestra ("Mora FV-0002", "Ajuste TC FV-0003", el pedido, o el
 * origen del saldo importado): aquí se traduce a lo que el tercero entiende y
 * nunca se imprime tal cual.
 */
export function invoiceLineLabel(i: { name: string; origin?: string | null; invClass?: string | null }) {
  const origin = (i.origin || "").trim();
  if (i.invClass === "interest") return `Intereses moratorios de ${origin.replace(/^Mora\s+/i, "") || "la factura"}`;
  if (i.invClass === "fx") return `Ajuste por tipo de cambio de ${origin.replace(/^Ajuste TC\s+/i, "") || "la factura"}`;
  if (/^PV-/i.test(origin)) return `Mercancía según pedido ${origin}`;
  if (/^OC-/i.test(origin)) return `Mercancía según orden ${origin}`;
  return `Saldo de factura ${i.name}`;
}

/**
 * Lo que la factura de intereses le explica al cliente, escrito el día que se
 * emite con los mismos números que se facturaron. Se guarda en la factura
 * (`calc_client`) para que se imprima igual aunque después cambien las tasas.
 * Solo fórmula y cifras: de dónde sale la tasa es asunto nuestro.
 */
export function interestInvoiceClientCalc(i: {
  currency?: string | null;
  asOf: string;
  capital: number;
  annualRate: number;
  days: number;
  interestAccrued: number;
  interestBefore: number;
  interestNew: number;
  fegaRate: number;
  commissionRate: number;
  fegaNew: number;
}) {
  const cur = i.currency || "MXN";
  const m = (n: number) => moneyIn(n, cur);
  const lines = [
    `Intereses moratorios al ${dateDMY(i.asOf)}: cargo original ${m(i.capital)} × tasa anual ${pctRate(i.annualRate)} × ${i.days} días vencidos / 360 = ${m(i.interestAccrued)}.`,
  ];
  if (i.interestBefore > 0.009) {
    lines.push(`Ya facturado en documentos anteriores: ${m(i.interestBefore)}. En esta factura: ${m(i.interestNew)}.`);
  }
  if (i.fegaNew > 0.009) {
    const split = splitFegaBundle(i.fegaRate, i.commissionRate);
    const partes = [
      split.commission > 0 ? `comisión ${pctRate(split.commission)}` : "",
      split.fega > 0 ? `FEGA ${pctRate(split.fega)}` : "",
    ].filter(Boolean);
    lines.push(`${partes.join(" + ")} sobre el cargo original, una sola vez: ${m(i.fegaNew)}.`);
  }
  lines.push(`Total de esta factura: ${m(i.interestNew + i.fegaNew)}.`);
  return lines.join("\n");
}

/**
 * El ajuste por tipo de cambio guarda su cuenta al nacer:
 * "12,000.00 USD × (TC pagado 18.90 − pactado 18.60) = 3,600.00". Es la
 * fórmula que el cliente necesita para comprobarlo, y no dice nada nuestro.
 */
export function fxAdjustmentNote(calc: string | null | undefined) {
  const c = (calc || "").trim();
  return c ? `Ajuste = ${c}.` : "";
}

/** Para una factura de intereses emitida antes de que se guardara la explicación. */
export function interestInvoiceFallback(i: { currency?: string | null; intPart: number; fegaPart: number }) {
  const cur = i.currency || "MXN";
  return [
    i.intPart > 0.009 ? `Intereses moratorios: ${moneyIn(i.intPart, cur)}.` : "",
    i.fegaPart > 0.009 ? `Comisión y FEGA sobre el cargo original, una sola vez: ${moneyIn(i.fegaPart, cur)}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
