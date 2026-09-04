import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql, withTx } from "@/lib/db";
import { addDays, chargeRates, chargesCaptured, computeMora, computeStatementLine, daysBetween, earlyPayBonus, explainInterest, fxDifferential, fxPaymentSplit, missingChargesMessage, missingRateMessage, moraBilling, nearestRate, pctRate, rateLabel, requireRate, splitDocName, splitFegaBundle, validateDueDates } from "@/lib/erp/credit";
import { computeDues } from "@/lib/erp/order-terms";
import { activeMember, assertAdmin, assertCan, canSeeCosts, canSeeMargins } from "@/lib/erp/acl";
import { writeAudit } from "@/lib/erp/audit";
import { dateDMY, todayMx } from "@/lib/utils";
import { rememberTrade } from "@/lib/erp/links";
import { financeBase, financeUnit } from "@/lib/erp/pricing";
import { formatTerms, ladderFor, parseTerms } from "@/lib/erp/ladder";
import { marginFromPrice, marginOf, marginText, OFFER_LABEL, type Offer } from "@/lib/erp/margins";
import { assertCostForCredit, ensureRefCost, productCosts, resolveCost } from "@/lib/erp/cost";
import { ensureInvoiceExtras, refreshInvoiceResidual } from "@/lib/erp/stock";

type Sql = Awaited<ReturnType<typeof getSql>>;

async function companyOf(sql: Sql, userId: string) {
  const rows = await sql<{ company_id: number }>`
    select company_id from members where user_id = ${userId} and status = 'active' limit 1
  `;
  if (!rows[0]) throw new Error("Sin empresa");
  return rows[0].company_id;
}

/**
 * Columnas de la migración 0017 (dos precios / dos márgenes / oferta
 * aceptada) para bases que vienen de antes. Nulo = no capturado; no se
 * rellena nada aquí.
 */
async function ensureTwoPrices(sql: Sql) {
  for (const col of ["cash", "credit"]) {
    await sql.query(`alter table quote_lines add column if not exists margin_${col}_mode text`);
    await sql.query(`alter table quote_lines add column if not exists margin_${col}_pct numeric(8,4)`);
    await sql.query(`alter table quote_lines add column if not exists margin_${col}_nominal numeric(14,4)`);
    await sql.query(`alter table quote_lines add column if not exists margin_${col}_source text`);
  }
  await sql`alter table quote_lines add column if not exists finance_unit numeric(14,4)`;
  await sql`alter table quotes add column if not exists accepted_offer text`;
  await sql`alter table sales_orders add column if not exists accepted_offer text`;
}

/**
 * Parámetros de negocio de Ajustes (company_settings). Cada uno se lee tal
 * cual de la base: si falta (renglón inexistente o columna en nulo) NO se
 * rellena con nada — `missing` lo dice y policy() se detiene.
 */
export const POLICY_FIELDS = [
  ["creditDays", "plazo financiero (días)"],
  ["invoiceDays", "plazo de factura (días)"],
  ["fegaRate", "comisión + FEGA"],
  ["fegaCommission", "comisión dentro de «comisión + FEGA»"],
  ["collectionSpread", "spread de cobro (mora)"],
  ["asrCommission", "comisión ASR"],
  ["asrSpread", "spread ASR"],
  ["earlyPayDays", "umbral de pronto pago (días)"],
] as const;
export type PolicyField = (typeof POLICY_FIELDS)[number][0];

export type PolicyNumbers = Record<PolicyField, number>;

export type PolicyRead = {
  values: Record<PolicyField, number | null>;
  missing: string[];
  /** Escalera de plazos de la cotización interna (días; 0 = contado). Nulo = sin capturar. */
  quoteTerms: number[] | null;
  legalName: string;
  rfc: string;
  emailFrom: string;
  phone: string;
  alertDaysCxc: number;
  alertDaysCxp: number;
  alertEmail: string;
  alertEmailOn: boolean;
  mailReady: boolean;
};

export type Policy = PolicyNumbers & Omit<PolicyRead, "values" | "missing" | "quoteTerms"> & {
  /** Comisión del estado de cuenta (la que va dentro de «comisión + FEGA»). */
  commissionRate: number;
  /** Escalera de plazos (Ajustes), ya validada: al menos un plazo. */
  quoteTerms: number[];
};

async function ensureSettingsColumns(sql: Sql) {
  // Alertas y correo no son números de negocio: sí tienen omisión.
  await sql`alter table company_settings add column if not exists alert_days_cxc integer not null default 7`;
  await sql`alter table company_settings add column if not exists alert_days_cxp integer not null default 7`;
  await sql`alter table company_settings add column if not exists alert_email text not null default ''`;
  await sql`alter table company_settings add column if not exists alert_email_on boolean not null default true`;
  await sql`alter table company_settings add column if not exists resend_key text not null default ''`;
  // Parámetros de negocio: sin default, sin NOT NULL (migración 0019). Vacío = sin capturar.
  await sql`alter table company_settings add column if not exists early_pay_days integer`;
  await sql`alter table company_settings add column if not exists fega_commission numeric(8,4)`;
  // Escalera de plazos de la cotización interna (migración 0020 la siembra).
  await sql`alter table company_settings add column if not exists quote_terms text`;
  // El "spread de línea" ya no existe: el financiamiento del precio usa
  // comisión ASR + spread ASR. Se quita la columna para que no quede un
  // porcentaje viejo dormido en la base.
  await sql`alter table company_settings drop column if exists finance_spread`;
}

/** Lectura tolerante: devuelve lo que hay y la lista de lo que falta. Solo para la pantalla de Ajustes. */
export async function readPolicy(sql: Sql, companyId: number): Promise<PolicyRead> {
  await ensureSettingsColumns(sql);
  const rows = await sql<{
    credit_days: number | null;
    invoice_days: number | null;
    fega_rate: string | null;
    fega_commission: string | null;
    collection_spread: string | null;
    legal_name: string;
    rfc: string;
    asr_commission: string | null;
    asr_spread: string | null;
    email_from: string;
    phone: string;
    alert_days_cxc: number;
    alert_days_cxp: number;
    alert_email: string;
    alert_email_on: boolean;
    resend_key: string;
    early_pay_days: number | null;
    quote_terms: string | null;
  }>`
    select credit_days, invoice_days, fega_rate::text, fega_commission::text, collection_spread::text,
      legal_name, rfc, asr_commission::text, asr_spread::text, email_from, phone,
      coalesce(alert_days_cxc,7)::int as alert_days_cxc, coalesce(alert_days_cxp,7)::int as alert_days_cxp,
      coalesce(alert_email,'') as alert_email, coalesce(alert_email_on,true) as alert_email_on,
      coalesce(resend_key,'') as resend_key,
      early_pay_days, quote_terms
    from company_settings where company_id = ${companyId}
  `;
  const r = rows[0];
  const num = (v: string | number | null | undefined) => (v == null || v === "" ? null : Number(v));
  const values: Record<PolicyField, number | null> = {
    creditDays: num(r?.credit_days),
    invoiceDays: num(r?.invoice_days),
    fegaRate: num(r?.fega_rate),
    fegaCommission: num(r?.fega_commission),
    collectionSpread: num(r?.collection_spread),
    asrCommission: num(r?.asr_commission),
    asrSpread: num(r?.asr_spread),
    earlyPayDays: num(r?.early_pay_days),
  };
  const missing: string[] = POLICY_FIELDS.filter(([k]) => values[k] == null).map(([, label]) => label);
  const quoteTerms = parseTerms(r?.quote_terms);
  if (!quoteTerms?.length) missing.push(QUOTE_TERMS_LABEL);
  return {
    values,
    missing,
    quoteTerms,
    legalName: r?.legal_name ?? "",
    rfc: r?.rfc ?? "",
    emailFrom: r?.email_from ?? "",
    phone: r?.phone ?? "",
    alertDaysCxc: r?.alert_days_cxc ?? 7,
    alertDaysCxp: r?.alert_days_cxp ?? 7,
    alertEmail: r?.alert_email ?? "",
    alertEmailOn: r?.alert_email_on ?? true,
    mailReady: Boolean(process.env.RESEND_API_KEY) || (r?.resend_key || "").length > 8,
  };
}

/** Etiqueta de la escalera en "Ajustes incompletos: falta …". */
export const QUOTE_TERMS_LABEL = "escalera de plazos (días)";

export function missingPolicyMessage(missing: string[]) {
  return `Ajustes incompletos: falta ${missing.join(", ")}. Captúralo en Ajustes → Política de crédito antes de operar.`;
}

/**
 * Parámetros de negocio para operar. Si falta cualquiera, se detiene con
 * mensaje visible: la base está incompleta y no se opera con números del
 * código. (Regla del dueño: nunca inventar un número.)
 */
export async function policy(sql: Sql, companyId: number): Promise<Policy> {
  const p = await readPolicy(sql, companyId);
  if (p.missing.length) throw new Error(missingPolicyMessage(p.missing));
  const v = p.values as PolicyNumbers;
  const { values: _values, missing: _missing, quoteTerms, ...rest } = p;
  return { ...rest, ...v, commissionRate: v.fegaCommission, quoteTerms: quoteTerms ?? [] };
}

/**
 * Políticas de cobro de la empresa con sus dos interruptores: cobra comisión
 * sí/no, cobra FEGA sí/no. Nulo = sin capturar (nacen así, migración 0021):
 * quien la use se detiene y avisa, nunca decide por su cuenta.
 */
export type CreditPolicyRow = { code: string; name: string; commission: boolean | null; fega: boolean | null };

async function ensurePolicySwitches(sql: Sql) {
  await sql`alter table credit_policies add column if not exists charge_commission boolean`;
  await sql`alter table credit_policies add column if not exists charge_fega boolean`;
}

export async function creditPolicies(sql: Sql, companyId: number): Promise<CreditPolicyRow[]> {
  await ensurePolicySwitches(sql);
  const rows = await sql<{ code: string; name: string; charge_commission: boolean | null; charge_fega: boolean | null }>`
    select code, name, charge_commission, charge_fega
    from credit_policies where company_id = ${companyId} order by code
  `;
  return rows.map((r) => ({ code: r.code, name: r.name, commission: r.charge_commission, fega: r.charge_fega }));
}

/** Mapa código → política, para resolver documento por documento. */
export async function creditPolicyMap(sql: Sql, companyId: number) {
  const list = await creditPolicies(sql, companyId);
  return new Map(list.map((p) => [p.code, p]));
}

/** Tabla TIIE completa, como números (para nearestRate / requireRate). */
async function tiieTableOf(sql: Sql, cid: number) {
  const rows = await sql<{ date: string; rate: string }>`
    select date::text, rate::text from tiie_rates where company_id = ${cid} order by date
  `;
  return rows.map((r) => ({ date: r.date, rate: Number(r.rate) }));
}

async function rateTables(sql: Sql, cid: number) {
  const tiie = await sql<{ date: string; rate: string }>`
    select date::text, rate::text from tiie_rates where company_id = ${cid} order by date desc limit 24
  `;
  const fx = await sql<{ date: string; usd_mxn: string }>`
    select date::text, usd_mxn::text from fx_rates where company_id = ${cid} order by date desc limit 24
  `;
  return { tiie, fx };
}

/** Ajustes completos para operar (cotizar, cobrar, estado de cuenta). Se detiene si falta algo. */
export const getSettings = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    const p = await policy(sql, cid);
    const { tiie, fx } = await rateTables(sql, cid);
    // Las políticas de cobro van aquí para que la vista previa de la mora (al
    // registrar un cobro) use los interruptores del documento y no los de la
    // empresa: comisión y FEGA se negocian por cliente.
    const policies = await creditPolicies(sql, cid);
    return { ...p, tiie, fx, policies };
  });

/** Solo para la pantalla de Ajustes: lo que hay (nulo = sin capturar) y lo que falta. */
export const getSettingsForm = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    const p = await readPolicy(sql, cid);
    const { tiie, fx } = await rateTables(sql, cid);
    return { ...p, tiie, fx };
  });

