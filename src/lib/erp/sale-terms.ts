import type { Sql } from "@/lib/db";
import { assertSaleTerms } from "@/lib/erp/order-terms";

/** Códigos del catálogo de políticas de cobro de la empresa (Ajustes). */
export async function creditPolicyCodes(sql: Sql, companyId: number) {
  const rows = await sql<{ code: string }>`select code from credit_policies where company_id = ${companyId}`;
  return rows.map((r) => r.code);
}

/**
 * La regla única del nacimiento a crédito (`assertSaleTerms`, Decisiones 68 y
 * 69) con el catálogo leído de la base. La llaman los cuatro caminos por los
 * que nace un pedido: `saveOrder`, `createSale`, `decideQuote` y
 * `convertCustomerPO`. Si algo no cuadra, se detiene y avisa; nunca rellena.
 */
export async function guardSaleTerms(sql: Sql, companyId: number, input: { creditDays: number; policyCode: string | null | undefined }) {
  assertSaleTerms({ ...input, policies: await creditPolicyCodes(sql, companyId) });
}
