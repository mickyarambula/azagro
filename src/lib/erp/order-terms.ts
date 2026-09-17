import { addDays, daysBetween, NO_MORA_POLICY } from "@/lib/erp/credit";

export const TERM_KINDS = ["contado", "credit_days", "date", "harvest"] as const;
export const ROUTE_KINDS = ["own", "supplier", "asr"] as const;
export const PRICE_MODES = ["cash", "financed", "custom"] as const;

export type TermKind = (typeof TERM_KINDS)[number];

/**
 * Plazos del pedido. UNA SOLA FUENTE para los días (hallazgo #4 de la
 * auditoría, 17-sep-2026): con plazo a Fecha o a Cosecha los días se DERIVAN
 * de la fecha capturada (`creditDue − date`, `invoiceDue − date`), nunca se
 * copian del formulario. Antes se copiaban, y un pedido a cosecha con
 * vencimiento a 200 días podía nacer con `credit_days = 0`: la FV salía como
 * contado (sin costo financiero) y el pronto pago tomaba los días de Ajustes.
 * `credit_days = 0` significa contado y nada más.
 */
export function computeDues(input: {
  date: string;
  termKind: TermKind;
  invoiceDays: number;
  creditDays: number;
  invoiceDue?: string;
  creditDue?: string;
}) {
  const date = input.date.slice(0, 10);
  if (input.termKind === "contado") {
    return { invoiceDays: 0, creditDays: 0, invoiceDue: date, creditDue: date };
  }
  if (input.termKind === "date") {
    const invoiceDue = (input.invoiceDue || date).slice(0, 10);
    const creditDue = (input.creditDue || input.invoiceDue || date).slice(0, 10);
    return {
      invoiceDays: Math.max(0, daysBetween(date, invoiceDue)),
      creditDays: Math.max(0, daysBetween(date, creditDue)),
      invoiceDue,
      creditDue,
    };
  }
  if (input.termKind === "harvest") {
    if (!input.creditDue) throw new Error("En cosecha hay que indicar la fecha de crédito / mora");
    const invoiceDue = (input.invoiceDue || addDays(date, input.invoiceDays)).slice(0, 10);
    const creditDue = input.creditDue.slice(0, 10);
    return {
      invoiceDays: Math.max(0, daysBetween(date, invoiceDue)),
      creditDays: Math.max(0, daysBetween(date, creditDue)),
      invoiceDue,
      creditDue,
    };
  }
  const invoiceDays = input.invoiceDays;
  const creditDays = input.creditDays || invoiceDays;
  return {
    invoiceDays,
    creditDays,
    invoiceDue: addDays(date, invoiceDays),
    creditDue: addDays(date, creditDays),
  };
}

/**
 * LA REGLA ÚNICA DEL NACIMIENTO A CRÉDITO (Decisiones 68 y 69, 17-sep-2026).
 *
 * En ventas a crédito SIEMPRE hay mora: lo que se negocia es la tasa (la
 * política), no si existe. Por eso un documento de venta nace solo si:
 *   - trae política capturada y esa política existe en el catálogo;
 *   - con plazo financiero (> 0 días) la política NO es «Sin mora»;
 *   - sin plazo (contado, 0 días) la política ES «Sin mora» — contado ⇔ Sin
 *     mora en las dos direcciones, para que `credit_days = 0` signifique una
 *     sola cosa (Decisión 69 a).
 *
 * La llaman TODOS los caminos por los que nace un pedido: `saveOrder`,
 * `createSale`, `decideQuote` y la conversión de la OC del cliente. Es pura:
 * recibe los códigos del catálogo y no consulta nada. Devuelve el mensaje
 * para la persona (español, sin tripas del sistema) o null si todo cuadra.
 */
export function saleTermsError(input: { creditDays: number; policyCode: string | null | undefined; policies: readonly string[] }): string | null {
  const code = (input.policyCode ?? "").trim();
  const credit = input.creditDays > 0;
  if (!code) {
    return credit
      ? "Elige la política de cobro del pedido: en ventas a crédito siempre hay mora, y la política dice a qué tasa."
      : "Elige la política de cobro del pedido: de contado es «Sin mora».";
  }
  if (!input.policies.includes(code)) {
    return `La política de cobro «${code}» no existe en el catálogo. Elige una de Ajustes → Políticas de cobro.`;
  }
  if (credit && code === NO_MORA_POLICY) {
    return "En ventas a crédito siempre hay mora: «Sin mora» es solo para contado. Elige la política de cobro que corresponde al cliente.";
  }
  if (!credit && code !== NO_MORA_POLICY) {
    return "Un pedido de contado no genera mora: su política de cobro es «Sin mora». Si la venta es a crédito, captura el plazo.";
  }
  return null;
}

export function assertSaleTerms(input: { creditDays: number; policyCode: string | null | undefined; policies: readonly string[] }) {
  const err = saleTermsError(input);
  if (err) throw new Error(err);
}