export const saveSettings = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      legalName: z.string(),
      rfc: z.string(),
      // Todos los números de negocio son obligatorios: aquí es donde se
      // capturan; no hay respaldo en el código si faltan.
      creditDays: z.number().int().positive(),
      invoiceDays: z.number().int().positive(),
      fegaRate: z.number().nonnegative(),
      fegaCommission: z.number().nonnegative(),
      collectionSpread: z.number().nonnegative(),
      asrCommission: z.number().nonnegative(),
      asrSpread: z.number().nonnegative(),
      emailFrom: z.string(),
      phone: z.string(),
      alertDaysCxc: z.number().int().min(0).max(120).optional(),
      alertDaysCxp: z.number().int().min(0).max(120).optional(),
      alertEmail: z.string().optional(),
      alertEmailOn: z.boolean().optional(),
      resendKey: z.string().optional(),
      earlyPayDays: z.number().int().min(0).max(365),
      // Escalera de plazos de la cotización: días separados por coma (0 = contado).
      quoteTerms: z.string(),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    // Los parámetros de cartera mueven intereses y utilidad: solo administrador.
    await assertAdmin(sql, context.userId);
    if (data.fegaCommission > data.fegaRate + 1e-9) {
      throw new Error("La comisión dentro de «comisión + FEGA» no puede ser mayor que el total comisión + FEGA.");
    }
    const terms = parseTerms(data.quoteTerms);
    if (!terms?.length) {
      throw new Error("Escalera de plazos: escribe los días separados por coma (0 = contado). Sin escalera no se cotiza.");
    }
    const termsText = formatTerms(terms);
    // Lectura tolerante: se puede estar capturando por primera vez.
    const before = await readPolicy(sql, cid);
    await sql`
      insert into company_settings (
        company_id, legal_name, rfc, credit_days, invoice_days, fega_rate, fega_commission,
        collection_spread, asr_commission, asr_spread, email_from, phone,
        alert_days_cxc, alert_days_cxp, alert_email, alert_email_on, early_pay_days, quote_terms
      )
      values (
        ${cid}, ${data.legalName}, ${data.rfc}, ${data.creditDays}, ${data.invoiceDays}, ${data.fegaRate}, ${data.fegaCommission},
        ${data.collectionSpread}, ${data.asrCommission}, ${data.asrSpread},
        ${data.emailFrom}, ${data.phone}, ${data.alertDaysCxc ?? 7}, ${data.alertDaysCxp ?? 7},
        ${data.alertEmail ?? ""}, ${data.alertEmailOn ?? true}, ${data.earlyPayDays}, ${termsText}
      )
      on conflict (company_id) do update set
        legal_name = excluded.legal_name,
        rfc = excluded.rfc,
        credit_days = excluded.credit_days,
        invoice_days = excluded.invoice_days,
        fega_rate = excluded.fega_rate,
        fega_commission = excluded.fega_commission,
        collection_spread = excluded.collection_spread,
        asr_commission = excluded.asr_commission,
        asr_spread = excluded.asr_spread,
        email_from = excluded.email_from,
        phone = excluded.phone,
        alert_days_cxc = excluded.alert_days_cxc,
        alert_days_cxp = excluded.alert_days_cxp,
        alert_email = excluded.alert_email,
        alert_email_on = excluded.alert_email_on,
        early_pay_days = excluded.early_pay_days,
        quote_terms = excluded.quote_terms
    `;
    const key = (data.resendKey || "").trim();
    if (key.length > 8) {
      await sql`update company_settings set resend_key = ${key} where company_id = ${cid}`;
    }
    // Bitácora de los parámetros financieros: valor anterior → nuevo ("sin capturar" si no había).
    const b = before.values;
    const watch: Array<[string, number | null, number]> = [
      ["spread cobro", b.collectionSpread, data.collectionSpread],
      ["spread ASR", b.asrSpread, data.asrSpread],
      ["comisión ASR", b.asrCommission, data.asrCommission],
      ["comisión + FEGA", b.fegaRate, data.fegaRate],
      ["comisión dentro de FEGA", b.fegaCommission, data.fegaCommission],
      ["plazo factura", b.invoiceDays, data.invoiceDays],
      ["plazo financiero", b.creditDays, data.creditDays],
      ["umbral pronto pago", b.earlyPayDays, data.earlyPayDays],
    ];
    const changes = watch.filter(([, a, c]) => a !== c).map(([n, a, c]) => `${n} ${a ?? "sin capturar"} → ${c}`);
    const antesTerms = before.quoteTerms ? formatTerms(before.quoteTerms) : null;
    if (antesTerms !== termsText) changes.push(`escalera de plazos ${antesTerms ?? "sin capturar"} → ${termsText}`);
    if (changes.length) {
      await writeAudit(sql, {
        companyId: cid,
        userId: context.userId,
        action: "parametros",
        entity: "settings",
        detail: changes.join(" · "),
      });
    }
    return { ok: true };
  });

/** Políticas de cobro con sus interruptores (para Ajustes y para el pedido). */
export const listCreditPolicies = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    return creditPolicies(sql, cid);
  });

/**
 * Cobra comisión sí/no y cobra FEGA sí/no de una política. Mueve dinero de
 * toda la cartera que use esa política: solo administrador, y cada cambio
 * queda en bitácora con el valor anterior y el nuevo.
 */
export const saveCreditPolicy = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ code: z.string().min(1), commission: z.boolean(), fega: z.boolean() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    await assertAdmin(sql, context.userId);
    await ensurePolicySwitches(sql);
    const before = await sql<{ name: string; charge_commission: boolean | null; charge_fega: boolean | null }>`
      select name, charge_commission, charge_fega from credit_policies
      where company_id = ${cid} and code = ${data.code}
    `;
    if (!before[0]) throw new Error(`No existe la política de cobro «${data.code}».`);
    await sql`
      update credit_policies set charge_commission = ${data.commission}, charge_fega = ${data.fega}
      where company_id = ${cid} and code = ${data.code}
    `;
    const dime = (v: boolean | null) => (v == null ? "sin capturar" : v ? "sí" : "no");
    const cambios = [
      before[0].charge_commission !== data.commission ? `comisión ${dime(before[0].charge_commission)} → ${dime(data.commission)}` : null,
      before[0].charge_fega !== data.fega ? `FEGA ${dime(before[0].charge_fega)} → ${dime(data.fega)}` : null,
    ].filter(Boolean);
    if (cambios.length) {
      await writeAudit(sql, {
        companyId: cid,
        userId: context.userId,
        action: "politica-cobro",
        entity: "settings",
        name: data.code,
        detail: `${before[0].name}: ${cambios.join(" · ")}`,
      });
    }
    return { ok: true };
  });

export const saveTiie = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ date: z.string(), rate: z.number().positive() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    // La TIIE mueve el interés de toda la cartera: solo administrador, con bitácora.
    await assertAdmin(sql, context.userId);
    const prev = await sql<{ rate: string }>`
      select rate::text from tiie_rates where company_id = ${cid} and date = ${data.date}
    `;
    await sql`
      insert into tiie_rates (company_id, date, rate)
      values (${cid}, ${data.date}, ${data.rate})
      on conflict (company_id, date) do update set rate = excluded.rate
    `;
    await writeAudit(sql, {
      companyId: cid,
      userId: context.userId,
      action: "tiie",
      entity: "settings",
      name: data.date,
      detail: `${prev[0] ? `${Number(prev[0].rate)}` : "sin valor"} → ${data.rate}`,
    });
    return { ok: true };
  });

export const saveFx = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ date: z.string(), usdMxn: z.number().positive() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    await assertAdmin(sql, context.userId);
    const prev = await sql<{ usd_mxn: string }>`
      select usd_mxn::text from fx_rates where company_id = ${cid} and date = ${data.date}
    `;
    await sql`
      insert into fx_rates (company_id, date, usd_mxn)
      values (${cid}, ${data.date}, ${data.usdMxn})
      on conflict (company_id, date) do update set usd_mxn = excluded.usd_mxn
    `;
    await writeAudit(sql, {
      companyId: cid,
      userId: context.userId,
      action: "tipo-cambio",
      entity: "settings",
      name: data.date,
      detail: `${prev[0] ? `${Number(prev[0].usd_mxn)}` : "sin valor"} → ${data.usdMxn}`,
    });
    return { ok: true };
  });

export const listContacts = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ partnerId: z.number() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    await assertCan(sql, context.userId, "partners", "view");
    return sql<{
      id: number;
      name: string;
      role: string;
      email: string;
      phone: string;
      is_billing: boolean;
    }>`
      select id, name, role, email, phone, is_billing
      from partner_contacts
      where company_id = ${cid} and partner_id = ${data.partnerId}
      order by is_billing desc, id
    `;
  });

export const saveContact = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      id: z.number().optional(),
      partnerId: z.number(),
      name: z.string().min(1),
      role: z.string().optional().default(""),
      email: z.string().optional().default(""),
      phone: z.string().optional().default(""),
      isBilling: z.boolean().optional().default(false),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    await assertCan(sql, context.userId, "partners", "edit");
    if (data.id) {
      await sql`
        update partner_contacts set name=${data.name}, role=${data.role ?? ""}, email=${data.email ?? ""},
          phone=${data.phone ?? ""}, is_billing=${data.isBilling ?? false}
        where id = ${data.id} and company_id = ${cid}
      `;
      return { id: data.id };
    }
    const row = await sql<{ id: number }>`
      insert into partner_contacts (company_id, partner_id, name, role, email, phone, is_billing)
      values (${cid}, ${data.partnerId}, ${data.name}, ${data.role ?? ""}, ${data.email ?? ""}, ${data.phone ?? ""}, ${data.isBilling ?? false})
      returning id
    `;
    return { id: row[0]!.id };
  });

export const listQuotes = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    const me = await activeMember(sql, context.userId);
    if (me.acl.quotes === "none") throw new Error("Sin permiso para ver este módulo");
    await sql`alter table quote_lines add column if not exists uom text not null default ''`;
    await sql`alter table quotes add column if not exists price_offer text not null default 'both'`;
    await sql`alter table quotes add column if not exists revision integer not null default 1`;
    await sql`alter table quote_lines add column if not exists cash_price numeric(14,4) not null default 0`;
    await sql`alter table quote_lines add column if not exists credit_price numeric(14,4) not null default 0`;
    await sql`alter table quote_lines add column if not exists cost numeric(14,4) not null default 0`;
    await sql`alter table quote_lines add column if not exists freight numeric(14,4) not null default 0`;
    await ensureTwoPrices(sql);
    const quotes = await sql<{
      id: number;
      name: string;
      partner_id: number;
      partner: string;
      date: string;
      valid_until: string;
      currency: string;
      fx_rate: string;
      state: string;
      total: string;
      credit_days: number;
      notes: string;
      delivery_to: string;
      price_offer: string;
      revision: number;
      tiie: string;
      spread: string;
      accepted_offer: string | null;
      request_name: string | null;
      order_name: string | null;
      order_id: number | null;
      order_state: string | null;
    }>`
      select q.id, q.name, q.partner_id, p.name as partner, q.date::text, q.valid_until::text,
        q.currency, q.fx_rate::text, q.state, q.total::text, q.notes, q.delivery_to,
        coalesce(q.credit_days,0) as credit_days,
        coalesce(q.price_offer,'both') as price_offer,
        coalesce(q.revision,1) as revision,
        coalesce(q.tiie,0)::text as tiie,
        coalesce(q.spread,0)::text as spread,
        q.accepted_offer,
        (select name from customer_requests r where r.quote_id = q.id limit 1) as request_name,
        (select name from sales_orders so where so.quote_id = q.id order by so.id desc limit 1) as order_name,
        (select id from sales_orders so where so.quote_id = q.id order by so.id desc limit 1) as order_id,
        (select state from sales_orders so where so.quote_id = q.id order by so.id desc limit 1) as order_state
      from quotes q join partners p on p.id = q.partner_id
      where q.company_id = ${cid}
      order by q.id desc
    `;
    const lines = await sql<{
      id: number;
      quote_id: number;
      product_id: number;
      product: string;
      qty: string;
      unit_price: string;
      cash_price: string;
      credit_price: string;
      uom: string;
      on_hand: string;
      on_hand_own: string;
      on_hand_supplier: string;
      cost: string;
      ref_cost: string;
      freight: string;
      margin_cash_mode: string | null;
      margin_cash_pct: string | null;
      margin_cash_nominal: string | null;
      margin_credit_mode: string | null;
      margin_credit_pct: string | null;
      margin_credit_nominal: string | null;
      finance_unit: string | null;
      q_tiie: string;
      q_spread: string;
      q_days: number;
    }>`
      select ql.id, ql.quote_id, ql.product_id, (pr.code || ' — ' || pr.name) as product, ql.qty::text, ql.unit_price::text,
        coalesce(nullif(ql.cash_price,0), ql.unit_price)::text as cash_price,
        coalesce(nullif(ql.credit_price,0), ql.unit_price)::text as credit_price,
        coalesce(ql.uom, pr.uom) as uom,
        coalesce((select sum(quantity) from stock_quants q where q.product_id = pr.id),0)::text as on_hand,
        coalesce((select sum(q.quantity) from stock_quants q join locations l on l.id = q.location_id where q.product_id = pr.id and l.loc_type = 'internal'),0)::text as on_hand_own,
        coalesce((select sum(q.quantity) from stock_quants q join locations l on l.id = q.location_id where q.product_id = pr.id and l.loc_type = 'supplier'),0)::text as on_hand_supplier,
        coalesce(nullif(ql.cost,0), pr.cost)::text as cost,
        coalesce(pr.ref_cost,0)::text as ref_cost,
        coalesce(ql.freight,0)::text as freight,
        ql.margin_cash_mode, ql.margin_cash_pct::text as margin_cash_pct, ql.margin_cash_nominal::text as margin_cash_nominal,
        ql.margin_credit_mode, ql.margin_credit_pct::text as margin_credit_pct, ql.margin_credit_nominal::text as margin_credit_nominal,
        ql.finance_unit::text as finance_unit,
        coalesce(q.tiie,0)::text as q_tiie, coalesce(q.spread,0)::text as q_spread, coalesce(q.credit_days,0)::int as q_days
      from quote_lines ql
      join products pr on pr.id = ql.product_id
      join quotes q on q.id = ql.quote_id
      where q.company_id = ${cid}
    `;
    const customers = await sql<{ id: number; name: string; email: string; phone: string }>`
      select id, name, coalesce(email,'') as email, coalesce(phone,'') as phone
      from partners where company_id = ${cid} and is_customer = true order by name
    `;
    // Costo del producto: promedio móvil del kardex y, si no hay, el de
    // referencia (orden único en resolveCost). Es la base del financiamiento
    // de la cotización directa.
    await ensureRefCost(sql);
    const products = await sql<{ id: number; code: string; name: string; list_price: string; uom: string; cost: string; ref_cost: string }>`
      select id, code, name, list_price::text, uom, coalesce(cost,0)::text as cost, coalesce(ref_cost,0)::text as ref_cost
      from products where company_id = ${cid} order by code
    `;
    // El financiamiento se calcula SIEMPRE sobre el costo real, para cualquier
    // rol: el precio no puede depender de quién cotiza. Lo que cambia con el
    // rol es lo que se muestra (costo y flete), no el cálculo. Por eso la
    // pantalla recibe la base del financiamiento y nunca el costo.
    const pol = await policy(sql, cid);
    // La TIIE sale de la tabla: el renglón vigente a hoy, con su fecha, para
    // que la pantalla diga cuál usó. Sin renglón no hay financiamiento y la
    // pantalla no deja cotizar a crédito.
    const tiieToday = nearestRate(await tiieTableOf(sql, cid), todayMx());
    const baseOf = (row: { cost: string; ref_cost: string }) => {
      const { cost, source } = resolveCost({ avgCost: row.cost, refCost: row.ref_cost });
      return {
        fin: tiieToday ? financeBase({ cost, tiie: tiieToday.rate, costSpread: pol.asrSpread, commissionRate: pol.asrCommission }) : null,
        // La pantalla necesita saber si hay costo para avisar antes de guardar.
        cost_source: source,
      };
    };
    const pricedProducts = products.map((p) => ({ ...p, ...baseOf(p) }));
    // Financiamiento por unidad que quedó DENTRO del precio a crédito. Las
    // cotizaciones nuevas lo traen guardado (finance_unit); las anteriores a
    // la migración 0017 no, y se deriva con las tasas y el costo con que se
    // cotizó (solo para mostrar, no se escribe).
    const finUnitOf = (l: (typeof lines)[number]) => {
      if (l.finance_unit != null) return { fin_unit: Number(l.finance_unit), fin_source: "guardado" as const };
      const landed = Number(l.cost) + Number(l.freight);
      return {
        fin_unit: financeUnit({ cost: landed, days: l.q_days, tiie: Number(l.q_tiie), costSpread: Number(l.q_spread), commissionRate: pol.asrCommission }),
        fin_source: "derivado" as const,
      };
    };
    // Escalera de plazos por partida (herramienta interna): una columna por
    // plazo de Ajustes más el acordado. Se calcula AQUÍ con el costo real y
    // las tasas con que se cotizó (TIIE/spread de la COT, comisión de Ajustes),
    // a partir del margen guardado: contado → margen contado; a plazo → margen
    // crédito. El precio de cada columna es igual para cualquier rol.
    const ladderOf = (l: (typeof lines)[number]) => {
      const landed = Number(l.cost) + Number(l.freight);
      const stored = finUnitOf(l).fin_unit;
      return {
        ladder: ladderFor({
          terms: pol.quoteTerms,
          agreed: l.q_days,
          landed,
          marginCash: marginOf(l, "cash"),
          marginCredit: marginOf(l, "credit"),
          financeAt: (days) =>
            days === l.q_days ? stored : financeUnit({ cost: landed, days, tiie: Number(l.q_tiie), costSpread: Number(l.q_spread), commissionRate: pol.asrCommission }),
        }),
      };
    };
    const linesWithBase = lines.map((l) => ({ ...l, ...baseOf(l), ...finUnitOf(l), ...ladderOf(l) }));
    // Los márgenes solo los ve quien puede ver márgenes (no es el mismo grupo que costos).
    const pricedLines = canSeeMargins(me.role)
      ? linesWithBase
      : linesWithBase.map((l) => ({
          ...l,
          margin_cash_pct: null,
          margin_cash_nominal: null,
          margin_credit_pct: null,
          margin_credit_nominal: null,
          // La escalera se queda con precio y financiamiento; utilidad y % son margen.
          ladder: l.ladder.map((s) => ({ ...s, utility: null, pct: null })),
        }));
    // El costo de compra y el flete no son para ventas: solo quien puede ver costos.
    if (!canSeeCosts(me.role)) {
      return {
        quotes,
        lines: pricedLines.map((l) => ({ ...l, cost: "0", ref_cost: "0", freight: "0" })),
        customers,
        products: pricedProducts.map((p) => ({ ...p, cost: "0", ref_cost: "0" })),
        tiieToday,
        terms: pol.quoteTerms,
      };
    }
    return { quotes, lines: pricedLines, customers, products: pricedProducts, tiieToday, terms: pol.quoteTerms };
  });

