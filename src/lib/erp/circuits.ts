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
 * ni los reportes lo consulta todavía — eso es el paso 3.
 *
 * PASO 1 (etiqueta): cada documento guarda `circuit_code`, lo hereda por la
 * cadena y lo muestra; los ayudantes puros de abajo (circuitForTerm,
 * inheritCircuit, circuitLabel) son lo único que usan el servidor y las
 * pantallas. Todavía no hay selector (paso 2) y el motor no lo lee (paso 3).
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

/**
 * Nombres de pantalla de los cuatro circuitos: los mismos que sembró la
 * migración 0024 en `credit_circuits.name`. Se usan como etiqueta de solo
 * lectura en solicitud, cotización, pedido, cartera y estado de cuenta.
 */
export const CIRCUIT_LABEL: Record<CircuitCode, string> = {
  CONTADO: "Contado",
  ASR: "Circuito ASR",
  SANTA_ROSA: "Línea Santa Rosa",
  PROPIA: "Línea propia",
};

export function isCircuitCode(code: unknown): code is CircuitCode {
  return code === "CONTADO" || code === "ASR" || code === "SANTA_ROSA" || code === "PROPIA";
}

/** Etiqueta para pantalla; un documento sin circuito guardado lo dice tal cual. */
export function circuitLabel(code: string | null | undefined): string {
  return isCircuitCode(code) ? CIRCUIT_LABEL[code] : "Sin circuito";
}

/**
 * La solicitud nace SIN circuito (nulo), no en Contado: mientras nadie
 * capture el plazo, el sistema no ha decidido nada, y Contado es justo el
 * circuito que no cobra financiamiento (decisión del dueño, 5-sep-2026). Se
 * resuelve sola con `inheritCircuit` en cuanto se guarda un plazo, así sea 0.
 * Un documento con quote_id ya tiene circuito resuelto (nunca llega aquí en
 * la práctica) — este texto es solo para la solicitud todavía sin cotizar.
 */
export function requestCircuitLabel(code: string | null | undefined): string {
  return isCircuitCode(code) ? CIRCUIT_LABEL[code] : "Sin definir";
}

/**
 * Regla decidida por la dirección (5-sep-2026) para un documento que nace
 * sin circuito heredado: plazo 0 → Contado; con plazo, mientras el circuito
 * lineal no exista, el sistema propone el Circuito ASR (el vigente).
 */
export function circuitForTerm(days: number): CircuitCode {
  return days > 0 ? "ASR" : "CONTADO";
}

/**
 * Herencia por la cadena (SOL → COT → PV → FV → FI/NC/ATC), igual que el
 * plazo y la moneda: el documento nuevo trae el circuito del anterior. Si el
 * plazo se vuelve 0 es Contado; si el anterior era Contado (o no tenía) y
 * ahora hay plazo, aplica la regla de circuitForTerm. Un circuito de crédito
 * ya elegido (ASR, Santa Rosa, propia) se respeta mientras haya plazo.
 */
export function inheritCircuit(upstream: string | null | undefined, days: number): CircuitCode {
  if (days <= 0) return "CONTADO";
  if (isCircuitCode(upstream) && upstream !== "CONTADO") return upstream;
  return circuitForTerm(days);
}

/**
 * Corte de Compaq: todo saldo abierto importado entra al Circuito ASR, sin
 * mirar el plazo (decisión 4, 5-sep-2026). Es el circuito con el que se
 * operó todo lo que viene de Compaq.
 */
export const CUTOVER_CIRCUIT: CircuitCode = "ASR";
