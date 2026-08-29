import { addDays } from "@/lib/erp/credit";

export const TERM_KINDS = ["contado", "credit_days", "date", "harvest"] as const;
export const ROUTE_KINDS = ["own", "supplier", "asr"] as const;
export const PRICE_MODES = ["cash", "financed", "custom"] as const;

export type TermKind = (typeof TERM_KINDS)[number];

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
    return { invoiceDays: input.invoiceDays, creditDays: input.creditDays, invoiceDue, creditDue };
  }
  if (input.termKind === "harvest") {
    if (!input.creditDue) throw new Error("En cosecha hay que indicar la fecha de crédito / mora");
    const invoiceDue = (input.invoiceDue || addDays(date, input.invoiceDays)).slice(0, 10);
    return {
      invoiceDays: input.invoiceDays,
      creditDays: input.creditDays,
      invoiceDue,
      creditDue: input.creditDue.slice(0, 10),
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