export const createQuote = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      partnerId: z.number(),
      currency: z.enum(["MXN", "USD"]),
      // 0 = "no hay": en USD se rechaza abajo con mensaje claro (nunca se
      // inventa un tipo de cambio).
      fxRate: z.number().nonnegative(),
      validUntil: z.string(),
      notes: z.string().optional().default(""),
      deliveryTo: z.string().optional().default(""),
      // TIIE y spread vienen de la tabla y de Ajustes (la pantalla los
      // muestra); a crédito son obligatorios y se verifica abajo.
      tiie: z.number().nonnegative(),
      spread: z.number().nonnegative(),
      creditDays: z.number().int().nonnegative(),
      priceOffer: z.enum(["cash", "credit", "both"]).optional().default("both"),
      send: z.boolean().optional().default(true),
      lines: z
        .array(
          z.object({
            productId: z.number(),
            qty: z.number().positive(),
            unitPrice: z.number().nonnegative(),
            cashPrice: z.number().optional(),
            creditPrice: z.number().optional(),
            uom: z.string().optional().default(""),
            cost: z.number().optional().default(0),
            freight: z.number().optional().default(0),
            other: z.number().optional().default(0),
            marginPct: z.number().optional().default(0),
          }),
        )
        .min(1),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    await assertCan(sql, context.userId, "quotes", "edit");
    const today = todayMx();
    if (data.validUntil < today) {
      throw new Error(`La vigencia ya venció (${data.validUntil}). Elige hoy o una fecha posterior.`);
    }
    // Un documento en dólares necesita un tipo de cambio real (de la tabla o
    // capturado); sin él no se guarda.
    if (data.currency === "USD" && !(data.fxRate > 0)) {
      throw new Error("Sin tipo de cambio: la tabla de tipo de cambio está vacía y no se capturó uno. Captúralo en Ajustes → Tipo de cambio antes de cotizar en dólares.");
    }
    // A crédito el precio lleva financiamiento; sin costo saldría en cero.
    // De contado (oferta solo contado o plazo 0) no hay nada que financiar.
    const plazo = (data.priceOffer ?? "both") === "cash" ? 0 : data.creditDays;
    // La TIIE la decide la tabla, no la pantalla: se toma el renglón vigente
    // hoy y se exige que sea el mismo con el que la pantalla calculó los
    // precios (si alguien capturó otro renglón entre abrir y guardar, se
    // vuelve a cargar en lugar de guardar precios con una TIIE distinta).
    let tiie = 0;
    if (plazo > 0) {
      const pick = requireRate(await tiieTableOf(sql, cid), today, "cotización a crédito");
      if (Math.abs(pick.rate - data.tiie) > 0.000001) {
        throw new Error(`La TIIE de la tabla cambió desde que abriste la pantalla (ahora ${rateLabel(pick)}). Vuelve a cargar y cotiza de nuevo.`);
      }
      tiie = pick.rate;
    }
    await assertCostForCredit(sql, cid, data.lines.map((l) => l.productId), plazo);
    await sql`alter table quotes add column if not exists owner_id text`;
    await sql`alter table quotes add column if not exists tiie numeric(8,6) not null default 0`;
    await sql`alter table quotes add column if not exists spread numeric(8,6) not null default 0`;
    await sql`alter table quotes add column if not exists credit_days integer not null default 0`;
    await sql`alter table quotes add column if not exists price_offer text not null default 'both'`;
    await sql`alter table quotes add column if not exists revision integer not null default 1`;
    await sql`alter table quote_lines add column if not exists cost numeric(14,4) not null default 0`;
    await sql`alter table quote_lines add column if not exists freight numeric(14,4) not null default 0`;
    await sql`alter table quote_lines add column if not exists other_cost numeric(14,4) not null default 0`;
    await sql`alter table quote_lines add column if not exists margin_pct numeric(8,4) not null default 0`;
    await sql`alter table quote_lines add column if not exists cash_price numeric(14,4) not null default 0`;
    await sql`alter table quote_lines add column if not exists credit_price numeric(14,4) not null default 0`;
    const n = await sql<{ c: number }>`select count(*)::int as c from quotes where company_id = ${cid}`;
    const name = `COT-${String((n[0]?.c ?? 0) + 1).padStart(4, "0")}`;
    const offer = data.priceOffer ?? "both";
    const priced = data.lines.map((l) => {
      const cash = l.cashPrice ?? (offer === "credit" ? 0 : l.unitPrice);
      const credit = l.creditPrice ?? (offer === "cash" ? 0 : l.unitPrice);
      const unit = offer === "cash" ? cash : credit || l.unitPrice;
      return { ...l, cash, credit, unit };
    });
    const total = priced.reduce((s, l) => s + l.qty * l.unit, 0);
    const state = data.send ? "sent" : "draft";
    const q = await sql<{ id: number }>`
      insert into quotes (company_id, name, partner_id, date, valid_until, currency, fx_rate, state, notes, delivery_to, total, owner_id, tiie, spread, credit_days, price_offer)
      values (${cid}, ${name}, ${data.partnerId}, ${today}, ${data.validUntil}, ${data.currency}, ${data.fxRate}, ${state},
        ${data.notes ?? ""}, ${data.deliveryTo ?? ""}, ${total}, ${context.userId}, ${tiie}, ${data.spread ?? 0}, ${data.creditDays ?? 0}, ${offer})
      returning id
    `;
    await sql`alter table quote_lines add column if not exists uom text not null default ''`;
    await ensureTwoPrices(sql);
    // Alta manual: el costo es el del producto (kardex o referencia, mismo orden
    // que la pantalla) y los dos márgenes se despejan de los precios capturados
    // (contado sin financiamiento; crédito restando el financiamiento que va
    // dentro del precio con las tasas de esta cotización). Se guardan en modo
    // $ fijo: la pantalla armó el crédito como contado + financiamiento, es
    // decir, la misma utilidad en pesos en las dos columnas, y así la escalera
    // de plazos sigue esa misma regla. Sin costo no hay margen que despejar y
    // la partida queda sin margen guardado.
    const pol = await policy(sql, cid);
    const costs = await productCosts(sql, cid);
    for (const line of priced) {
      const p = costs.find((c) => c.id === line.productId);
      const cost = line.cost > 0 ? line.cost : resolveCost({ avgCost: p?.cost, refCost: p?.ref_cost }).cost;
      const landed = cost + (line.freight ?? 0) + (line.other ?? 0);
      const fin = financeUnit({ cost: landed, days: plazo, tiie, costSpread: data.spread ?? 0, commissionRate: pol.asrCommission });
      const conMargen = landed > 0.0001;
      const mCash = conMargen ? marginFromPrice({ price: line.cash, landed, finance: 0, mode: "nominal" }) : null;
      const mCredit = conMargen ? marginFromPrice({ price: line.credit, landed, finance: fin, mode: "nominal" }) : null;
      await sql`
        insert into quote_lines (quote_id, product_id, qty, unit_price, uom, cost, freight, other_cost, margin_pct, cash_price, credit_price,
          margin_cash_mode, margin_cash_pct, margin_cash_nominal, margin_cash_source,
          margin_credit_mode, margin_credit_pct, margin_credit_nominal, margin_credit_source, finance_unit)
        values (${q[0]!.id}, ${line.productId}, ${line.qty}, ${line.unit}, ${line.uom ?? ""}, ${cost}, ${line.freight ?? 0}, ${line.other ?? 0}, ${line.marginPct ?? 0}, ${line.cash}, ${line.credit},
          ${mCash?.mode ?? null}, ${mCash?.pct ?? null}, ${mCash?.nominal ?? null}, ${mCash ? "captura" : null},
          ${mCredit?.mode ?? null}, ${mCredit?.pct ?? null}, ${mCredit?.nominal ?? null}, ${mCredit ? "captura" : null}, ${Number(fin.toFixed(4))})
      `;
    }
    await rememberTrade(sql, {
      companyId: cid,
      partnerId: data.partnerId,
      kind: "sell",
      products: priced.map((l) => ({ productId: l.productId, unitPrice: l.unit })),
    });
    await writeAudit(sql, {
      companyId: cid,
      userId: context.userId,
      action: "crear-cotizacion",
      entity: "quote",
      entityId: q[0]!.id,
      name,
      detail: `Total ${total.toFixed(2)} ${data.currency} · ${priced.length} partidas · ${state === "sent" ? "enviada" : "borrador"}`,
    });
    return { id: q[0]!.id, name, state };
  });

