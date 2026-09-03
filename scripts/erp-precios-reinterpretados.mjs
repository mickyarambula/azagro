#!/usr/bin/env node
/**
 * Solo lectura. Lista qué precios guardados cambiarían de valor al reinterpretar
 * los márgenes guardados con la fórmula del 3-sep-2026:
 *
 *   antes:  precio = costo puesto × (1 + margen %) + financiamiento
 *   ahora:  precio = (costo puesto + financiamiento) ÷ (1 − margen %)
 *
 * El margen en $ fijo da el mismo precio con las dos fórmulas: no aparece.
 * No escribe nada. Uso:  DATABASE_URL=postgres://… node scripts/erp-precios-reinterpretados.mjs
 */
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Falta DATABASE_URL (solo lectura).");
  process.exit(1);
}
const round2 = (n) => Math.round(n * 100) / 100;
const viejo = (landed, fin, pct) => round2(landed * (1 + pct / 100) + fin);
const nuevo = (landed, fin, pct) => (pct < 100 ? round2((landed + fin) / (1 - pct / 100)) : NaN);
const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—");

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  // Cotizaciones: márgenes guardados en % junto con el precio que se guardó.
  const q = await pool.query(`
    select q.name as cot, coalesce(q.state,'') as estado, p.code, ql.qty::text,
      coalesce(ql.cost,0)::text as cost, coalesce(ql.freight,0)::text as freight,
      coalesce(nullif(ql.cash_price,0), ql.unit_price)::text as cash_price,
      coalesce(nullif(ql.credit_price,0), ql.unit_price)::text as credit_price,
      coalesce(ql.finance_unit,0)::text as fin,
      ql.margin_cash_mode, ql.margin_cash_pct::text as cash_pct,
      ql.margin_credit_mode, ql.margin_credit_pct::text as credit_pct,
      (select count(*) from sales_orders so where so.quote_id = q.id)::int as pedidos
    from quote_lines ql join quotes q on q.id = ql.quote_id join products p on p.id = ql.product_id
    order by q.id, ql.id`);
  const filas = [];
  for (const r of q.rows) {
    const landed = Number(r.cost) + Number(r.freight);
    if (landed <= 0) continue;
    if (r.margin_cash_mode === "pct" && r.cash_pct != null) {
      const pct = Number(r.cash_pct);
      const v = viejo(landed, 0, pct);
      const n = nuevo(landed, 0, pct);
      if (Math.abs(v - n) > 0.009) filas.push([r.cot, r.estado, r.code, "contado", `${pct}%`, fmt(Number(r.cash_price)), fmt(v), fmt(n), r.pedidos]);
    }
    if (r.margin_credit_mode === "pct" && r.credit_pct != null) {
      const pct = Number(r.credit_pct);
      const fin = Number(r.fin);
      const v = viejo(landed, fin, pct);
      const n = nuevo(landed, fin, pct);
      if (Math.abs(v - n) > 0.009) filas.push([r.cot, r.estado, r.code, "crédito", `${pct}%`, fmt(Number(r.credit_price)), fmt(v), fmt(n), r.pedidos]);
    }
  }
  console.log("COTIZACIONES — partidas con margen % cuyo precio implícito cambia (el precio guardado NO se toca solo):");
  console.log(["folio", "estado", "producto", "columna", "margen", "precio guardado", "con fórmula vieja", "con fórmula nueva", "pedidos"].join(" | "));
  for (const f of filas) console.log(f.join(" | "));
  if (!filas.length) console.log("(ninguna)");

  // Solicitudes sin cotizar: no guardan precio; la pantalla lo calcula del margen.
  const s = await pool.query(`
    select r.name as sol, p.code, coalesce(l.cost,0)::text as cost, coalesce(l.freight,0)::text as freight,
      coalesce(r.credit_days,0)::int as dias,
      l.margin_cash_mode, l.margin_cash_pct::text as cash_pct, l.margin_credit_mode, l.margin_credit_pct::text as credit_pct
    from customer_request_lines l join customer_requests r on r.id = l.request_id join products p on p.id = l.product_id
    where r.quote_id is null
    order by r.id, l.id`);
  const sol = [];
  for (const r of s.rows) {
    const landed = Number(r.cost) + Number(r.freight);
    if (landed <= 0) continue;
    for (const [col, mode, pctText] of [["contado", r.margin_cash_mode, r.cash_pct], ["crédito", r.margin_credit_mode, r.credit_pct]]) {
      if (mode !== "pct" || pctText == null || Number(pctText) === 0) continue;
      sol.push([r.sol, r.code, col, `${Number(pctText)}%`, fmt(viejo(landed, 0, Number(pctText))), fmt(nuevo(landed, 0, Number(pctText))), r.dias]);
    }
  }
  console.log("\nSOLICITUDES abiertas — el precio que muestra la pantalla cambia (sin financiamiento; a crédito cambia más):");
  console.log(["solicitud", "producto", "columna", "margen", "antes", "ahora", "plazo"].join(" | "));
  for (const f of sol) console.log(f.join(" | "));
  if (!sol.length) console.log("(ninguna)");
} finally {
  await pool.end();
}
