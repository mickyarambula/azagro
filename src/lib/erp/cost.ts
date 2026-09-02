import type { getSql } from "@/lib/db";

type Sql = Awaited<ReturnType<typeof getSql>>;

/**
 * De dónde salió el costo con el que el sistema está trabajando.
 * "kardex" = promedio móvil real; "referencia" = el que capturó administración
 * porque el producto nunca ha entrado a bodega; "ninguno" = no hay costo.
 */
export type CostSource = "kardex" | "referencia" | "ninguno";

/**
 * ORDEN ÚNICO para resolver el costo de un producto en todo el sistema:
 *   1) promedio móvil del kardex (products.cost), si es mayor que cero
 *   2) si no, costo de referencia (products.ref_cost), si es mayor que cero
 *   3) si no, no hay costo.
 * El kardex manda siempre: es lo que de verdad se pagó. El de referencia es
 * la red para el brokeraje/directo, que nunca pasa por bodega.
 */
export function resolveCost(i: { avgCost: number | string | null | undefined; refCost: number | string | null | undefined }) {
  const avg = Number(i.avgCost) || 0;
  if (avg > 0) return { cost: avg, source: "kardex" as CostSource };
  const ref = Number(i.refCost) || 0;
  if (ref > 0) return { cost: ref, source: "referencia" as CostSource };
  return { cost: 0, source: "ninguno" as CostSource };
}

export function costSourceLabel(source: CostSource) {
  if (source === "kardex") return "promedio móvil del kardex";
  if (source === "referencia") return "costo de referencia";
  return "sin costo";
}

/** La columna es nueva (migración 0016); las bases viejas se ponen al día solas. */
export async function ensureRefCost(sql: Sql) {
  await sql`alter table products add column if not exists ref_cost numeric(14,4) not null default 0`;
}

export type ProductCostRow = { id: number; code: string; name: string; cost: string; ref_cost: string };

export async function productCosts(sql: Sql, companyId: number) {
  await ensureRefCost(sql);
  return await sql<ProductCostRow>`
    select id, code, name, coalesce(cost,0)::text as cost, coalesce(ref_cost,0)::text as ref_cost
    from products where company_id = ${companyId}
  `;
}

/**
 * Candado del punto 3: a crédito el precio lleva financiamiento, y el
 * financiamiento se calcula sobre el costo. Sin costo saldría $0 y Azagro
 * regalaría el costo del dinero, así que el servidor no deja guardar.
 * De contado no aplica: no hay nada que financiar.
 */
export async function assertCostForCredit(sql: Sql, companyId: number, productIds: number[], creditDays: number) {
  if (creditDays <= 0 || !productIds.length) return;
  const rows = await productCosts(sql, companyId);
  const sinCosto: string[] = [];
  for (const id of [...new Set(productIds)]) {
    const p = rows.find((r) => r.id === id);
    if (!p) continue; // producto inexistente: lo reporta el insert, no este candado
    if (resolveCost({ avgCost: p.cost, refCost: p.ref_cost }).cost <= 0) sinCosto.push(`${p.code} ${p.name}`);
  }
  if (sinCosto.length) {
    const uno = sinCosto.length === 1;
    throw new Error(
      `${uno ? "Producto" : "Productos"} ${sinCosto.join(", ")} sin costo. ` +
        `Pide a administración que capture el costo de referencia en la ficha del producto, o cotiza de contado.`,
    );
  }
}
