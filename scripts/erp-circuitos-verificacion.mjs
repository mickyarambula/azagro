#!/usr/bin/env node
/**
 * Solo lectura. Verificación del PASO 1 del catálogo de circuitos (etiqueta
 * `circuit_code` en solicitudes, cotizaciones, pedidos y facturas; migración
 * 0025). No escribe nada en la base; lo único que puede escribir es un archivo
 * local de instantánea si se le pide con --guardar.
 *
 * Contesta tres cosas:
 *
 *   1. CUÁNTOS documentos quedaron en cada circuito, por tabla (y cuántos sin
 *      circuito, que deberían ser cero en documentos de cliente).
 *   2. Si la etiqueta es CONSISTENTE con la regla decidida (plazo 0 → Contado;
 *      lo demás → ASR; corte de Compaq → ASR; FI/ATC/NC → el de su origen;
 *      FP sin circuito). Lo que no cuadre se lista para revisarlo, no truena:
 *      a partir del paso 2 un circuito elegido a mano puede diferir de la regla.
 *   3. Que el PRECIO IMPLÍCITO de cada partida cotizada (costo puesto +
 *      financiamiento + margen guardado, con la misma fórmula del motor) sigue
 *      dando el precio guardado. Desde el paso 3 el financiamiento se
 *      recalcula con la COMISIÓN CONGELADA en la cotización
 *      (quotes.commission_rate, migración 0026) y con la base del circuito
 *      del documento (ASR: costo × (1 + comisión); lineal: costo + margen).
 *      Todo lo existente corre por ASR y su comisión congelada es la misma
 *      que la lectura en vivo daba, así que la salida esperada sigue siendo
 *      CERO diferencias — y la misma antes y después de desplegar.
 *   3b. Cuántas cotizaciones quedaron SIN comisión congelada (esperado: 0
 *      después de la 0026; las que queden se detienen al repreciar, no
 *      inventan una).
 *   5. NÚCLEO DEL P&L POR PEDIDO (paso 4): con lo congelado en la factura (o
 *      en la cotización, o el catálogo) se rehace, pedido por pedido, la
 *      parte del P&L que no depende del día de hoy — venta, costo, flete,
 *      comisión, Capa 1, margen; y en el lineal, financiamiento de Santa
 *      Rosa, costo real de la línea y protección. Entra a la instantánea:
 *      antes/después de desplegar el paso 4 tiene que dar lo mismo. Quedan
 *      fuera a propósito la Capa 2 (días excedidos), la mora, el pronto pago
 *      y el TC: cambian con la fecha y con los cobros, no con el paso 4.
 *
 * Antes/después exacto: corre con --guardar antes de desplegar y con
 * --comparar después; la comparación es partida por partida, folio por folio.
 *
 * Uso:
 *   DATABASE_URL=postgres://… node scripts/erp-circuitos-verificacion.mjs
 *   DATABASE_URL=… node scripts/erp-circuitos-verificacion.mjs --guardar antes.json
 *   DATABASE_URL=… node scripts/erp-circuitos-verificacion.mjs --comparar antes.json
 *
 * Sale con código 1 solo si hay diferencias de precio (implícito vs guardado,
 * o contra la instantánea). Las anomalías de etiqueta se listan y no cambian
 * el código de salida.
 */
import pg from "pg";
import { readFileSync, writeFileSync } from "node:fs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Falta DATABASE_URL (solo lectura).");
  process.exit(1);
}
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const guardar = flag("--guardar");
const comparar = flag("--comparar");