export const reviseQuote = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      quoteId: z.number(),
      creditDays: z.number().optional(),
      priceOffer: z.enum(["cash", "credit", "both"]).optional(),
      notes: z.string().optional(),
      lines: z
        .array(
          z.object({
            productId: z.number(),
            qty: z.number().positive(),
            cashPrice: z.number().nonnegative(),
            creditPrice: z.number().nonnegative(),
          }),
        )
        .min(1),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    await assertCan(sql, context.userId, "quotes", "edit");
    await ensureTwoPrices(sql);
    const q = await sql<{ id: number; state: string; name: string; revision: number; price_offer: string; credit_days: number; tiie: string; spread: string }>`
      select id, state, name, coalesce(revision,1) as revision, coalesce(price_offer,'both') as price_offer,
        coalesce(credit_days,0)::int as credit_days, coalesce(tiie,0)::text as tiie, coalesce(spread,0)::text as spread
      from quotes where id = ${data.quoteId} and company_id = ${cid}
    `;
    if (!q[0]) throw new Error("Cotización no encontrada");
    // Una cotización aceptada normalmente ya no se toca. La excepción: su
    // pedido sigue en BORRADOR — ahí sí se revisa (es donde se agrega una
    // partida al pedido, punto C3), y al guardar el pedido se actualiza.
    // Con el pedido confirmado no se revisa: se levanta un pedido nuevo.
    const ordenes = await sql<{ id: number; name: string; state: string; accepted_offer: string | null }>`
      select id, name, state, accepted_offer from sales_orders
      where quote_id = ${q[0].id} and company_id = ${cid} order by id
    `;
    const borradores = ordenes.filter((o) => o.state === "draft");
    if (q[0].state === "rejected") throw new Error("Ya se cerró. Abre una cotización nueva.");
    if (q[0].state === "accepted" && !borradores.length) {
      const firme = ordenes.find((o) => o.state !== "draft");
      throw new Error(
        firme
          ? `${firme.name} ya está confirmado: la cotización ya no se revisa. Si falta algo, levanta un pedido nuevo.`
          : "Ya se cerró. Abre una cotización nueva.",
      );
    }
    const offer = data.priceOffer ?? q[0].price_offer;
    const total = data.lines.reduce((s, l) => s + l.qty * (offer === "cash" ? l.cashPrice : l.creditPrice || l.cashPrice), 0);
    // Antes de sobreescribir, los precios de la revisión anterior quedan en
    // bitácora: cada renegociación es reconstruible.
    const oldLines = await sql<{
      product_id: number;
      code: string;
      qty: string;
      cash_price: string;
      credit_price: string;
      unit_price: string;
      cost: string;
      freight: string;
      finance_unit: string | null;
      margin_cash_mode: string | null;
      margin_cash_pct: string | null;
      margin_cash_nominal: string | null;
      margin_credit_mode: string | null;
      margin_credit_pct: string | null;
      margin_credit_nominal: string | null;
    }>`
      select ql.product_id, p.code, ql.qty::text, coalesce(nullif(ql.cash_price,0), ql.unit_price)::text as cash_price,
        coalesce(nullif(ql.credit_price,0), ql.unit_price)::text as credit_price, ql.unit_price::text,
        coalesce(ql.cost,0)::text as cost, coalesce(ql.freight,0)::text as freight, ql.finance_unit::text as finance_unit,
        ql.margin_cash_mode, ql.margin_cash_pct::text as margin_cash_pct, ql.margin_cash_nominal::text as margin_cash_nominal,
        ql.margin_credit_mode, ql.margin_credit_pct::text as margin_credit_pct, ql.margin_credit_nominal::text as margin_credit_nominal
      from quote_lines ql join products p on p.id = ql.product_id
      where ql.quote_id = ${q[0].id}
    `;
    // Partidas que no estaban en la cotización: se agregan en esta revisión
    // (es la única puerta para meter un producto a un pedido que vino de una
    // cotización). Pasan por costo, margen y financiamiento como las demás.
    const nuevasIds = data.lines.filter((l) => !oldLines.some((o) => o.product_id === l.productId)).map((l) => l.productId);
    const nuevos = nuevasIds.length
      ? await sql<{ id: number; code: string; uom: string }>`
          select id, code, coalesce(uom,'') as uom from products
          where company_id = ${cid} and id = any(${nuevasIds}::int[])
        `
      : [];
    if (nuevos.length !== nuevasIds.length) throw new Error("Producto no encontrado");
    // Una revisión es una oferta distinta: si nada cambió (precio, cantidad,
    // plazo u oferta) no se sube el número de revisión ni se escribe bitácora.
    const cambios: string[] = [];
    if (offer !== q[0].price_offer) cambios.push(`oferta ${q[0].price_offer} → ${offer}`);
    if (data.creditDays !== undefined && data.creditDays !== q[0].credit_days) {
      cambios.push(`plazo ${q[0].credit_days} → ${data.creditDays} d`);
    }
    for (const line of data.lines) {
      const prev = oldLines.find((o) => o.product_id === line.productId);
      if (prev) {
        if (Number(prev.qty) !== line.qty) cambios.push(`${prev.code} cant ${Number(prev.qty)} → ${line.qty}`);
        // Misma tolerancia que la pantalla (centavos): ruido de decimales no es una revisión.
        if (Math.abs(Number(prev.cash_price) - line.cashPrice) > 0.009 || Math.abs(Number(prev.credit_price) - line.creditPrice) > 0.009) {
          cambios.push(`${prev.code} precio ${Number(prev.cash_price)}/${Number(prev.credit_price)} → ${line.cashPrice}/${line.creditPrice}`);
        }
      } else {
        const p = nuevos.find((x) => x.id === line.productId);
        cambios.push(`${p?.code ?? line.productId} partida nueva ×${line.qty} a ${offer === "cash" ? line.cashPrice : line.creditPrice}`);
      }
    }
    if (!cambios.length) {
      throw new Error("Sin cambios: la revisión no se guardó. Cambia algún precio, cantidad o plazo para hacer una revisión nueva.");
    }
    // Mismo candado que al crear: si la revisión queda a crédito, cada partida
    // necesita costo (kardex o de referencia) para poder financiar el precio.
    const plazoRev = offer === "cash" ? 0 : (data.creditDays ?? q[0].credit_days);
    await assertCostForCredit(sql, cid, data.lines.map((l) => l.productId), plazoRev);
    // Captura inversa: el precio que se manda es la verdad y el margen guardado
    // de cada columna se despeja de él (contado sin financiamiento; crédito
    // restando el financiamiento que va dentro del precio; el % es sobre el
    // precio de venta). Si el plazo acordado cambió, el financiamiento se
    // recalcula con las tasas de esta cotización: la pantalla ya mandó el
    // precio de la columna de la escalera que corresponde a ese plazo, y de
    // ahí sale el mismo margen de crédito. Una utilidad negativa se guarda tal
    // cual: la pantalla avisa, no bloquea. Sin costo no hay margen que
    // despejar y la partida se deja como estaba.
    const pol = await policy(sql, cid);
    // Costo de las partidas nuevas: el orden único de siempre (kardex →
    // referencia). Las que ya estaban conservan el costo con que se cotizaron.
    const costos = nuevos.length ? await productCosts(sql, cid) : [];
    const costoNuevo = (productId: number) => {
      const p = costos.find((c) => c.id === productId);
      return resolveCost({ avgCost: p?.cost, refCost: p?.ref_cost }).cost;
    };
    const marginUpdates = new Map<number, { cash: ReturnType<typeof marginFromPrice>; credit: ReturnType<typeof marginFromPrice>; fin: number }>();
    for (const line of data.lines) {
      const prev = oldLines.find((o) => o.product_id === line.productId);
      const landed = prev ? Number(prev.cost) + Number(prev.freight) : costoNuevo(line.productId);
      if (landed <= 0.0001) continue;
      const fin =
        plazoRev <= 0
          ? 0
          : prev && plazoRev === q[0].credit_days && prev.finance_unit != null
            ? Number(prev.finance_unit)
            : financeUnit({ cost: landed, days: plazoRev, tiie: Number(q[0].tiie), costSpread: Number(q[0].spread), commissionRate: pol.asrCommission });
      // Sin margen guardado el modo se despeja como %: el número sale del
      // precio que se acaba de capturar, no de un valor por omisión.
      const before = { cash: prev ? marginOf(prev, "cash") : null, credit: prev ? marginOf(prev, "credit") : null };
      const next = {
        cash: marginFromPrice({ price: line.cashPrice, landed, finance: 0, mode: before.cash?.mode ?? "pct" }),
        credit: marginFromPrice({ price: line.creditPrice, landed, finance: fin, mode: before.credit?.mode ?? "pct" }),
        fin: Number(fin.toFixed(4)),
      };
      const code = prev?.code ?? nuevos.find((x) => x.id === line.productId)?.code ?? String(line.productId);
      for (const which of ["cash", "credit"] as Offer[]) {
        const old = before[which];
        const oldTxt = !old || old.legacy ? "—" : marginText(old);
        const newTxt = marginText(next[which]);
        if (oldTxt !== newTxt) cambios.push(`${code} margen ${OFFER_LABEL[which]} ${oldTxt} → ${newTxt}`);
      }
      marginUpdates.set(line.productId, next);
    }
    await sql`
      update quotes
      set revision = ${q[0].revision + 1},
          total = ${total},
          price_offer = ${offer},
          credit_days = coalesce(${data.creditDays ?? null}, credit_days),
          notes = coalesce(${data.notes ?? null}, notes),
          state = 'sent'
      where id = ${q[0].id}
    `;
    for (const line of data.lines) {
      const unit = offer === "cash" ? line.cashPrice : line.creditPrice || line.cashPrice;
      const nueva = nuevos.find((x) => x.id === line.productId);
      if (nueva) {
        await sql`
          insert into quote_lines (quote_id, product_id, qty, unit_price, uom, cost, freight, cash_price, credit_price)
          values (${q[0].id}, ${line.productId}, ${line.qty}, ${unit}, ${nueva.uom}, ${costoNuevo(line.productId)}, 0, ${line.cashPrice}, ${line.creditPrice})
        `;
      } else {
        await sql`
          update quote_lines
          set qty = ${line.qty}, unit_price = ${unit}, cash_price = ${line.cashPrice}, credit_price = ${line.creditPrice}
          where quote_id = ${q[0].id} and product_id = ${line.productId}
        `;
      }
      const m = marginUpdates.get(line.productId);
      if (m) {
        await sql`
          update quote_lines
          set margin_cash_mode = ${m.cash.mode}, margin_cash_pct = ${m.cash.pct}, margin_cash_nominal = ${m.cash.nominal},
              margin_cash_source = 'captura',
              margin_credit_mode = ${m.credit.mode}, margin_credit_pct = ${m.credit.pct}, margin_credit_nominal = ${m.credit.nominal},
              margin_credit_source = 'captura',
              finance_unit = ${m.fin}
          where quote_id = ${q[0].id} and product_id = ${line.productId}
        `;
      }
    }
    await writeAudit(sql, {
      companyId: cid,
      userId: context.userId,
      action: "renegociar-cotizacion",
      entity: "quote",
      entityId: q[0].id,
      name: q[0].name,
      detail: `Rev ${q[0].revision} → ${q[0].revision + 1} · ${cambios.join(" · ")}`,
    });
    // El pedido en borrador que salió de esta cotización se pone al día: las
    // partidas nuevas se agregan con su cantidad y precio, y las que ya tenía
    // toman el precio de la revisión. La cantidad de las que ya estaban NO se
    // toca: si el cliente aceptó parcial, esa cantidad es suya. Confirmado no
    // se toca nunca (aquí ya no llega: se rechazó arriba).
    const pedidos: string[] = [];
    for (const so of borradores) {
      const which = so.accepted_offer === "cash" ? "cash" : "credit";
      const precioDe = (l: (typeof data.lines)[number]) => (which === "cash" ? l.cashPrice : l.creditPrice || l.cashPrice);
      const actuales = await sql<{ id: number; product_id: number; qty: string; unit_price: string; code: string }>`
        select sl.id, sl.product_id, sl.qty::text, sl.unit_price::text, p.code
        from sales_lines sl join products p on p.id = sl.product_id
        where sl.so_id = ${so.id} order by sl.id
      `;
      const detalle: string[] = [];
      let totalSo = 0;
      for (const l of data.lines) {
        const actual = actuales.find((a) => a.product_id === l.productId);
        const precio = Math.round(precioDe(l) * 10000) / 10000;
        if (actual) {
          if (Math.abs(Number(actual.unit_price) - precio) > 0.009) {
            detalle.push(`${actual.code} precio ${Number(actual.unit_price)} → ${precio}`);
            await sql`update sales_lines set unit_price = ${precio} where id = ${actual.id}`;
          }
          totalSo += Number(actual.qty) * precio;
        } else if (nuevos.some((x) => x.id === l.productId)) {
          const p = nuevos.find((x) => x.id === l.productId)!;
          await sql`
            insert into sales_lines (so_id, product_id, qty, unit_price, uom)
            values (${so.id}, ${l.productId}, ${l.qty}, ${precio}, ${p.uom})
          `;
          detalle.push(`${p.code} partida nueva ×${l.qty} a ${precio}`);
          totalSo += l.qty * precio;
        }
        // Una partida que la cotización trae pero el pedido no (aceptación
        // parcial) se queda fuera: el cliente no la pidió.
      }
      if (!detalle.length) continue;
      await sql`update sales_orders set total = ${totalSo} where id = ${so.id} and company_id = ${cid}`;
      await writeAudit(sql, {
        companyId: cid,
        userId: context.userId,
        action: "actualizar-pedido-por-revision",
        entity: "sale",
        entityId: so.id,
        name: so.name,
        detail: `Desde ${q[0].name} Rev ${q[0].revision + 1} · ${detalle.join(" · ")}`,
      });
      pedidos.push(so.name);
    }
    return { id: q[0].id, name: q[0].name, revision: q[0].revision + 1, orders: pedidos };
  });

