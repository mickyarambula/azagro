import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSql, type Sql } from "@/lib/db";
import { authMiddleware } from "@/lib/auth/middleware";
import { assertAdmin } from "@/lib/erp/acl";
import { writeAudit } from "@/lib/erp/audit";
import { nearestRate } from "@/lib/erp/credit";
import type { FinancingBase } from "@/lib/erp/pricing";
import { dateDMY } from "@/lib/utils";

/**
 * Catálogo de circuitos de financiamiento (PASO 0, 5-sep-2026). Ver
 * DISENO_FINANCIAMIENTO.md, ESTADO.md, DECISIONES.md.
 *
 * Cada pedido va a declarar por dónde corre su financiamiento: quién pone el
 * capital, quién le factura al cliente, sobre qué base corre el
 * financiamiento y qué comisión de apertura cobra. Hasta el paso 3 esos datos
 * eran una sola fila de Ajustes (`company_settings.asr_commission`, ya
 * tirada por la 0026), como si todo corriera por un solo circuito. No es así: el
 * circuito de doble facturación (ASR) sigue vigente y es distinto del
 * circuito lineal (Línea Santa Rosa) que se va a construir.
 *
 * Esta fase SOLO expone el catálogo para leerlo. Nada en el precio, la mora
 * ni los reportes lo consulta todavía — eso es el paso 3.
 *
 * PASO 1 (etiqueta): cada documento guarda `circuit_code`, lo hereda por la
 * cadena y lo muestra. PASO 2: selector (solo administrador). PASO 3: el
 * motor RECIBE la comisión y la base del circuito (`circuitTerms`) y la tasa
 * que entra al precio (`priceRateFor`): TIIE de la tabla en ASR, tasa de
 * cobro de `funding_rates` en el lineal. pricing.ts, margins.ts y ladder.ts
 * siguen sin leer la base: reciben los números por parámetro.
 */

export type CircuitCode = "CONTADO" | "ASR" | "SANTA_ROSA" | "PROPIA";

/** Los cuatro códigos, en el orden fijo del catálogo (migración 0024). */
export const CIRCUIT_CODES: CircuitCode[] = ["CONTADO", "ASR", "SANTA_ROSA", "PROPIA"];

/**
 * Los únicos dos elegibles en el selector hoy (paso 2, 5-sep-2026): Línea
 * Santa Rosa y Línea propia existen en el catálogo pero están por construir
 * — aparecen en la lista, apagados. `assertSelectableCircuit` es la misma
 * regla del lado del servidor: nunca se guarda un circuito no elegible
 * aunque alguien salte la pantalla.
 */
export const SELECTABLE_CIRCUITS: CircuitCode[] = ["CONTADO", "ASR"];

export function isSelectableCircuit(code: unknown): code is "CONTADO" | "ASR" {
  return code === "CONTADO" || code === "ASR";
}

export type CreditCircuit = {
  code: CircuitCode;
  name: string;
  /**
   * Comisión de apertura. En un circuito que financia, null = SIN CAPTURAR
   * (el motor se detiene); "no cobra" se escribe como 0 (Línea Santa Rosa,
   * Decisión 6, migración 0026). En Contado no aplica.
   */
  commissionRate: number | null;
  /** 'costo_comision' | 'costo_margen' | null (no financia, o sin construir). */
  financingBase: FinancingBase | null;
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
    return readCircuits(sql, companyId);
  });