// ---------------------------------------------------------------------------
// Copia literal de las fórmulas del motor (pricing.ts / margins.ts), igual que
// en scripts/erp-escalera.test.mjs. Aquí no hay número de negocio: el 360 es
// la base de días del interés (regla 1 de CLAUDE.md) y el 100 es el límite
// aritmético del margen sobre el precio.
// ---------------------------------------------------------------------------
const YEAR_DAYS = 360;
const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (x) => Math.round(x * 10000) / 10000;
const num = (v) => (v == null || v === "" ? 0 : Number(v));
function financeUnit(i) {
  if (i.days <= 0) return 0;
  const cost = Math.max(0, i.cost);
  const rate = i.tiie + i.costSpread;
  const commission = round2(cost * Math.max(0, i.commissionRate));
  const layer1 = round2((cost * (1 + Math.max(0, i.commissionRate)) * rate * Math.max(0, i.days)) / YEAR_DAYS);
  return commission + layer1;
}
function marginOf(row, which) {
  const mode = which === "cash" ? row.margin_cash_mode : row.margin_credit_mode;
  const pct = which === "cash" ? row.margin_cash_pct : row.margin_credit_pct;
  const nominal = which === "cash" ? row.margin_cash_nominal : row.margin_credit_nominal;
  if ((mode === "pct" || mode === "nominal") && (pct != null || nominal != null)) {
    return { mode, pct: num(pct), nominal: num(nominal), legacy: false };
  }
  if ((row.margin_mode === "pct" || row.margin_mode === "nominal") && (row.margin_pct != null || row.margin_nominal != null)) {
    return { mode: row.margin_mode, pct: num(row.margin_pct), nominal: num(row.margin_nominal), legacy: true };
  }
  return null;
}
function marginValid(m) {
  return m != null && (m.mode === "nominal" || m.pct < 100);
}
function marginUnit(m, landed, finance = 0) {
  if (m.mode === "nominal") return m.nominal;
  if (!marginValid(m)) throw new Error(`Margen ${Number(m.pct)}% sobre el precio: tiene que ser menor a 100%.`);
  const base = landed + Math.max(0, finance);
  return (base * m.pct) / (100 - m.pct);
}
function priceFromMargin(i) {
  const fin = Math.max(0, i.finance);
  return round4(i.landed + fin + marginUnit(i.margin, i.landed, fin));
}
// cost.ts: orden único del costo (kardex → referencia → ninguno).
function resolveCost(i) {
  const avg = Number(i.avgCost) || 0;
  if (avg > 0) return { cost: avg, source: "kardex" };
  const ref = Number(i.refCost) || 0;
  if (ref > 0) return { cost: ref, source: "referencia" };
  return { cost: 0, source: "ninguno" };
}
// credit.ts: comisión + Capa 1 (+ Capa 2, que aquí siempre va en 0).
function financeCost(input) {
  const cost = Math.max(0, input.supplierCost);
  const rate = input.tiieAtIssue + input.costSpread;
  const commission = round2(cost * Math.max(0, input.commissionRate));
  const layer1 = round2((cost * (1 + Math.max(0, input.commissionRate)) * rate * Math.max(0, input.financialDays)) / YEAR_DAYS);
  const layer2 = round2((Math.max(0, input.saleCapital) * rate * Math.max(0, input.daysExceeded)) / YEAR_DAYS);
  return { rate, commission, layer1, layer2, total: round2(commission + layer1 + layer2) };
}
// pricing.ts: inverso del lineal (para partidas sin disbursed_unit guardado).
function linealMarginFromPrice(i) {
  const k = i.days > 0 ? (Math.max(0, i.rate) * i.days) / YEAR_DAYS : 0;
  const disbursed = round4(Math.max(0, i.price) / (1 + k));
  const nominal = round4(disbursed - Math.max(0, i.landed));
  const pct = disbursed > 0 ? round4((nominal / disbursed) * 100) : 0;
  return { mode: i.mode, pct, nominal, disbursed, finance: round4(Math.max(0, i.price) - disbursed) };
}
// Lineal (paso 3): la factura a Santa Rosa (costo + margen) × (1 + k).
function linealPriceFromMargin(i) {
  const disbursed = round4(Math.max(0, i.landed) + marginUnit(i.margin, Math.max(0, i.landed), 0));
  const finance = i.days <= 0 ? 0 : round2((disbursed * Math.max(0, i.rate) * Math.max(0, i.days)) / YEAR_DAYS);
  return { disbursed, finance, price: round4(disbursed + finance) };
}

const fmt = (n) => Number(n).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const etiqueta = { CONTADO: "Contado", ASR: "Circuito ASR", SANTA_ROSA: "Línea Santa Rosa", PROPIA: "Línea propia" };
const nombre = (c) => (c == null ? "(sin circuito)" : (etiqueta[c] ?? `(desconocido: ${c})`));

