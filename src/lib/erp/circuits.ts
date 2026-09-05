import { createServerFn } from "@tanstack/react-start";
import { getSql, type Sql } from "@/lib/db";
import { authMiddleware } from "@/lib/auth/middleware";

/**
 * Catálogo de circuitos de financiamiento (PASO 0, 5-sep-2026). Ver
 * DISENO_FINANCIAMIENTO.md, ESTADO.md, DECISIONES.md.
 *
 * Cada pedido va a declarar por dónde corre su financiamiento: quién pone el
 * capital, quién le factura al cliente, sobre qué base corre el
 * financiamiento y qué comisión de apertura cobra. Hoy esos cuatro datos son
 * una sola fila de Ajustes (`company_settings.asr_commission/asr_spread`),
 * como si todo el negocio corriera por un solo circuito. No es así: el
 * circuito de doble facturación (ASR) sigue vigente y es distinto del
 * circuito lineal (Línea Santa Rosa) que se va a construir.
 *
 * Esta fase SOLO expone el catálogo para leerlo. Nada en el precio, la mora
 * ni los reportes lo consulta todavía — eso es el paso 3. El pedido tampoco
 * declara circuito todavía — eso es el paso 1.
 */

export type CircuitCode = "CONTADO" | "ASR" | "SANTA_ROSA" | "PROPIA";

export type CreditCircuit = {
  code: CircuitCode;
  name: string;
  /** Comisión de apertura. Null = no cobra, o no capturada todavía. */
  commissionRate: number | null;
  /** 'costo_comision' | 'costo_margen' | null (no financia, o sin construir). */
  financingBase: "costo_comision" | "costo_margen" | null;
  /** 'azagro' | 'santa_rosa' | null. */
  invoicesClient: "azagro" | "santa_rosa" | null;
  /** 'azagro' | 'santa_rosa' | null (null = nadie, circuito Contado). */
  finances: "azagro" | "santa_rosa" | null;
  moraShareAzagro: number | null;
  moraShareFinancier: number | null;
  enabled: boolean;
};

async function cid(sql: Sql, userId: string) {
  const rows = await sql<{ company_id: number }>`select company_id from members where user_id = ${userId} and status = 'active' limit 1`;
  if (!rows[0]) throw new Error("Sin empresa");
  return rows[0].company_id;
}

/**
 * Los cuatro circuitos de la empresa, en el orden fijo del catálogo. Solo
 * lectura: no hay pantalla ni servidor que hoy permita crear, editar ni
 * borrar un renglón — el catálogo nace con la migración 0024 y así se queda
 * hasta que se construya la Fase 1 del diseño.
 */
export const listCreditCircuits = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<CreditCircuit[]> => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    const rows = await sql<{
      code: string;
      name: string;
      commission_rate: string | null;
      financing_base: string | null;
      invoices_client: string | null;
      finances: string | null;
      mora_share_azagro: string | null;
      mora_share_financier: string | null;
      enabled: boolean;
    }>`
      select code, name, commission_rate::text, financing_base, invoices_client, finances,
        mora_share_azagro::text, mora_share_financier::text, enabled
      from credit_circuits
      where company_id = ${companyId}
      order by sort_order
    `;
    return rows.map((r) => ({
      code: r.code as CircuitCode,
      name: r.name,
      commissionRate: r.commission_rate == null ? null : Number(r.commission_rate),
      financingBase: r.financing_base as CreditCircuit["financingBase"],
      invoicesClient: r.invoices_client as CreditCircuit["invoicesClient"],
      finances: r.finances as CreditCircuit["finances"],
      moraShareAzagro: r.mora_share_azagro == null ? null : Number(r.mora_share_azagro),
      moraShareFinancier: r.mora_share_financier == null ? null : Number(r.mora_share_financier),
      enabled: r.enabled,
    }));
  });

export type FundingRateRow = { date: string; costRate: number; collectionRate: number };

/**
 * Tabla de tasas de dos columnas (Decisión 1, 5-sep-2026): tasa de costo y
 * tasa de cobro, por fecha. Nace vacía a propósito — no se deriva de
 * `tiie_rates` — así que lo normal, hoy, es que esta lista venga en blanco.
 */
export const listFundingRates = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<FundingRateRow[]> => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    const rows = await sql<{ date: string; cost_rate: string; collection_rate: string }>`
      select date::text, cost_rate::text, collection_rate::text
      from funding_rates
      where company_id = ${companyId}
      order by date desc
    `;
    return rows.map((r) => ({ date: r.date, costRate: Number(r.cost_rate), collectionRate: Number(r.collection_rate) }));
  });

/** Textos de pantalla para el panel de solo lectura de Ajustes. */
export const FINANCING_BASE_LABEL: Record<string, string> = {
  costo_comision: "Costo + comisión (lo que el circuito desembolsa)",
  costo_margen: "Costo + margen (lo que Santa Rosa desembolsaría)",
};

export const WHO_LABEL: Record<string, string> = {
  azagro: "Azagro",
  santa_rosa: "Santa Rosa",
};