/** El catálogo de la empresa, tal cual (lectura tolerante: no se detiene por nada). */
export async function readCircuits(sql: Sql, companyId: number): Promise<CreditCircuit[]> {
  {
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
  }
}

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
export function circuitForTerm(days: number): "CONTADO" | "ASR" {
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

// ---------------------------------------------------------------------------
// PASO 3 — lo que el motor recibe del circuito, y la tabla de tasas.
// ---------------------------------------------------------------------------

/**
 * Qué circuito FINANCIA un documento: el suyo si es de crédito; si es Contado
 * (o no tiene), el que la regla propone para crédito (`circuitForTerm`). Sirve
 * para congelar la comisión también en una cotización de contado: si después
 * le cambian el plazo, se reprecia con la comisión que tenía congelada, no con
 * la de Ajustes de ese día.
 */
export function financingCircuit(code: string | null | undefined): CircuitCode {
  return isCircuitCode(code) && code !== "CONTADO" ? code : circuitForTerm(1);
}

/** Los tres números del circuito que el motor recibe por parámetro. */
export type CircuitTerms = {
  code: CircuitCode;
  name: string;
  commissionRate: number;
  financingBase: FinancingBase;
};

/**
 * Comisión y base del circuito que financia, leídas del catálogo. Se detiene
 * si el circuito no financia, está por construir, o no tiene comisión
 * capturada (nunca se inventa un 0 ni un 1 %).
 */
export async function circuitTerms(sql: Sql, companyId: number, code: string | null | undefined): Promise<CircuitTerms> {
  const fin = financingCircuit(code);
  const rows = await sql<{ code: string; name: string; commission_rate: string | null; financing_base: string | null; enabled: boolean }>`
    select code, name, commission_rate::text, financing_base, enabled from credit_circuits
    where company_id = ${companyId} and code = ${fin}
  `;
  const c = rows[0];
  if (!c) throw new Error(`El circuito ${circuitLabel(fin)} no está en el catálogo (Ajustes → Circuitos de financiamiento).`);
  if (c.financing_base !== "costo_comision" && c.financing_base !== "costo_margen") {
    throw new Error(`${c.name}: circuito por construir, todavía no financia. Elige otro circuito.`);
  }
  if (c.commission_rate == null) {
    throw new Error(`${c.name}: sin comisión de apertura capturada. Captúrala en Ajustes → Circuitos de financiamiento antes de cotizar a crédito.`);
  }
  return { code: c.code as CircuitCode, name: c.name, commissionRate: Number(c.commission_rate), financingBase: c.financing_base };
}

export type FundingPick = { date: string; costRate: number; collectionRate: number };

/** Tabla de tasas de dos columnas, como números, ordenada por fecha. */
export async function fundingTableOf(sql: Sql, companyId: number): Promise<FundingPick[]> {
  const rows = await sql<{ date: string; cost_rate: string; collection_rate: string }>`
    select date::text, cost_rate::text, collection_rate::text from funding_rates where company_id = ${companyId} order by date
  `;
  return rows.map((r) => ({ date: r.date, costRate: Number(r.cost_rate), collectionRate: Number(r.collection_rate) }));
}

/** Renglón vigente de la tabla de tasas en una fecha (misma regla que la TIIE: el más reciente igual o anterior). */
export function nearestFunding(table: FundingPick[], asOf: string): FundingPick | null {
  const pick = nearestRate(table.map((r) => ({ date: r.date, rate: r.collectionRate })), asOf);
  return pick ? (table.find((r) => r.date === pick.date) ?? null) : null;
}

export function missingFundingMessage(asOf: string, what: string) {
  return `No hay tasa de costo / tasa de cobro en la tabla con fecha igual o anterior al ${dateDMY(asOf)} (${what}). Captúrala en Ajustes → Tabla de tasas antes de continuar.`;
}

/**
 * La tasa que entra al precio para un circuito en una fecha, con las dos
 * columnas del lineal para congelarlas:
 *   ASR    → TIIE de la tabla (`rate`); costRate/collectionRate nulos.
 *   lineal → tasa de cobro (`rate` = collectionRate) y tasa de costo.
 * null si la tabla no cubre la fecha: el llamador decide cómo detenerse.
 */
export type PriceRate = { rate: number; date: string; costRate: number | null; collectionRate: number | null; source: "tiie" | "tasas" };

export async function priceRateFor(sql: Sql, companyId: number, terms: CircuitTerms, asOf: string): Promise<PriceRate | null> {
  if (terms.financingBase === "costo_margen") {
    const pick = nearestFunding(await fundingTableOf(sql, companyId), asOf);
    return pick ? { rate: pick.collectionRate, date: pick.date, costRate: pick.costRate, collectionRate: pick.collectionRate, source: "tasas" } : null;
  }
  const rows = await sql<{ date: string; rate: string }>`
    select date::text, rate::text from tiie_rates where company_id = ${companyId} order by date
  `;
  const pick = nearestRate(rows.map((r) => ({ date: r.date, rate: Number(r.rate) })), asOf);
  return pick ? { rate: pick.rate, date: pick.date, costRate: null, collectionRate: null, source: "tiie" } : null;
}

/** Mensaje de "no hay tasa" según de qué tabla la esperaba el circuito. */
export function missingPriceRateMessage(terms: CircuitTerms, asOf: string, what: string) {
  return terms.financingBase === "costo_margen" ? missingFundingMessage(asOf, what) : missingTiieMessage(asOf, what);
}

// Mismo texto que credit.ts (missingRateMessage), sin importarlo en el tipo:
// se repite aquí para que el mensaje del lineal y el de ASR vivan juntos.
function missingTiieMessage(asOf: string, what: string) {
  return `No hay TIIE en la tabla con fecha igual o anterior al ${dateDMY(asOf)} (${what}). Captúrala en Ajustes → Tabla TIIE antes de continuar.`;
}

/**
 * Captura de un renglón de la tabla de tasas (paso 3). Dos columnas por
 * fecha; la pantalla precarga la de cobro igual a la de costo y el dueño la
 * sube si quiere. Solo administrador, con bitácora anterior → nuevo.
 */
export const saveFundingRate = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ date: z.string(), costRate: z.number().positive(), collectionRate: z.number().positive() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    await assertAdmin(sql, context.userId);
    if (data.collectionRate + 1e-9 < data.costRate) {
      throw new Error("La tasa de cobro no puede ser menor que la tasa de costo: la protección es la diferencia y no puede ser negativa.");
    }
    const prev = await sql<{ cost_rate: string; collection_rate: string }>`
      select cost_rate::text, collection_rate::text from funding_rates where company_id = ${companyId} and date = ${data.date}
    `;
    await sql`
      insert into funding_rates (company_id, date, cost_rate, collection_rate)
      values (${companyId}, ${data.date}, ${data.costRate}, ${data.collectionRate})
      on conflict (company_id, date) do update set cost_rate = excluded.cost_rate, collection_rate = excluded.collection_rate
    `;
    const antes = prev[0] ? `costo ${Number(prev[0].cost_rate)} / cobro ${Number(prev[0].collection_rate)}` : "sin valor";
    await writeAudit(sql, {
      companyId,
      userId: context.userId,
      action: "tasas",
      entity: "settings",
      name: data.date,
      detail: `${antes} → costo ${data.costRate} / cobro ${data.collectionRate}`,
    });
    return { ok: true };
  });

/**
 * Captura de la comisión de apertura de un circuito (paso 3): "Comisión ASR"
 * salió de Ajustes y este es el único lugar donde vive. Solo administrador,
 * con bitácora. Solo circuitos que financian con comisión (hoy, el ASR).
 */
export const saveCircuitCommission = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ code: z.enum(["ASR", "PROPIA"]), commissionRate: z.number().nonnegative() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    await assertAdmin(sql, context.userId);
    const prev = await sql<{ name: string; commission_rate: string | null }>`
      select name, commission_rate::text from credit_circuits where company_id = ${companyId} and code = ${data.code}
    `;
    if (!prev[0]) throw new Error("El circuito no está en el catálogo.");
    await sql`
      update credit_circuits set commission_rate = ${data.commissionRate} where company_id = ${companyId} and code = ${data.code}
    `;
    await writeAudit(sql, {
      companyId,
      userId: context.userId,
      action: "circuito",
      entity: "settings",
      name: data.code,
      detail: `${prev[0].name}: comisión de apertura ${prev[0].commission_rate == null ? "sin capturar" : Number(prev[0].commission_rate)} → ${data.commissionRate}`,
    });
    return { ok: true };
  });