const pool = new pg.Pool({ connectionString: url, max: 1 });
let diferenciasPrecio = 0;
try {
  const q = async (text, params = []) => (await pool.query(text, params)).rows;

  // -------------------------------------------------------------------------
  // 0. ¿Ya corrió la migración 0025?
  // -------------------------------------------------------------------------
  const tablas = ["customer_requests", "quotes", "sales_orders", "invoices"];
  const conColumna = new Set(
    (
      await q(
        `select table_name from information_schema.columns where column_name = 'circuit_code' and table_name = any($1)`,
        [tablas],
      )
    ).map((r) => r.table_name),
  );
  const migrada = tablas.every((t) => conColumna.has(t));
  console.log(migrada ? "Migración 0025: aplicada (circuit_code en las cuatro tablas)." : `Migración 0025: TODAVÍA NO (falta circuit_code en ${tablas.filter((t) => !conColumna.has(t)).join(", ")}). Esta corrida es el "antes".`);

  // -------------------------------------------------------------------------
  // 1. Conteo por circuito.
  // -------------------------------------------------------------------------
  if (migrada) {
    console.log("\n== 1. Documentos por circuito ==");
    const bloques = [
      ["Solicitudes", `select circuit_code as c, count(*)::int as n from customer_requests group by 1 order by 1`],
      ["Cotizaciones", `select circuit_code as c, count(*)::int as n from quotes group by 1 order by 1`],
      ["Pedidos", `select circuit_code as c, count(*)::int as n from sales_orders group by 1 order by 1`],
      ["Facturas de cliente (FV, corte, NC, FI, ATC)", `select circuit_code as c, count(*)::int as n from invoices where kind = 'customer' group by 1 order by 1`],
      ["Facturas de proveedor (deben ir sin circuito)", `select circuit_code as c, count(*)::int as n from invoices where kind = 'supplier' group by 1 order by 1`],
    ];
    for (const [titulo, sql] of bloques) {
      const rows = await q(sql);
      console.log(`  ${titulo}:`);
      if (!rows.length) console.log("    (sin renglones)");
      for (const r of rows) console.log(`    ${nombre(r.c).padEnd(18)} ${String(r.n).padStart(6)}`);
    }
    const porClase = await q(
      `select coalesce(inv_class,'product') as clase, case when origin = 'Corte Compaq' then 'corte' when amount < 0 then 'nc' else 'fv' end as tipo,
              circuit_code as c, count(*)::int as n
       from invoices where kind = 'customer' group by 1, 2, 3 order by 1, 2, 3`,
    );
    console.log("  Facturas de cliente por clase:");
    for (const r of porClase) console.log(`    ${`${r.clase}/${r.tipo}`.padEnd(18)} ${nombre(r.c).padEnd(18)} ${String(r.n).padStart(6)}`);
  }

  // -------------------------------------------------------------------------
  // 2. Consistencia con la regla.
  // -------------------------------------------------------------------------
  if (migrada) {
    console.log("\n== 2. Etiquetas que no cuadran con la regla (revisar; no es error a partir del paso 2) ==");
    const anomalias = [];
    for (const [t, folio] of [["customer_requests", "name"], ["quotes", "name"], ["sales_orders", "name"]]) {
      const rows = await q(
        `select ${folio} as folio, credit_days as dias_capturado, coalesce(credit_days,0)::int as dias, circuit_code as c from ${t}
         where circuit_code is null
            or (coalesce(credit_days,0) > 0 and circuit_code = 'CONTADO')
            or (coalesce(credit_days,0) = 0 and circuit_code <> 'CONTADO')
         order by id`,
      );
      for (const r of rows) {
        // Una solicitud sin plazo capturado nace SIN circuito a propósito
        // (decisión del dueño, 5-sep-2026): no es una anomalía, es el estado
        // de espera. Solo se compara contra la regla cuando ya hay plazo.
        if (t === "customer_requests" && r.c == null && r.dias_capturado == null) continue;
        anomalias.push(`${t}: ${r.folio} plazo ${r.dias} d → ${nombre(r.c)}`);
      }
    }
    const inv = await q(
      `select i.name, i.origin, coalesce(i.inv_class,'product') as clase, i.amount::text as amount, coalesce(i.credit_days,0)::int as dias,
              i.circuit_code as c, so.circuit_code as c_pedido,
              (select o.circuit_code from invoices o where o.company_id = i.company_id and o.kind = 'customer' and coalesce(o.inv_class,'product') = 'product'
                 and i.origin in ('Mora ' || o.name, 'Ajuste TC ' || o.name) limit 1) as c_origen
       from invoices i left join sales_orders so on so.id = i.order_id
       where i.kind = 'customer' order by i.id`,
    );
    for (const r of inv) {
      const esCorte = r.origin === "Corte Compaq";
      const esNc = r.clase === "product" && Number(r.amount) < 0;
      const esDerivada = r.clase === "interest" || r.clase === "fx";
      let esperado;
      if (esCorte) esperado = "ASR";
      else if (esDerivada) esperado = r.c_origen ?? null;
      else if (esNc) esperado = r.c_pedido ?? null;
      else esperado = r.dias > 0 ? "ASR" : "CONTADO";
      if (r.c == null) anomalias.push(`invoices: ${r.name} (${r.clase}${esCorte ? ", corte" : ""}) sin circuito`);
      else if (esperado == null) anomalias.push(`invoices: ${r.name} (${r.clase}) → ${nombre(r.c)}, sin origen para comparar ("${r.origin}")`);
      else if (r.c !== esperado) anomalias.push(`invoices: ${r.name} (${r.clase}${esCorte ? ", corte" : esNc ? ", NC" : ""}, plazo ${r.dias} d) → ${nombre(r.c)}, la regla diría ${nombre(esperado)}`);
    }
    const fp = await q(`select name, circuit_code as c from invoices where kind = 'supplier' and circuit_code is not null order by id`);
    for (const r of fp) anomalias.push(`invoices: ${r.name} es de proveedor y trae ${nombre(r.c)}`);
    if (!anomalias.length) console.log("  Ninguna: todas las etiquetas cuadran con la regla.");
    for (const a of anomalias) console.log(`  ${a}`);
  }

  // -------------------------------------------------------------------------
  // 3. Precio implícito de cada partida cotizada vs el guardado.
  //    Paso 3: comisión CONGELADA en la cotización; base por circuito.
  // -------------------------------------------------------------------------
  console.log("\n== 3. Precio implícito (costo puesto + financiamiento + margen guardado) vs precio guardado ==");
  const qcols = (await q(`select column_name from information_schema.columns where table_name = 'quotes'`)).map((r) => r.column_name);
  const congelada = qcols.includes("commission_rate");
  console.log(congelada ? "  Migración 0026: aplicada (comisión congelada en quotes.commission_rate)." : "  Migración 0026: TODAVÍA NO. La comisión se toma de Ajustes / catálogo (lectura en vivo, como antes del paso 3).");
  // Comisión de respaldo para el "antes": Ajustes (si la columna existe) o el catálogo ASR.
  const settings = await q(
    `select cs.company_id, ${(await q(`select 1 from information_schema.columns where table_name = 'company_settings' and column_name = 'asr_commission'`)).length ? "cs.asr_commission::text" : "null"} as asr_commission,
            (select c.commission_rate::text from credit_circuits c where c.company_id = cs.company_id and c.code = 'ASR') as asr_catalogo
     from company_settings cs`,
  );
  const comisionViva = new Map(settings.map((s) => [s.company_id, s.asr_commission != null ? Number(s.asr_commission) : s.asr_catalogo != null ? Number(s.asr_catalogo) : null]));
  const lineas = await q(
    `select ql.id, q.company_id, q.name as cot, p.code as producto, to_jsonb(ql) as r,
            coalesce(q.credit_days,0)::int as dias, coalesce(q.tiie,0)::text as tiie, coalesce(q.spread,0)::text as spread,
            coalesce(q.price_offer,'both') as oferta, ${migrada ? "q.circuit_code" : "null"} as circuito,
            ${congelada ? "q.commission_rate::text" : "null"} as comision_congelada
     from quote_lines ql join quotes q on q.id = ql.quote_id join products p on p.id = ql.product_id
     order by q.id, ql.id`,
  );
  let ok = 0;
  let sinMargen = 0;
  let noRecalculable = 0;
  let sinCongelar = 0;
  const difs = [];
  for (const l of lineas) {
    const r = l.r;
    const landed = num(r.cost) + num(r.freight) + num(r.other_cost);
    const mCash = marginOf(r, "cash");
    const mCredit = marginOf(r, "credit");
    if (!mCash && !mCredit) {
      sinMargen += 1;
      continue;
    }
    const lineal = l.circuito === "SANTA_ROSA";
    // Comisión: la congelada manda; si no hay (antes de la 0026), la viva.
    const com = l.comision_congelada != null ? Number(l.comision_congelada) : comisionViva.get(l.company_id) ?? null;
    if (congelada && l.comision_congelada == null && l.dias > 0) sinCongelar += 1;
    const rate = num(l.tiie) + num(l.spread);
    const checks = [];
    try {
      if (mCash && r.cash_price != null) checks.push(["contado", priceFromMargin({ landed, finance: 0, margin: mCash }), num(r.cash_price)]);
      if (mCredit && r.credit_price != null) {
        if (lineal) {
          checks.push(["crédito (lineal)", linealPriceFromMargin({ landed, margin: mCredit, rate, days: l.dias }).price, num(r.credit_price)]);
        } else {
          let fin;
          if (r.finance_unit != null) fin = num(r.finance_unit);
          else if (l.dias <= 0) fin = 0;
          else if (com == null) {
            noRecalculable += 1;
            continue;
          } else fin = financeUnit({ cost: landed, days: l.dias, tiie: num(l.tiie), costSpread: num(l.spread), commissionRate: com });
          checks.push(["crédito", priceFromMargin({ landed, finance: fin, margin: mCredit }), num(r.credit_price)]);
        }
      }
    } catch (e) {
      difs.push(`${l.cot} ${l.producto}: ${e.message}`);
      continue;
    }
    let bien = true;
    for (const [cual, implicito, guardado] of checks) {
      if (Math.abs(implicito - guardado) > 0.00501) {
        bien = false;
        difs.push(`${l.cot} ${l.producto} ${cual}: guardado ${fmt(guardado)} · implícito ${fmt(implicito)} (costo puesto ${fmt(landed)}, plazo ${l.dias} d, comisión ${com == null ? "—" : com})`);
      }
    }
    // El precio del documento es el de la oferta: contado, o crédito (contado si no hay).
    const unit = l.oferta === "cash" ? num(r.cash_price) : num(r.credit_price) || num(r.cash_price);
    if (r.unit_price != null && Math.abs(unit - num(r.unit_price)) > 0.00501) {
      bien = false;
      difs.push(`${l.cot} ${l.producto} documento: unit_price ${fmt(r.unit_price)} ≠ precio de la oferta ${l.oferta} ${fmt(unit)}`);
    }
    if (bien) ok += 1;
  }
  console.log(`  Partidas cotizadas: ${lineas.length} · coinciden: ${ok} · sin margen (no se recalculan): ${sinMargen} · sin comisión ni financiamiento guardado: ${noRecalculable} · DIFERENCIAS: ${difs.length}`);
  for (const d of difs) console.log(`  ≠ ${d}`);
  diferenciasPrecio += difs.length;
  if (congelada) {
    const sinCong = await q(`select count(*)::int as n from quotes where commission_rate is null`);
    const conCong = await q(`select count(*)::int as n from quotes where commission_rate is not null`);
    console.log(`\n== 3b. Comisión congelada (0026) == cotizaciones con comisión congelada: ${conCong[0].n} · sin congelar: ${sinCong[0].n} (esperado 0; partidas a crédito afectadas: ${sinCongelar})`);
  }

  // -------------------------------------------------------------------------
  // 5. Núcleo del P&L por pedido (paso 4): lo que no depende del día de hoy.
  // -------------------------------------------------------------------------
  console.log("\n== 5. Núcleo del P&L por pedido (con lo congelado; sin Capa 2, mora, pronto pago ni TC) ==");
  const has = async (table, col) => (await q(`select 1 from information_schema.columns where table_name = $1 and column_name = $2`, [table, col])).length > 0;
  const hasSnap = await has("invoices", "params_snap");
  const hasSoId = await has("purchase_orders", "so_id");
  const hasRef = await has("products", "ref_cost");
  const hasOther = await has("quote_lines", "other_cost");
  const hasDisb = await has("quote_lines", "disbursed_unit");
  const hasQRates = await has("quotes", "cost_rate");
  const hasCircuit = await has("sales_orders", "circuit_code");
  const spreadVivo = new Map((await q(`select company_id, asr_spread::text as s from company_settings`)).map((r) => [r.company_id, r.s == null ? null : Number(r.s)]));
  const tiieTabla = await q(`select company_id, date::text as date, rate::text as rate from tiie_rates order by date`);
  const nearest = (cid, asOf) => {
    let pick = null;
    for (const r of tiieTabla) if (r.company_id === cid && r.date <= asOf) pick = Number(r.rate);
    return pick;
  };
  const pedidos = await q(
    `select so.id, so.company_id, so.name, so.date::text as date, coalesce(so.credit_days,0)::int as credit_days, so.quote_id,
            ${hasCircuit ? "so.circuit_code" : "null"} as circuito,
            (select i.date::text from invoices i where i.company_id = so.company_id and i.order_id = so.id and i.kind = 'customer' and i.name like 'FV-%' order by i.id desc limit 1) as fv_date,
            (select coalesce(i.credit_days,0)::int from invoices i where i.company_id = so.company_id and i.order_id = so.id and i.kind = 'customer' and i.name like 'FV-%' order by i.id desc limit 1) as fv_days,
            ${hasSnap ? "(select i.params_snap from invoices i where i.company_id = so.company_id and i.order_id = so.id and i.kind = 'customer' and i.name like 'FV-%' order by i.id desc limit 1)" : "null"} as snap,
            (select q.commission_rate::text from quotes q where q.id = so.quote_id) as q_commission,
            ${hasQRates ? "(select q.cost_rate::text from quotes q where q.id = so.quote_id)" : "null"} as q_cost_rate,
            ${hasQRates ? "(select q.collection_rate::text from quotes q where q.id = so.quote_id)" : "null"} as q_collection_rate,
            (select c.commission_rate::text from credit_circuits c where c.company_id = so.company_id and c.code = 'ASR') as asr_catalogo
     from sales_orders so order by so.id`,
  );
  const partidas = await q(
    `select sl.so_id, sl.product_id, p.code, sl.qty::text as qty, sl.unit_price::text as unit_price,
            p.cost::text as catalog_cost, ${hasRef ? "coalesce(p.ref_cost,0)::text" : "'0'"} as ref_cost,
            ${hasSoId ? "(select pl.unit_price::text from purchase_lines pl join purchase_orders po on po.id = pl.po_id where po.so_id = sl.so_id and pl.product_id = sl.product_id order by pl.id desc limit 1)" : "null"} as po_cost,
            ql.cost::text as quote_cost, coalesce(ql.freight,0)::text as quote_freight,
            ${hasOther ? "coalesce(ql.other_cost,0)::text" : "'0'"} as quote_other,
            ${hasDisb ? "ql.disbursed_unit::text" : "null"} as quote_disbursed
     from sales_lines sl
     join products p on p.id = sl.product_id
     join sales_orders so on so.id = sl.so_id
     left join quote_lines ql on ql.quote_id = so.quote_id and ql.product_id = sl.product_id
     order by sl.so_id, sl.id`,
  );
  const pnlRows = [];
  for (const so of pedidos) {
    let snap = {};
    try {
      if (so.snap) snap = JSON.parse(so.snap);
    } catch {
      snap = {};
    }
    const days = snap.financialDays ?? (so.fv_date != null ? so.fv_days : so.credit_days);
    const spread = snap.costSpread ?? spreadVivo.get(so.company_id) ?? null;
    const tiie = snap.tiieIssue ?? nearest(so.company_id, so.fv_date ?? so.date);
    const lineal = (snap.financingBase ?? (so.circuito === "SANTA_ROSA" ? "costo_margen" : "costo_comision")) === "costo_margen";
    const comision = snap.commissionRate ?? (so.q_commission != null ? Number(so.q_commission) : so.asr_catalogo != null ? Number(so.asr_catalogo) : null);
    const costRate = snap.costRate ?? (so.q_cost_rate != null ? Number(so.q_cost_rate) : null);
    const acc = { venta: 0, costo: 0, flete: 0, otros: 0, comision: 0, capa1: 0, margen: 0, financSR: 0, costoLinea: 0, proteccion: 0, excluidas: 0 };
    let protKnown = true;
    for (const l of partidas.filter((x) => x.so_id === so.id)) {
      const qty = num(l.qty);
      const saleUnit = num(l.unit_price);
      const po = l.po_cost != null ? Number(l.po_cost) : null;
      const qc = l.quote_cost != null && Number(l.quote_cost) > 0 ? Number(l.quote_cost) : null;
      const cat = resolveCost({ avgCost: l.catalog_cost, refCost: l.ref_cost });
      const sinCosto = po == null && qc == null && cat.source === "ninguno";
      const necesitaTiie = days > 0 && !lineal;
      if (sinCosto || (necesitaTiie && (tiie == null || spread == null || comision == null))) {
        acc.excluidas += 1;
        continue;
      }
      const costUnit = po ?? qc ?? cat.cost;
      const freightUnit = num(l.quote_freight);
      const otherUnit = num(l.quote_other);
      const sale = qty * saleUnit;
      const cogs = qty * costUnit;
      const freight = qty * freightUnit;
      const other = qty * otherUnit;
      const landed = cogs + freight + other;
      if (!lineal) {
        const fin = days > 0 ? financeCost({ supplierCost: landed, saleCapital: sale, commissionRate: comision, costSpread: spread, tiieAtIssue: tiie, financialDays: days, daysExceeded: 0 }) : { commission: 0, layer1: 0 };
        acc.venta += sale;
        acc.comision += fin.commission;
        acc.capa1 += fin.layer1;
        acc.margen += sale - cogs - freight - other;
      } else {
        const rate = (tiie ?? 0) + (spread ?? 0);
        const perUnit = l.quote_disbursed != null ? Number(l.quote_disbursed) : days > 0 ? linealMarginFromPrice({ price: saleUnit, landed: costUnit + freightUnit + otherUnit, rate, days, mode: "pct" }).disbursed : saleUnit;
        const disbursed = qty * perUnit;
        const financSR = round2(sale - disbursed);
        acc.venta += disbursed;
        acc.margen += disbursed - cogs - freight - other;
        acc.financSR += financSR;
        if (days > 0 && costRate != null) {
          const costoLinea = round2((disbursed * (costRate + (spread ?? 0)) * days) / YEAR_DAYS);
          acc.costoLinea += costoLinea;
          acc.proteccion += round2(financSR - costoLinea);
        } else if (days > 0) protKnown = false;
      }
      acc.costo += cogs;
      acc.flete += freight;
      acc.otros += other;
    }
    pnlRows.push({
      id: so.id,
      name: so.name,
      circuito: so.circuito ?? "",
      base: lineal ? "costo_margen" : "costo_comision",
      venta: acc.venta.toFixed(2),
      costo: acc.costo.toFixed(2),
      flete: acc.flete.toFixed(2),
      comision: acc.comision.toFixed(2),
      capa1: acc.capa1.toFixed(2),
      margen: acc.margen.toFixed(2),
      financ_sr: acc.financSR.toFixed(2),
      costo_linea: lineal ? (protKnown ? acc.costoLinea.toFixed(2) : "sin dato") : acc.comision + acc.capa1 > 0 ? (acc.comision + acc.capa1).toFixed(2) : "0.00",
      proteccion: lineal ? (protKnown ? acc.proteccion.toFixed(2) : "sin dato") : "0.00",
      excluidas: acc.excluidas,
    });
  }
  console.log(`  Pedidos: ${pnlRows.length}`);
  for (const r of pnlRows) {
    console.log(
      `  ${r.name.padEnd(9)} ${nombre(r.circuito || null).padEnd(18)} venta ${fmt(r.venta)} · costo ${fmt(r.costo)} · flete ${fmt(r.flete)} · comisión ${fmt(r.comision)} · Capa 1 ${fmt(r.capa1)} · margen ${fmt(r.margen)}${
        r.base === "costo_margen" ? ` · financ. S. Rosa ${fmt(r.financ_sr)} · costo real ${r.costo_linea === "sin dato" ? r.costo_linea : fmt(r.costo_linea)} · protección ${r.proteccion === "sin dato" ? r.proteccion : fmt(r.proteccion)}` : " · protección 0.00"
      }${r.excluidas ? ` · ${r.excluidas} partida(s) fuera (sin costo o sin tasa)` : ""}`,
    );
  }

  // -------------------------------------------------------------------------
  // 4. Instantánea antes/después (precios y totales guardados, folio por folio).
  // -------------------------------------------------------------------------
  const foto = {
    quote_lines: await q(`select id, cash_price::text as cash_price, credit_price::text as credit_price, unit_price::text as unit_price, finance_unit::text as finance_unit from quote_lines order by id`),
    quotes: await q(`select id, name, total::text as total, coalesce(credit_days,0)::int as credit_days${congelada ? ", commission_rate::text as commission_rate, cost_rate::text as cost_rate, collection_rate::text as collection_rate" : ""} from quotes order by id`),
    sales_lines: await q(`select id, so_id, product_id, qty::text as qty, unit_price::text as unit_price from sales_lines order by id`),
    sales_orders: await q(`select id, name, total::text as total, coalesce(credit_days,0)::int as credit_days from sales_orders order by id`),
    invoices: await q(`select id, name, amount::text as amount, residual::text as residual, coalesce(credit_days,0)::int as credit_days from invoices order by id`),
    // Paso 4: el núcleo del P&L por pedido también se compara antes/después.
    pnl: pnlRows,
  };
  if (guardar) {
    writeFileSync(guardar, JSON.stringify(foto, null, 1));
    console.log(`\n== 4. Instantánea guardada en ${guardar} (${Object.entries(foto).map(([k, v]) => `${k}: ${v.length}`).join(", ")}) ==`);
  }
  if (comparar) {
    const antes = JSON.parse(readFileSync(comparar, "utf8"));
    console.log(`\n== 4. Comparación contra ${comparar} ==`);
    let cambios = 0;
    for (const [tabla, rows] of Object.entries(foto)) {
      const previas = new Map((antes[tabla] ?? []).map((r) => [r.id, r]));
      for (const r of rows) {
        const p = previas.get(r.id);
        if (!p) {
          // Documento nuevo después de la instantánea: no es diferencia del paso 1.
          continue;
        }
        // Solo las columnas que la instantánea vieja conocía: una columna nueva
        // (p. ej. commission_rate de la 0026) no es una diferencia de precio.
        for (const k of Object.keys(r)) {
          if (!(k in p)) continue;
          if (String(r[k] ?? "") !== String(p[k] ?? "")) {
            cambios += 1;
            if (cambios <= 40) console.log(`  ≠ ${tabla} id ${r.id}${r.name ? ` (${r.name})` : ""} ${k}: ${p[k]} → ${r[k]}`);
          }
        }
      }
      const desaparecidos = [...previas.keys()].filter((id) => !rows.some((r) => r.id === id));
      if (desaparecidos.length) {
        cambios += desaparecidos.length;
        console.log(`  ≠ ${tabla}: ${desaparecidos.length} renglón(es) de la instantánea ya no están (ids ${desaparecidos.slice(0, 10).join(", ")})`);
      }
    }
    console.log(cambios ? `  DIFERENCIAS contra la instantánea: ${cambios}` : "  Cero diferencias contra la instantánea: ningún precio ni total cambió.");
    diferenciasPrecio += cambios;
  }

  console.log(`\nRESULTADO: ${diferenciasPrecio === 0 ? "cero diferencias de precio" : `${diferenciasPrecio} diferencia(s) de precio`}.`);
} finally {
  await pool.end();
}
process.exit(diferenciasPrecio === 0 ? 0 : 1);
