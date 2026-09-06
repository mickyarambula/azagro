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
 *      dando el precio guardado. El paso 1 no toca el motor, así que la salida
 *      esperada es CERO diferencias — y la misma antes y después de desplegar.
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
  // -------------------------------------------------------------------------
  console.log("\n== 3. Precio implícito (costo puesto + financiamiento + margen guardado) vs precio guardado ==");
  const settings = await q(`select company_id, asr_commission::text as asr_commission from company_settings`);
  const comision = new Map(settings.map((s) => [s.company_id, s.asr_commission == null ? null : Number(s.asr_commission)]));
  const lineas = await q(
    `select ql.id, q.company_id, q.name as cot, p.code as producto, to_jsonb(ql) as r,
            coalesce(q.credit_days,0)::int as dias, coalesce(q.tiie,0)::text as tiie, coalesce(q.spread,0)::text as spread,
            coalesce(q.price_offer,'both') as oferta
     from quote_lines ql join quotes q on q.id = ql.quote_id join products p on p.id = ql.product_id
     order by q.id, ql.id`,
  );
  let ok = 0;
  let sinMargen = 0;
  let noRecalculable = 0;
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
    const com = comision.get(l.company_id);
    let fin;
    if (r.finance_unit != null) fin = num(r.finance_unit);
    else if (l.dias <= 0) fin = 0;
    else if (com == null) {
      noRecalculable += 1;
      continue;
    } else fin = financeUnit({ cost: landed, days: l.dias, tiie: num(l.tiie), costSpread: num(l.spread), commissionRate: com });
    const checks = [];
    try {
      if (mCash && r.cash_price != null) checks.push(["contado", priceFromMargin({ landed, finance: 0, margin: mCash }), num(r.cash_price)]);
      if (mCredit && r.credit_price != null) checks.push(["crédito", priceFromMargin({ landed, finance: fin, margin: mCredit }), num(r.credit_price)]);
    } catch (e) {
      difs.push(`${l.cot} ${l.producto}: ${e.message}`);
      continue;
    }
    let bien = true;
    for (const [cual, implicito, guardado] of checks) {
      if (Math.abs(implicito - guardado) > 0.00501) {
        bien = false;
        difs.push(`${l.cot} ${l.producto} ${cual}: guardado ${fmt(guardado)} · implícito ${fmt(implicito)} (costo puesto ${fmt(landed)}, fin ${fmt(fin)}, plazo ${l.dias} d)`);
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
  console.log(`  Partidas cotizadas: ${lineas.length} · coinciden: ${ok} · sin margen (no se recalculan): ${sinMargen} · sin comisión en Ajustes ni financiamiento guardado: ${noRecalculable} · DIFERENCIAS: ${difs.length}`);
  for (const d of difs) console.log(`  ≠ ${d}`);
  diferenciasPrecio += difs.length;

  // -------------------------------------------------------------------------
  // 4. Instantánea antes/después (precios y totales guardados, folio por folio).
  // -------------------------------------------------------------------------
  const foto = {
    quote_lines: await q(`select id, cash_price::text as cash_price, credit_price::text as credit_price, unit_price::text as unit_price, finance_unit::text as finance_unit from quote_lines order by id`),
    quotes: await q(`select id, name, total::text as total, coalesce(credit_days,0)::int as credit_days from quotes order by id`),
    sales_lines: await q(`select id, so_id, product_id, qty::text as qty, unit_price::text as unit_price from sales_lines order by id`),
    sales_orders: await q(`select id, name, total::text as total, coalesce(credit_days,0)::int as credit_days from sales_orders order by id`),
    invoices: await q(`select id, name, amount::text as amount, residual::text as residual, coalesce(credit_days,0)::int as credit_days from invoices order by id`),
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
        for (const k of Object.keys(r)) {
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