export const decideQuote = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      quoteId: z.number(),
      decision: z.enum(["accept", "partial", "reject"]),
      locationId: z.number().optional(),
      fulfillKind: z.enum(["inventory", "direct"]).optional().default("inventory"),
      acceptOffer: z.enum(["cash", "credit"]).optional(),
      lines: z.array(z.object({ productId: z.number(), qty: z.number().nonnegative() })).optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    await assertCan(sql, context.userId, "quotes", "edit");
    await ensureInvoiceExtras(sql);
    await sql`alter table quotes add column if not exists price_offer text not null default 'both'`;
    await sql`alter table quotes add column if not exists credit_days integer not null default 0`;
    const q = await sql<{
      id: number;
      partner_id: number;
      currency: string;
      fx_rate: string;
      notes: string;
      delivery_to: string;
      total: string;
      state: string;
      name: string;
      credit_days: number;
      price_offer: string;
      valid_until: string;
    }>`
      select id, partner_id, currency, fx_rate::text, notes, delivery_to, total::text, state, name,
        coalesce(credit_days,0) as credit_days,
        coalesce(price_offer,'both') as price_offer,
        valid_until::text
      from quotes where id = ${data.quoteId} and company_id = ${cid}
    `;
    if (!q[0] || q[0].state === "accepted" || q[0].state === "rejected") {
      throw new Error("Esta cotización ya se cerró");
    }
    if (data.decision !== "reject") {
      const today = todayMx();
      if (q[0].valid_until < today) {
        throw new Error(`La vigencia ya venció (${dateDMY(q[0].valid_until)}). Renegocia o emite otra cotización.`);
      }
    }
    if (data.decision === "reject") {
      await sql`update quotes set state = 'rejected' where id = ${q[0].id}`;
      await writeAudit(sql, {
        companyId: cid,
        userId: context.userId,
        action: "decidir-cotizacion",
        entity: "quote",
        entityId: q[0].id,
        name: q[0].name,
        detail: "Rechazada",
      });
      return { soId: 0, name: q[0].name, state: "rejected", pos: [] as string[] };
    }
    if (!data.locationId) throw new Error("Elige la bodega de surtido");
    await sql`alter table quote_lines add column if not exists cash_price numeric(14,4) not null default 0`;
    await sql`alter table quote_lines add column if not exists credit_price numeric(14,4) not null default 0`;
    const quoted = await sql<{
      product_id: number;
      qty: string;
      unit_price: string;
      uom: string;
      cash_price: string;
      credit_price: string;
    }>`
      select product_id, qty::text, unit_price::text, coalesce(uom,'') as uom,
        coalesce(nullif(cash_price,0), unit_price)::text as cash_price,
        coalesce(nullif(credit_price,0), unit_price)::text as credit_price
      from quote_lines where quote_id = ${q[0].id}
    `;
    const wanted = new Map((data.lines ?? []).map((l) => [l.productId, l.qty]));
    const offer =
      data.acceptOffer ??
      (q[0].price_offer === "cash" ? "cash" : q[0].price_offer === "credit" ? "credit" : q[0].credit_days > 0 ? "credit" : "cash");
    const take = quoted
      .map((l) => ({
        productId: l.product_id,
        qty: data.decision === "partial" && wanted.size ? wanted.get(l.product_id) ?? 0 : Number(l.qty),
        unitPrice: offer === "cash" ? Number(l.cash_price) : Number(l.credit_price),
        uom: l.uom,
      }))
      .filter((l) => l.qty > 0);
    if (!take.length) throw new Error("No hay partidas aceptadas");
    const total = take.reduce((s, l) => s + l.qty * l.unitPrice, 0);
    const n = await sql<{ c: number }>`select count(*)::int as c from sales_orders where company_id = ${cid}`;
    const name = `PV-${String((n[0]?.c ?? 0) + 1).padStart(4, "0")}`;
    const today = todayMx();
    // El pedido hereda el plazo de la cotización: el precio a crédito se armó
    // con esos días y por eso quedan como plazo financiero / mora. La factura
    // vence a los días de Ajustes ("plazo factura"), sin pasar del plazo
    // financiero (la mora no puede arrancar antes del vencimiento de factura).
    // La política de mora sale del cliente: Grupo SL → GRUPO_SL, los demás →
    // ESTANDAR; de contado no hay mora.
    const pol = await policy(sql, cid);
    const days = offer === "credit" ? q[0].credit_days || 0 : 0;
    const termKind = days > 0 ? "credit_days" : "contado";
    const invoiceDays = days > 0 ? Math.min(pol.invoiceDays || days, days) : 0;
    const dues = computeDues({ date: today, termKind, invoiceDays, creditDays: days });
    const grp = await sql<{ group_name: string }>`select coalesce(group_name,'') as group_name from partners where id = ${q[0].partner_id}`;
    const policyCode = days > 0 ? (grp[0]?.group_name === "Grupo SL" ? "GRUPO_SL" : "ESTANDAR") : "NONE";
    const priceMode = days > 0 ? "financed" : "cash";
    const fulfillKind = data.fulfillKind ?? "inventory";
    const routeKind = fulfillKind === "direct" ? "supplier" : "own";
    await sql`alter table sales_orders add column if not exists term_kind text not null default 'contado'`;
    await sql`alter table sales_orders add column if not exists credit_days integer not null default 0`;
    await sql`alter table sales_orders add column if not exists invoice_days integer not null default 0`;
    await ensureTwoPrices(sql);
    const so = await sql<{ id: number }>`
      insert into sales_orders (
        company_id, name, partner_id, state, location_id, notes, total, currency, fx_rate, quote_id, delivery_to,
        term_kind, invoice_days, credit_days, invoice_due, credit_due, route_kind, date, policy_code, price_mode, accepted_offer
      )
      values (
        ${cid}, ${name}, ${q[0].partner_id}, 'draft', ${data.locationId}, ${q[0].notes}, ${total},
        ${q[0].currency}, ${Number(q[0].fx_rate)}, ${q[0].id}, ${q[0].delivery_to},
        ${termKind}, ${dues.invoiceDays}, ${dues.creditDays}, ${dues.invoiceDue}, ${dues.creditDue}, ${routeKind}, ${today},
        ${policyCode}, ${priceMode}, ${offer}
      )
      returning id
    `;
    for (const line of take) {
      await sql`
        insert into sales_lines (so_id, product_id, qty, unit_price, uom)
        values (${so[0]!.id}, ${line.productId}, ${line.qty}, ${line.unitPrice}, ${line.uom})
      `;
    }
    await rememberTrade(sql, {
      companyId: cid,
      partnerId: q[0].partner_id,
      kind: "sell",
      products: take.map((l) => ({ productId: l.productId, unitPrice: l.unitPrice })),
      locationId: data.locationId,
    });
    await sql`update quotes set state = ${data.decision === "partial" ? "partial" : "accepted"}, total = ${total}, accepted_offer = ${offer} where id = ${q[0].id}`;

    const pos: string[] = [];
    const req = await sql<{ id: number; delivery_mode: string }>`
      select id, delivery_mode from customer_requests where quote_id = ${q[0].id} and company_id = ${cid} limit 1
    `;
    if (req[0]) {
      const winners = await sql<{ supplier_id: number; product_id: number; qty: string; cost: string; uom: string }>`
        select supplier_id, product_id, qty::text, cost::text, uom from customer_request_lines
        where request_id = ${req[0].id} and supplier_id is not null
      `;
      const bySup = new Map<number, typeof winners>();
      for (const w of winners) {
        const accepted = take.find((t) => t.productId === w.product_id);
        if (!accepted) continue;
        const list = bySup.get(w.supplier_id) ?? [];
        list.push({ ...w, qty: String(accepted.qty) });
        bySup.set(w.supplier_id, list);
      }
      await sql`alter table purchase_orders add column if not exists fulfill_kind text not null default 'inventory'`;
      await sql`alter table purchase_orders add column if not exists so_id integer`;
      await sql`alter table purchase_lines add column if not exists deliver_to text not null default ''`;
      for (const [supplierId, lines] of bySup) {
        const poN = await sql<{ c: number }>`select count(*)::int as c from purchase_orders where company_id = ${cid}`;
        const poName = `OC-${String((poN[0]?.c ?? 0) + 1).padStart(4, "0")}`;
        const poTotal = lines.reduce((s, l) => s + Number(l.qty) * Number(l.cost), 0);
        const po = await sql<{ id: number }>`
          insert into purchase_orders (company_id, name, partner_id, date, state, location_id, notes, total, currency, fx_rate, fulfill_kind, so_id)
          values (${cid}, ${poName}, ${supplierId}, ${today}, 'confirmed', ${data.locationId}, ${`Desde ${name}`}, ${poTotal},
            ${q[0].currency}, ${Number(q[0].fx_rate)}, ${fulfillKind}, ${so[0]!.id})
          returning id
        `;
        for (const line of lines) {
          await sql`
            insert into purchase_lines (po_id, product_id, qty, unit_price, uom, deliver_to)
            values (${po[0]!.id}, ${line.product_id}, ${Number(line.qty)}, ${Number(line.cost)}, ${line.uom}, ${q[0].delivery_to})
          `;
        }
        await rememberTrade(sql, {
          companyId: cid,
          partnerId: supplierId,
          kind: "buy",
          products: lines.map((l) => ({ productId: l.product_id, unitPrice: Number(l.cost) })),
          locationId: data.locationId,
        });
        const daysPay = await sql<{ payment_days: number }>`select coalesce(payment_days,0) as payment_days from partners where id = ${supplierId}`;
        const due = addDays(today, daysPay[0]?.payment_days ?? 0);
        const ic = await sql<{ c: number }>`select count(*)::int as c from invoices where company_id = ${cid} and kind = 'supplier'`;
        const iname = `FP-${String((ic[0]?.c ?? 0) + 1).padStart(4, "0")}`;
        await sql`
          insert into invoices (company_id, kind, name, partner_id, date, due_date, state, amount, residual, origin, currency, created_by)
          values (${cid}, 'supplier', ${iname}, ${supplierId}, ${today}, ${due}, 'open', ${poTotal}, ${poTotal}, ${poName}, ${q[0].currency}, ${context.userId})
        `;
        pos.push(poName);
      }
    }
    if (pos.length) {
      await sql`update sales_orders set notes = ${[q[0].notes, `Compras ${pos.join(", ")}`].filter(Boolean).join(" · ")} where id = ${so[0]!.id}`;
    }
    await writeAudit(sql, {
      companyId: cid,
      userId: context.userId,
      action: "decidir-cotizacion",
      entity: "quote",
      entityId: q[0].id,
      name: q[0].name,
      detail: `${data.decision === "partial" ? "Parcial" : "Aceptada"} · precio ${OFFER_LABEL[offer as Offer]}${days > 0 ? ` ${days} d` : ""} · ${name}${pos.length ? ` · ${pos.join(", ")}` : ""}`,
    });
    return { soId: so[0]!.id, name, state: data.decision, pos };
  });

export const listBanks = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    await assertCan(sql, context.userId, "banks", "view");
    try {
      const { seedExpenseCategories } = await import("@/lib/erp/expenses");
      await seedExpenseCategories(sql, cid);
    } catch {
      /* ignore */
    }
    const banks = await sql<{
      id: number;
      name: string;
      account: string;
      currency: string;
      opening: string;
      movement: string;
    }>`
      select b.id, b.name, b.account, b.currency, b.opening::text,
        coalesce((select sum(amount) from bank_moves m where m.bank_id = b.id),0)::text as movement
      from banks b
      where b.company_id = ${cid}
      order by b.id
    `;
    const moves = await sql<{
      id: number;
      bank: string;
      date: string;
      amount: string;
      memo: string;
      partner: string | null;
      reconciled: boolean;
      kind: string;
      invoice: string | null;
      so_name: string | null;
      po_name: string | null;
    }>`
      select m.id, b.name as bank, m.date::text, m.amount::text, m.memo, p.name as partner, m.reconciled,
        coalesce(m.kind, 'ajuste') as kind, i.name as invoice, s.name as so_name, po.name as po_name
      from bank_moves m
      join banks b on b.id = m.bank_id
      left join partners p on p.id = m.partner_id
      left join invoices i on i.id = m.invoice_id
      left join sales_orders s on s.id = m.so_id
      left join purchase_orders po on po.id = m.po_id
      where m.company_id = ${cid}
      order by m.date desc, m.id desc
      limit 80
    `;
    const partners = await sql<{ id: number; name: string; is_customer: boolean; is_supplier: boolean }>`
      select id, name, is_customer, is_supplier from partners where company_id = ${cid} order by name
    `;
    const invoices = await sql<{ id: number; name: string; partner_id: number; kind: string; residual: string; currency: string }>`
      select id, name, partner_id, kind, residual::text, coalesce(currency,'MXN') as currency from invoices
      where company_id = ${cid} and state <> 'paid' order by id desc limit 80
    `;
    const sales = await sql<{ id: number; name: string; partner_id: number }>`
      select id, name, partner_id from sales_orders where company_id = ${cid} order by id desc limit 80
    `;
    const purchases = await sql<{ id: number; name: string; partner_id: number }>`
      select id, name, partner_id from purchase_orders where company_id = ${cid} order by id desc limit 80
    `;
    return { banks, moves, partners, invoices, sales, purchases };
  });

export const saveBankOpening = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ bankId: z.number(), opening: z.number() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    await assertCan(sql, context.userId, "banks", "edit");
    const before = await sql<{ opening: string; name: string }>`
      select opening::text, name from banks where id = ${data.bankId} and company_id = ${cid}
    `;
    await sql`update banks set opening = ${data.opening} where id = ${data.bankId} and company_id = ${cid}`;
    if (before[0] && Number(before[0].opening) !== data.opening) {
      await writeAudit(sql, {
        companyId: cid,
        userId: context.userId,
        action: "saldo-banco",
        entity: "bank",
        entityId: data.bankId,
        name: before[0].name,
        detail: `Saldo inicial ${Number(before[0].opening)} → ${data.opening}`,
      });
    }
    return { ok: true };
  });

/**
 * Cobro/pago aplicado a UNA factura. Es el ÚNICO camino: lo usan la pantalla
 * de Cartera (registerPayment) y la de Bancos (addBankMove ligado a factura),
 * para que el mismo pago produzca el mismo resultado por cualquier entrada.
 * Debe llamarse dentro de una transacción (withTx).
 */
export async function applyInvoicePayment(
  sql: Sql,
  opts: {
    companyId: number;
    userId: string;
    invoiceId: number;
    bankId: number;
    amount: number;
    memo?: string;
    date?: string;
    /** TC del día del pago. Obligatorio para facturas de cliente en USD. */
    fxPaid?: number;
    /** Qué hacer con el diferencial cambiario de ESTE cobro (el Excel lo decide pago por pago). */
    fxTreatment?: "utilidad" | "ajuste";
  },
) {
  const inv = await sql<{
    id: number;
    kind: string;
    residual: string;
    amount: string;
    inv_class: string;
    currency: string;
    amount_fx: string;
    fx_agreed: string;
    partner_id: number;
    name: string;
    date: string;
    due_date: string;
    order_id: number | null;
    credit_days: number;
  }>`
    select id, kind, residual::text, amount::text, coalesce(inv_class,'product') as inv_class,
      coalesce(currency,'MXN') as currency, coalesce(amount_fx,0)::text as amount_fx, coalesce(fx_agreed,0)::text as fx_agreed,
      partner_id, name, date::text, due_date::text, order_id, coalesce(credit_days,0)::int as credit_days from invoices
    where id = ${opts.invoiceId} and company_id = ${opts.companyId}
    for update
  `;
  if (!inv[0]) throw new Error("Factura no encontrada");
  const residual = Number(inv[0].residual);
  if (residual <= 0.009) throw new Error("Esta factura ya está saldada");
  // Factura de cliente en dólares: el libro está en pesos al TC pactado; el
  // depósito real se convierte con el TC del día y la diferencia es el
  // diferencial cambiario del tramo.
  const isUsdCustomer =
    inv[0].kind === "customer" && inv[0].currency === "USD" && Number(inv[0].fx_agreed) > 0 && Number(inv[0].amount_fx) > 0;
  let applied: number;
  let bankAmount: number;
  let fxDiff = 0;
  let usdApplied = 0;
  if (isUsdCustomer) {
    if (!opts.fxPaid || opts.fxPaid <= 0) {
      throw new Error("Es factura en dólares: captura el tipo de cambio del pago.");
    }
    const split = fxPaymentSplit({
      depositedMxn: opts.amount,
      fxPaid: opts.fxPaid,
      fxAgreed: Number(inv[0].fx_agreed),
      residualMxn: residual,
    });
    applied = split.appliedMxn;
    bankAmount = split.bankMxn;
    fxDiff = split.diff;
    usdApplied = split.usdApplied;
  } else {
    applied = Math.min(opts.amount, residual);
    bankAmount = applied;
  }
  await sql`select id from banks where id = ${opts.bankId} and company_id = ${opts.companyId} for update`;
  const bank = await sql<{ id: number; name: string; opening: string; movement: string }>`
    select b.id, b.name, b.opening::text,
      coalesce((select sum(amount) from bank_moves m where m.bank_id = b.id),0)::text as movement
    from banks b where b.id = ${opts.bankId} and b.company_id = ${opts.companyId}
  `;
  if (!bank[0]) throw new Error("Elige una cuenta de banco");
  const cash = Number(bank[0].opening) + Number(bank[0].movement);
  if (inv[0].kind === "supplier" && cash + 0.009 < applied) {
    throw new Error(
      `No hay saldo en ${bank[0].name} (${cash.toFixed(2)}). Primero cobra o captura un saldo inicial en Bancos.`,
    );
  }

  const today = todayMx();
  const payDate = (opts.date || today).slice(0, 10);
  if (payDate < inv[0].date) {
    throw new Error(`La fecha del cobro (${payDate}) no puede ser anterior a la factura (${inv[0].date}).`);
  }
  let mora: { name: string | null; charge: number; formula?: string } = { name: null, charge: 0 };
  if (inv[0].kind === "customer") {
    mora = await issueMoraInvoice(sql, opts.companyId, inv[0].id, {
      asOf: payDate,
      paidDate: payDate,
      requireCharge: false,
      userId: opts.userId,
    });
  }

  const n = await sql<{ c: number }>`select count(*)::int as c from payments where company_id = ${opts.companyId}`;
  const name = `PAG-${String((n[0]?.c ?? 0) + 1).padStart(4, "0")}`;
  const kind = inv[0].kind === "customer" ? "inbound" : "outbound";
  const pay = await sql<{ id: number }>`
    insert into payments (company_id, kind, name, partner_id, amount, memo, created_by, date)
    values (${opts.companyId}, ${kind}, ${name}, ${inv[0].partner_id}, ${applied}, ${opts.memo ?? ""}, ${opts.userId}, ${payDate})
    returning id
  `;
  await sql`
    insert into payment_allocs (payment_id, invoice_id, amount)
    values (${pay[0]!.id}, ${inv[0].id}, ${applied})
  `;
  let newRes = await refreshInvoiceResidual(sql, inv[0].id);
  // El banco registra los pesos REALES que entraron o salieron (bankAmount);
  // la factura se aplica a pesos al TC pactado (applied). La diferencia es el
  // diferencial cambiario, que se decide abajo.
  const signed = inv[0].kind === "customer" ? bankAmount : -bankAmount;
  const moveKind = inv[0].kind === "customer" ? "cobro" : "pago";
  const usdNote = opts.fxPaid && !isUsdCustomer ? ` (pago en USD, TC ${opts.fxPaid})` : "";
  await sql`
    insert into bank_moves (company_id, bank_id, date, amount, memo, partner_id, kind, invoice_id, payment_id, created_by)
    values (
      ${opts.companyId}, ${opts.bankId}, ${payDate}, ${signed},
      ${(opts.memo || `${moveKind} ${inv[0].name}`) + usdNote},
      ${inv[0].partner_id}, ${moveKind}, ${inv[0].id}, ${pay[0]!.id}, ${opts.userId}
    )
  `;

  // Diferencial cambiario del tramo: se decide pago por pago (como el Excel).
  let fxDoc: string | null = null;
  let fxNote = "";
  if (isUsdCustomer && Math.abs(fxDiff) >= 0.01 && opts.fxPaid) {
    const treatment = opts.fxTreatment ?? "utilidad";
    const calc = `${usdApplied.toFixed(2)} USD × (TC pagado ${opts.fxPaid} − pactado ${Number(inv[0].fx_agreed)}) = ${fxDiff.toFixed(2)}`;
    if (treatment === "ajuste") {
      // Pagó de menos → documento POR COBRAR; de más → POR DEVOLVER (a favor).
      const n = await sql<{ c: number }>`
        select count(*)::int as c from invoices where company_id = ${opts.companyId} and inv_class = 'fx'
      `;
      fxDoc = `ATC-${String((n[0]?.c ?? 0) + 1).padStart(4, "0")}`;
      await sql`
        insert into invoices (company_id, kind, name, partner_id, date, due_date, state, amount, residual, origin, inv_class, currency, order_id, created_by, calc)
        values (
          ${opts.companyId}, 'customer', ${fxDoc}, ${inv[0].partner_id}, ${payDate}, ${payDate}, 'open',
          ${-fxDiff}, ${-fxDiff}, ${"Ajuste TC " + inv[0].name}, 'fx', 'MXN', ${inv[0].order_id}, ${opts.userId}, ${calc}
        )
      `;
      fxNote = `${fxDiff < 0 ? "POR COBRAR" : "POR DEVOLVER"} ${fxDoc}: ${Math.abs(fxDiff).toFixed(2)}`;
    } else {
      await sql`update invoices set fx_result = fx_result + ${fxDiff} where id = ${inv[0].id}`;
      fxNote = `${fxDiff >= 0 ? "utilidad" : "pérdida"} cambiaria ${Math.abs(fxDiff).toFixed(2)}`;
    }
    await sql`
      update invoices set fx_paid = ${opts.fxPaid}, fx_treatment = ${treatment},
        fx_invoiced = fx_invoiced + ${Math.max(0, -fxDiff)}
      where id = ${inv[0].id}
    `;
    await writeAudit(sql, {
      companyId: opts.companyId,
      userId: opts.userId,
      action: treatment === "ajuste" ? "ajuste-tc" : "diferencial-tc",
      entity: "invoice",
      entityId: inv[0].id,
      name: inv[0].name,
      detail: `${calc} → ${fxNote}`,
    });
  }

  // Descuento REAL por pronto pago: si pagó antes del umbral y lo que falta
  // del saldo cabe en la bonificación (días hasta el plazo financiero, a TIIE
  // de emisión + spread de costo), ese resto se perdona y la factura se cierra.
  let discount = 0;
  let discountDetail = "";
  if (inv[0].kind === "customer" && inv[0].inv_class === "product" && Number(inv[0].amount) > 0 && newRes > 0.009) {
    const pol = await policy(sql, opts.companyId);
    // La TIIE solo hace falta si el pago cae antes del umbral (Ajustes). Si
    // hace falta y la tabla no tiene renglón para la fecha de emisión, el cobro
    // se detiene con aviso: nunca se bonifica con una tasa inventada.
    const early = daysBetween(inv[0].date, payDate) < pol.earlyPayDays;
    const tiieRows = early
      ? await sql<{ date: string; rate: string }>`
          select date::text, rate::text from tiie_rates where company_id = ${opts.companyId} order by date
        `
      : [];
    const tiieAtIssue = early
      ? requireRate(
          tiieRows.map((r) => ({ date: r.date, rate: Number(r.rate) })),
          inv[0].date,
          `pronto pago de ${inv[0].name}`,
        ).rate
      : 0;
    const bono = earlyPayBonus({
      cargo: Number(inv[0].amount),
      issueDate: inv[0].date,
      payDate,
      thresholdDays: pol.earlyPayDays,
      // Se bonifican los días no usados del plazo de ESTE pedido.
      financialDays: inv[0].credit_days || pol.creditDays,
      tiieAtIssue,
      costSpread: pol.asrSpread,
    });
    if (bono.applies && newRes <= bono.bonus + 0.009) {
      discount = Math.round(newRes * 100) / 100;
      const dn = await sql<{ c: number }>`select count(*)::int as c from payments where company_id = ${opts.companyId}`;
      const dname = `PAG-${String((dn[0]?.c ?? 0) + 1).padStart(4, "0")}`;
      const dpay = await sql<{ id: number }>`
        insert into payments (company_id, kind, name, partner_id, amount, memo, created_by, date)
        values (${opts.companyId}, 'inbound', ${dname}, ${inv[0].partner_id}, ${discount}, ${`Pronto pago ${inv[0].name}`}, ${opts.userId}, ${payDate})
        returning id
      `;
      await sql`insert into payment_allocs (payment_id, invoice_id, amount) values (${dpay[0]!.id}, ${inv[0].id}, ${discount})`;
      newRes = await refreshInvoiceResidual(sql, inv[0].id);
      discountDetail = `Pagó al día ${bono.lived} (umbral ${pol.earlyPayDays}). Bonificación ganada: ${Number(inv[0].amount).toFixed(2)} × ${(bono.rate * 100).toFixed(2)}% × ${bono.days} d / 360 = ${bono.bonus.toFixed(2)}. Aplicado al saldo: ${discount.toFixed(2)}.`;
      await writeAudit(sql, {
        companyId: opts.companyId,
        userId: opts.userId,
        action: "pronto-pago",
        entity: "invoice",
        entityId: inv[0].id,
        name: inv[0].name,
        detail: discountDetail,
      });
    }
  }

  if (newRes <= 0.009) {
    await sql`update invoices set paid_date = coalesce(paid_date, ${payDate}::date) where id = ${inv[0].id}`;
  }
  const cashAfter = cash + signed;
  await writeAudit(sql, {
    companyId: opts.companyId,
    userId: opts.userId,
    action: inv[0].kind === "customer" ? "cobro" : "pago",
    entity: "invoice",
    entityId: inv[0].id,
    name: inv[0].name,
    detail: `${applied} · ${bank[0].name}`,
  });
  return {
    ok: true as const,
    applied,
    residual: newRes,
    mora: mora.name,
    moraCharge: mora.charge,
    moraFormula: mora.formula ?? "",
    discount,
    discountDetail,
    fxDiff,
    fxDoc,
    fxNote,
    bank: bank[0].name,
    cashAfter,
  };
}

export const addBankMove = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      bankId: z.number(),
      date: z.string(),
      amount: z.number().positive(),
      kind: z.enum(["cobro", "pago", "transferencia", "ajuste"]),
      memo: z.string().optional().default(""),
      partnerId: z.number().optional(),
      invoiceId: z.number().optional(),
      soId: z.number().optional(),
      poId: z.number().optional(),
      bankToId: z.number().optional(),
      fxPaid: z.number().positive().optional(),
      fxTreatment: z.enum(["utilidad", "ajuste"]).optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    const boot = await getSql();
    await boot`alter table invoices add column if not exists fx_result numeric(14,2) not null default 0`;
    await boot`alter table invoices add column if not exists fx_treatment text not null default ''`;
    await ensureInvoiceExtras(boot);
    return withTx(async (sql) => {
      const cid = await companyOf(sql, context.userId);
      await assertCan(sql, context.userId, "banks", "edit");
      // Movimiento ligado a una factura = un cobro/pago de verdad: pasa por el
      // MISMO camino que la pantalla de Cartera (tope al saldo, mora, bitácora).
      if (data.invoiceId && (data.kind === "cobro" || data.kind === "pago")) {
        return applyInvoicePayment(sql, {
          companyId: cid,
          userId: context.userId,
          invoiceId: data.invoiceId,
          bankId: data.bankId,
          amount: Math.abs(data.amount),
          memo: data.memo ?? "",
          date: data.date,
          fxPaid: data.fxPaid,
          fxTreatment: data.fxTreatment,
        });
      }
      const signed =
        data.kind === "cobro" || data.kind === "ajuste" ? Math.abs(data.amount) : -Math.abs(data.amount);
      if (data.kind === "pago" || data.kind === "transferencia") {
        const bal = await sql<{ opening: string; movement: string }>`
          select b.opening::text, coalesce((select sum(amount) from bank_moves m where m.bank_id = b.id),0)::text as movement
          from banks b where b.id = ${data.bankId} and b.company_id = ${cid}
        `;
        const cash = Number(bal[0]?.opening ?? 0) + Number(bal[0]?.movement ?? 0);
        if (cash + 0.009 < Math.abs(data.amount)) {
          throw new Error(`No hay saldo suficiente en la cuenta (${cash.toFixed(2)}). Cobra primero o captura saldo inicial.`);
        }
      }
      const memo = data.memo ?? "";
      await sql`
        insert into bank_moves (company_id, bank_id, date, amount, memo, partner_id, kind, invoice_id, so_id, po_id, created_by)
        values (${cid}, ${data.bankId}, ${data.date}, ${signed}, ${memo}, ${data.partnerId ?? null},
          ${data.kind}, ${data.invoiceId ?? null}, ${data.soId ?? null}, ${data.poId ?? null}, ${context.userId})
      `;
      if (data.kind === "transferencia") {
        if (!data.bankToId) throw new Error("Elige la cuenta destino");
        await sql`
          insert into bank_moves (company_id, bank_id, date, amount, memo, kind, created_by)
          values (${cid}, ${data.bankToId}, ${data.date}, ${Math.abs(data.amount)}, ${memo || "Transferencia"}, 'transferencia', ${context.userId})
        `;
      }
      return { ok: true };
    });
  });

export const reconcileMove = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ moveId: z.number() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    await assertCan(sql, context.userId, "banks", "edit");
    const rows = await sql<{ reconciled: boolean; memo: string; amount: string }>`
      update bank_moves set reconciled = not reconciled
      where id = ${data.moveId} and company_id = ${cid}
      returning reconciled, memo, amount::text
    `;
    if (!rows[0]) throw new Error("Movimiento no encontrado");
    await writeAudit(sql, {
      companyId: cid,
      userId: context.userId,
      action: rows[0].reconciled ? "conciliar" : "desconciliar",
      entity: "bank_move",
      entityId: data.moveId,
      detail: `${rows[0].memo || ""} · ${rows[0].amount}`.trim(),
    });
    return { ok: true };
  });

export const getLiveStatement = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      partnerId: z.number().optional(),
      groupName: z.string().optional(),
      asOf: z.string().optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    const me = await activeMember(sql, context.userId);
    if (me.acl.credit === "none" && me.acl.statements === "none") {
      throw new Error("Sin permiso para ver la cartera");
    }
    const pol = await policy(sql, cid);
    await ensureInvoiceExtras(sql);
    const asOf = (data.asOf || todayMx()).slice(0, 10);
    // Corte histórico: se reconstruye el estado REAL de ese día — solo las
    // facturas que existían, solo los abonos hasta esa fecha, y las FI
    // emitidas hasta entonces (con su desglose interés/FEGA guardado).
    const historico = asOf < todayMx();
    const tiieRows = await sql<{ date: string; rate: string }>`
      select date::text, rate::text from tiie_rates where company_id = ${cid} order by date
    `;
    const tiieTable = tiieRows.map((r) => ({ date: r.date, rate: Number(r.rate) }));
    // Comisión y FEGA se negocian por cliente: cada documento trae la política
    // con la que nació y de ahí salen sus dos interruptores. Sin capturar, la
    // fila se marca y no se cobra nada — no se decide por el dueño.
    const polMap = await creditPolicyMap(sql, cid);

    const partners = await sql<{
      id: number;
      code: string;
      name: string;
      legal_name: string;
      group_name: string;
      email: string;
      phone: string;
      rfc: string;
      payment_days: number;
    }>`
      select id, code, name, legal_name, group_name, email, phone, rfc, payment_days
      from partners
      where company_id = ${cid}
        and is_customer = true
        and (${data.partnerId ?? 0} = 0 or id = ${data.partnerId ?? 0})
        and (${data.groupName ?? ""} = '' or group_name = ${data.groupName ?? ""})
        and (${me.own_only} = false or seller_id = ${context.userId} or seller_id is null)
      order by name
    `;

    const result = [];
    for (const partner of partners) {
      const invoices = await sql<{
        id: number;
        name: string;
        kind: string;
        date: string;
        due_date: string;
        credit_due: string | null;
        amount: string;
        residual: string;
        state: string;
        origin: string;
        currency: string;
        amount_fx: string;
        fx_agreed: string;
        fx_paid: string | null;
        inv_class: string;
        fega_charged: boolean;
        interest_invoiced: string;
        fx_invoiced: string;
        paid_date: string | null;
        credit_days: number;
        opening_paid: string;
        policy_code: string;
      }>`
        select id, name, kind, date::text, due_date::text, credit_due::text, amount::text, residual::text, state, origin,
          currency, amount_fx::text, fx_agreed::text, fx_paid::text, inv_class, fega_charged,
          interest_invoiced::text, fx_invoiced::text, paid_date::text,
          coalesce(credit_days, 0)::int as credit_days,
          coalesce(opening_paid, 0)::text as opening_paid,
          coalesce(policy_code, '') as policy_code
        from invoices
        where company_id = ${cid} and partner_id = ${partner.id}
        order by date, id
      `;
      const fis = await sql<{ origin: string; date: string; int_part: string; fega_part: string }>`
        select origin, date::text, coalesce(int_part,0)::text as int_part, coalesce(fega_part,0)::text as fega_part
        from invoices
        where company_id = ${cid} and partner_id = ${partner.id} and inv_class = 'interest'
      `;
      const lines = await sql<{
        invoice_id: number;
        product: string;
        qty: string;
        unit_price: string;
        amount: string;
      }>`
        select il.invoice_id, coalesce(p.name, il.description) as product,
          il.qty::text, il.unit_price::text, il.amount::text
        from invoice_lines il
        left join products p on p.id = il.product_id
        join invoices i on i.id = il.invoice_id
        where i.partner_id = ${partner.id} and i.company_id = ${cid}
      `;
      const contacts = await sql<{ name: string; email: string; phone: string; role: string; is_billing: boolean }>`
        select name, email, phone, role, is_billing from partner_contacts
        where partner_id = ${partner.id} order by is_billing desc
      `;
      const pays = await sql<{
        invoice_id: number;
        date: string;
        amount: string;
      }>`
        select pa.invoice_id, p.date::text, pa.amount::text
        from payment_allocs pa
        join payments p on p.id = pa.payment_id
        join invoices i on i.id = pa.invoice_id
        where i.company_id = ${cid} and i.partner_id = ${partner.id}
        order by p.date, pa.id
      `;

      const visibles = historico ? invoices.filter((i) => i.date <= asOf) : invoices;
      const rows = visibles.map((inv) => {
        // Dos fechas por factura: due_date es el vencimiento VISIBLE al cliente
        // (120 d); credit_due es el plazo financiero real (150 d) desde el que
        // corre la mora y del que se toma la TIIE. Sin credit_due (corte
        // Compaq), se usa el único vencimiento que hay.
        const moraDue = inv.credit_due || inv.due_date;
        const cargo = Number(inv.amount);
        const productDoc = inv.kind === "customer" && (inv.inv_class || "product") === "product";
        const allocsAll = pays.filter((p) => p.invoice_id === inv.id);
        const allocs = historico ? allocsAll.filter((p) => p.date <= asOf) : allocsAll;
        const abono = allocs.reduce((s, p) => s + Number(p.amount), 0);
        // En corte histórico el saldo se reconstruye con los abonos de ESE día
        // (cargo − abono del corte Compaq − pagos hasta la fecha).
        const saldo = historico && cargo > 0
          ? Math.max(0, cargo - Number(inv.opening_paid) - abono)
          : Number(inv.residual);
        const fechaAbono = allocs.length ? allocs[allocs.length - 1]!.date : historico ? null : inv.paid_date;
        // El interés corre sobre el CARGO original hasta la liquidación total:
        // un abono parcial no lo congela ni reduce la base (regla del Excel).
        const paidForCalc = saldo <= 0.009 ? (historico ? fechaAbono : (inv.paid_date ?? fechaAbono)) : null;
        // ¿Ya venció al corte? Antes del plazo financiero NO nace nada: ni
        // interés ni comisión ni FEGA (regla del dueño, 3-sep-2026). Se decide
        // aquí, antes de pedirle nada a la tabla de TIIE: una factura que no
        // ha vencido no necesita tasa porque no hay nada que calcular.
        const fechaPagoCalc = paidForCalc && paidForCalc <= asOf ? paidForCalc : asOf;
        const diasVencidos = daysBetween(moraDue, fechaPagoCalc);
        const vencido = productDoc && diasVencidos > 0;
        // TIIE del renglón de la tabla vigente al plazo financiero. Sin renglón
        // no se calcula interés: la fila sale marcada "sin TIIE" y con el aviso,
        // nunca con una tasa inventada.
        const tiiePick = nearestRate(tiieTable, moraDue);
        const sinTiie = vencido && tiiePick == null;
        const tiie = tiiePick?.rate ?? 0;
        // COMISIÓN Y FEGA SEGÚN LA POLÍTICA DEL DOCUMENTO. El porcentaje sigue
        // saliendo de Ajustes; la política solo dice cuál de las dos mitades se
        // cobra. Sin los dos interruptores capturados no se cobra nada y la
        // fila queda marcada: la decisión es del dueño, no del sistema.
        const politica = polMap.get(inv.policy_code) ?? null;
        const cobra = chargesCaptured(politica) ? { commission: politica.commission, fega: politica.fega } : null;
        const sinPolitica = vencido && cobra == null;
        const tasas = cobra
          ? chargeRates(pol.fegaRate, pol.commissionRate, cobra)
          : { fegaRate: 0, commissionRate: 0, fegaOnlyRate: 0 };
        // FI emitidas hasta el corte, con su desglose guardado interés/FEGA.
        const misFis = fis.filter((f) => f.origin === "Mora " + inv.name && (!historico || f.date <= asOf));
        const intInvoiced = historico
          ? misFis.reduce((s, f) => s + Number(f.int_part), 0)
          : Number(inv.interest_invoiced);
        const fegaCharged = historico ? misFis.some((f) => Number(f.fega_part) > 0) : inv.fega_charged;
        // Días vencidos aunque falte la TIIE: se muestran, lo que no se
        // calcula es el dinero.
        const endOverdue = paidForCalc && paidForCalc < asOf ? paidForCalc : asOf;
        const mora = productDoc && !sinTiie
          ? computeMora({
              capital: Math.max(0, cargo),
              dueDate: moraDue,
              asOf,
              paidDate: paidForCalc,
              tiieAtDue: tiie,
              spread: pol.collectionSpread,
              fegaRate: tasas.fegaRate,
              fegaAlreadyCharged: fegaCharged,
            })
          : {
              daysOverdue: productDoc ? Math.max(0, daysBetween(moraDue, endOverdue)) : 0,
              annualRate: sinTiie ? 0 : tiie + pol.collectionSpread,
              interest: 0, fega: 0, mora: 0, tiie, spread: pol.collectionSpread, capital: cargo, endDate: asOf,
            };
        // Lo mismo que facturaría la FI hoy: interés nuevo + FEGA si falta.
        const liveMora = Math.max(0, mora.interest - intInvoiced) + mora.fega;
        const fxDiff = inv.currency === "USD"
          ? fxDifferential(Number(inv.amount_fx), Number(inv.fx_agreed), inv.fx_paid ? Number(inv.fx_paid) : null)
          : 0;
        const liveFx = Math.max(0, fxDiff - Number(inv.fx_invoiced));
        const dueNow = saldo + liveMora + liveFx;
        const plazo = inv.credit_days || partner.payment_days || 0;
        const { serie, folio } = splitDocName(inv.name);
        const line = productDoc && !sinTiie
          ? computeStatementLine({
              cargo,
              dueDate: moraDue,
              asOf,
              paidDate: paidForCalc,
              tiieAtDue: tiie,
              spread: pol.collectionSpread,
              fegaRate: tasas.fegaRate,
              commissionRate: tasas.commissionRate,
            })
          : null;
        // BONIFICACIÓN POR PRONTO PAGO — VA A TASA DE COSTO, NO DE COBRO.
        // Lo que se le regresa al cliente es el financiamiento que NO consumió:
        // TIIE de la emisión + spread ASR (lo que a Azagro le cuesta el dinero),
        // nunca TIIE + spread de cobro. Solo procede si el pago cae antes del
        // umbral de pronto pago de Ajustes. Si la factura sigue abierta es una
        // ESTIMACIÓN: cuánto se bonificaría si pagara en la fecha del corte.
        const fechaBono = paidForCalc ?? asOf;
        const bonoEstimado = productDoc && paidForCalc == null;
        const tiieIssuePick = productDoc ? nearestRate(tiieTable, inv.date) : null;
        const bono = productDoc && tiieIssuePick
          ? earlyPayBonus({
              cargo,
              issueDate: inv.date,
              payDate: fechaBono,
              thresholdDays: pol.earlyPayDays,
              financialDays: inv.credit_days || pol.creditDays,
              tiieAtIssue: tiieIssuePick.rate,
              costSpread: pol.asrSpread,
            })
          : { applies: false, lived: 0, days: 0, rate: 0, bonus: 0 };
        // Sin renglón de TIIE a la emisión no se estima la bonificación: se avisa.
        const sinTiieBono = productDoc && !vencido && tiieIssuePick == null;
        const formula = sinTiie && productDoc
          ? {
              short: "Sin TIIE en la tabla: interés no calculado.",
              lines: [
                missingRateMessage(moraDue, `plazo financiero de ${inv.name}`),
                "Interés y comisión/FEGA no calculados: esta fila queda fuera del total de mora hasta que haya TIIE.",
              ],
            }
          : explainInterest({
              capital: line?.capital ?? mora.capital,
              days: line?.daysVencidos ?? mora.daysOverdue,
              tiie: mora.tiie,
              tiieDate: tiiePick?.date,
              spread: mora.spread,
              interest: line?.interest ?? mora.interest,
              fega: line?.comisionFega ?? mora.fega,
              fegaRate: tasas.fegaRate,
              commissionRate: tasas.commissionRate,
              currency: inv.currency,
              dueDate: inv.due_date,
              residual: saldo,
            });
        const dueCheck = validateDueDates({
          issue: inv.date,
          due: moraDue,
          days: plazo || undefined,
          asOf,
          allowPast: true,
        });
        if (bono.applies) {
          const tasa = `TIIE de emisión ${rateLabel(tiieIssuePick!)} + spread ASR ${pctRate(pol.asrSpread)} (tasa de costo, no la de cobro) = ${pctRate(bono.rate)}`;
          formula.lines.push(
            bonoEstimado
              ? `Estimación de pronto pago: si pagara el ${dateDMY(fechaBono)} —día ${bono.lived} de la factura, antes del umbral de ${pol.earlyPayDays} d— se le bonificarían los ${bono.days} d del plazo financiero que no consumió: cargo × (${tasa}) × ${bono.days} d / 360 = ${bono.bonus.toFixed(2)}. Es una estimación, no un cargo: se aplica el día que pague.`
              : `Pronto pago: pagó al día ${bono.lived} (antes del umbral de ${pol.earlyPayDays} d). Bonificación = cargo × (${tasa}) × ${bono.days} d no usados / 360 = ${bono.bonus.toFixed(2)}.`,
          );
        } else if (sinTiieBono) {
          formula.lines.push(`Pronto pago no estimado: ${missingRateMessage(inv.date, `emisión de ${inv.name}`)}`);
        } else if (productDoc && !vencido && bono.lived >= pol.earlyPayDays) {
          formula.lines.push(
            `Sin bonificación por pronto pago: al ${dateDMY(fechaBono)} ya pasaron ${bono.lived} d desde la emisión y el umbral es ${pol.earlyPayDays} d.`,
          );
        }
        if (sinPolitica) {
          formula.lines.push(missingChargesMessage(inv.policy_code || "(sin política)", politica?.name));
          formula.lines.push("Mientras tanto no se cobra comisión ni FEGA en esta fila: la decisión se captura, no se supone.");
        } else if (vencido && cobra) {
          formula.lines.push(
            `Política de cobro ${politica!.name}: comisión ${cobra.commission ? `sí (${pctRate(tasas.commissionRate)})` : "no"} · FEGA ${cobra.fega ? `sí (${pctRate(tasas.fegaOnlyRate)})` : "no"}.`,
          );
        }
        return {
          ...inv,
          products: lines.filter((l) => l.invoice_id === inv.id),
          serie,
          folio,
          cargo,
          saldo,
          daysOverdue: mora.daysOverdue,
          daysVence: line?.daysVence ?? 0,
          daysVencidos: line?.daysVencidos ?? mora.daysOverdue,
          annualRate: line?.annualRate ?? mora.annualRate,
          liveMora,
          liveFx,
          utCambiaria: fxDiff,
          dueNow,
          abono,
          fechaAbono,
          fechaPago: line?.fechaPago ?? fechaAbono ?? asOf,
          moraDue,
          // Antes del vencimiento no hay interés ni comisión ni FEGA: lo único
          // que se muestra es la bonificación de pronto pago, y con la
          // factura abierta es una estimación al día del corte.
          vencido,
          diasPorVencer: line?.diasPorVencer ?? Math.max(0, -diasVencidos),
          bonificacion: bono.applies ? bono.bonus : 0,
          bonificacionDias: bono.applies ? bono.days : 0,
          bonificacionTasa: bono.applies ? bono.rate : 0,
          bonificacionEstimada: bonoEstimado,
          sinTiieBono,
          // Política de cobro del documento y sus dos interruptores.
          politicaCode: inv.policy_code,
          politicaNombre: politica?.name ?? "",
          cobraComision: cobra?.commission ?? null,
          cobraFega: cobra?.fega ?? null,
          sinPolitica,
          plazo,
          interes: line?.interest ?? mora.interest,
          fega: mora.fega,
          comisionFega: line?.comisionFega ?? 0,
          totalFinanciero: line?.totalFinanciero ?? mora.mora,
          tiie: sinTiie ? null : tiie,
          tiieDate: tiiePick?.date ?? null,
          sinTiie,
          spread: pol.collectionSpread,
          formula: formula.short,
          formulaLines: formula.lines,
          dateErrors: dueCheck.errors,
          dateWarnings: dueCheck.warnings,
        };
      });

      const customerRows = rows.filter((r) => r.kind === "customer");
      const ar = customerRows.reduce((s, r) => s + r.saldo, 0);
      const ap = rows.filter((r) => r.kind === "supplier").reduce((s, r) => s + r.saldo, 0);
      const byCurrency = ["MXN", "USD"].map((cur) => {
        const set = customerRows.filter((r) => (r.currency || "MXN") === cur && (r.inv_class || "product") === "product");
        return {
          currency: cur,
          cargo: set.reduce((s, r) => s + r.cargo, 0),
          abono: set.reduce((s, r) => s + r.abono, 0),
          saldo: set.reduce((s, r) => s + r.saldo, 0),
          interes: set.reduce((s, r) => s + r.interes, 0),
          comisionFega: set.reduce((s, r) => s + r.comisionFega, 0),
          totalFinanciero: set.reduce((s, r) => s + r.totalFinanciero, 0),
          utCambiaria: set.reduce((s, r) => s + r.utCambiaria, 0),
        };
      });
      const byProduct: Record<string, number> = {};
      for (const r of customerRows) {
        if (r.products.length === 0) {
          byProduct[r.origin || r.name] = (byProduct[r.origin || r.name] ?? 0) + r.saldo;
        } else {
          const lineSum = r.products.reduce((s, l) => s + Number(l.amount), 0) || 1;
          for (const l of r.products) {
            byProduct[l.product] = (byProduct[l.product] ?? 0) + r.saldo * (Number(l.amount) / lineSum);
          }
        }
      }

      result.push({ partner, contacts, rows, ar, ap, byProduct, byCurrency });
    }

    const fegaSplit = splitFegaBundle(pol.fegaRate, pol.commissionRate);
    return {
      asOf,
      historico,
      policy: {
        ...pol,
        commissionRate: fegaSplit.commission,
        fegaOnlyRate: fegaSplit.fega,
        fegaBundle: fegaSplit.bundle,
      },
      statements: result,
    };
  });

export async function issueMoraInvoice(
  sql: Sql,
  companyId: number,
  invoiceId: number,
  opts?: { asOf?: string; paidDate?: string | null; requireCharge?: boolean; userId?: string },
) {
  const pol = await policy(sql, companyId);
  await ensureInvoiceExtras(sql);
  const asOf = (opts?.asOf || todayMx()).slice(0, 10);
  const inv = await sql<{
    id: number;
    partner_id: number;
    residual: string;
    amount: string;
    due_date: string;
    credit_due: string | null;
    paid_date: string | null;
    fega_charged: boolean;
    interest_invoiced: string;
    name: string;
    kind: string;
    inv_class: string;
    order_id: number | null;
    policy_code: string;
  }>`
    select id, partner_id, residual::text, amount::text, due_date::text, credit_due::text, paid_date::text,
      fega_charged, interest_invoiced::text, name, kind, coalesce(inv_class,'product') as inv_class, order_id,
      coalesce(policy_code, '') as policy_code
    from invoices where id = ${invoiceId} and company_id = ${companyId}
  `;
  if (!inv[0]) throw new Error("Factura no encontrada");
  // Solo documentos de producto generan mora (ni FI de intereses ni ajustes de TC).
  if (inv[0].kind !== "customer" || inv[0].inv_class !== "product" || Number(inv[0].amount) <= 0) {
    return { name: null as string | null, charge: 0, formula: "" };
  }
  // La mora corre desde el plazo financiero (credit_due, día 150), no desde el
  // vencimiento visible al cliente (due_date, día 120). La TIIE es la vigente
  // en esa fecha. El capital es SIEMPRE el cargo original (regla del Excel).
  const moraDue = inv[0].credit_due || inv[0].due_date;
  const paidDate = opts?.paidDate === undefined ? inv[0].paid_date : opts.paidDate;
  // Primero los días: si no ha vencido no hay mora y no hacen falta ni la TIIE
  // ni la política. Si sí venció, la TIIE tiene que estar en la tabla para esa
  // fecha y la política tiene que decir si cobra comisión y FEGA; sin una de
  // las dos la FI no se genera y se avisa (en un cobro, la transacción
  // completa se revierte).
  const endOverdue = paidDate && paidDate < asOf ? paidDate : asOf;
  const daysOverdue = Math.max(0, daysBetween(moraDue, endOverdue));
  if (daysOverdue <= 0) {
    if (opts?.requireCharge !== false) throw new Error("No hay mora nueva por facturar");
    return { name: null as string | null, charge: 0, formula: `Sin días vencidos al ${asOf} (plazo financiero ${moraDue}).` };
  }
  const tiieRows = await sql<{ date: string; rate: string }>`
    select date::text, rate::text from tiie_rates where company_id = ${companyId} order by date
  `;
  const pick = requireRate(
    tiieRows.map((r) => ({ date: r.date, rate: Number(r.rate) })),
    moraDue,
    `plazo financiero de ${inv[0].name}`,
  );
  const tiie = pick.rate;
  // La política del documento decide si esta FI lleva comisión y si lleva
  // FEGA (los porcentajes siguen siendo los de Ajustes). Sin los dos
  // interruptores capturados NO se emite: la FI es dinero y el sistema no
  // supone. En un cobro, la transacción completa se revierte con este aviso.
  const politica = (await creditPolicyMap(sql, companyId)).get(inv[0].policy_code) ?? null;
  if (!chargesCaptured(politica)) {
    throw new Error(missingChargesMessage(inv[0].policy_code || "(sin política)", politica?.name));
  }
  const cobra = { commission: politica.commission, fega: politica.fega };
  const tasas = chargeRates(pol.fegaRate, pol.commissionRate, cobra);
  const bill = moraBilling({
    cargo: Number(inv[0].amount),
    moraDue,
    asOf,
    paidDate,
    tiieAtDue: tiie,
    spread: pol.collectionSpread,
    fegaRate: tasas.fegaRate,
    interestInvoiced: Number(inv[0].interest_invoiced),
    fegaCharged: inv[0].fega_charged,
  });
  const formula = explainInterest({
    capital: bill.capital,
    days: bill.daysOverdue,
    tiie: bill.tiie,
    tiieDate: pick.date,
    spread: bill.spread,
    interest: bill.interest,
    fega: bill.fega,
    fegaRate: tasas.fegaRate,
    commissionRate: tasas.commissionRate,
    dueDate: moraDue,
    residual: Number(inv[0].residual),
  }).short;
  if (bill.charge <= 0) {
    if (opts?.requireCharge !== false) throw new Error("No hay mora nueva por facturar");
    return { name: null as string | null, charge: 0, formula };
  }
  // La FI guarda su cálculo COMPLETO: aunque mañana cambien la tabla TIIE o
  // los parámetros, este número sigue siendo explicable tal como se emitió.
  const calc = [
    formula,
    `${rateLabel(pick)} vigente al ${moraDue} + spread ${(pol.collectionSpread * 100).toFixed(2)}%`,
    `capital (cargo original) ${Number(inv[0].amount).toFixed(2)} · ${bill.daysOverdue} d vencidos`,
    `interés nuevo ${bill.interestNew.toFixed(2)} (ya facturado antes: ${Number(inv[0].interest_invoiced).toFixed(2)})`,
    `comisión + FEGA ${bill.fegaNew.toFixed(2)} (tasa ${pctRate(tasas.fegaRate)}${inv[0].fega_charged ? ", ya cobrado antes" : ""})`,
    `política ${politica.name}: comisión ${cobra.commission ? "sí" : "no"} · FEGA ${cobra.fega ? "sí" : "no"}`,
  ].join(" · ");
  const n = await sql<{ c: number }>`select count(*)::int as c from invoices where company_id = ${companyId}`;
  const name = `FI-${String((n[0]?.c ?? 0) + 1).padStart(4, "0")}`;
  await sql`
    insert into invoices (
      company_id, kind, name, partner_id, date, due_date, state, amount, residual, origin, inv_class, currency, order_id,
      created_by, calc, int_part, fega_part
    )
    values (
      ${companyId}, 'customer', ${name}, ${inv[0].partner_id}, ${asOf}, ${asOf}, 'open',
      ${bill.charge}, ${bill.charge}, ${"Mora " + inv[0].name}, 'interest', 'MXN', ${inv[0].order_id},
      ${opts?.userId ?? ""}, ${calc}, ${bill.interestNew}, ${bill.fegaNew}
    )
  `;
  // Acumulados por separado: el interés facturado no debe mezclarse con el
  // FEGA, o la siguiente FI cobraría de menos exactamente el FEGA.
  await sql`
    update invoices set
      interest_invoiced = interest_invoiced + ${bill.interestNew},
      fega_charged = fega_charged or ${bill.fegaNew > 0}
    where id = ${inv[0].id}
  `;
  if (opts?.userId) {
    await writeAudit(sql, {
      companyId,
      userId: opts.userId,
      action: "facturar-mora",
      entity: "invoice",
      entityId: inv[0].id,
      name,
      detail: calc,
    });
  }
  return { name, charge: bill.charge, formula };
}

export const invoiceLiveMora = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ invoiceId: z.number(), asOf: z.string().optional() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    await assertCan(sql, context.userId, "credit", "edit");
    // issueMoraInvoice guarda el cálculo en la FI y escribe la bitácora.
    return issueMoraInvoice(sql, cid, data.invoiceId, { asOf: data.asOf, requireCharge: true, userId: context.userId });
  });

export const saveDocument = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      kind: z.string(),
      title: z.string(),
      partnerId: z.number().optional(),
      body: z.string(),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    await assertCan(sql, context.userId, "statements", "edit");
    const row = await sql<{ id: number }>`
      insert into documents (company_id, kind, title, partner_id, body)
      values (${cid}, ${data.kind}, ${data.title}, ${data.partnerId ?? null}, ${data.body})
      returning id
    `;
    return { id: row[0]!.id };
  });

export const listDocuments = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    return sql<{ id: number; kind: string; title: string; created_at: string; partner: string | null }>`
      select d.id, d.kind, d.title, d.created_at::text, p.name as partner
      from documents d
      left join partners p on p.id = d.partner_id
      where d.company_id = ${cid}
      order by d.id desc
      limit 50
    `;
  });
