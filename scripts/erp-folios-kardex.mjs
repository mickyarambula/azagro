#!/usr/bin/env node
/**
 * Solo lectura. Radiografía de los folios del kardex (stock_moves.ref) antes de
 * separar el contador por serie (patrón A4, opción C: tabla folio_counters).
 *
 * Hoy el folio es `PREFIJO/NNNN` con un contador ÚNICO por empresa para los
 * siete tipos (src/lib/erp/stock.ts nextRef: count(*) + 1). Este script no
 * toca nada: solo SELECT. Reporta, por empresa:
 *
 *   1. Refs que no cumplen ^(REC|ENT|TR|AJ|INI|DEV|REV)/\d{4,}$ — uno por uno.
 *      (y aparte: refs cuyo prefijo no corresponde a su move_type)
 *   2. Números usados por más de un prefijo — la huella de dos clics
 *      simultáneos de tipos distintos.
 *   3. count(*) contra max(número). Si max < count, hubo choque entre series.
 *   4. El máximo por serie: la semilla exacta que escribiría la migración.
 *   5. Total de movimientos y desde qué fecha.
 *
 * Uso:  DATABASE_URL=postgres://… node scripts/erp-folios-kardex.mjs
 */
import { fileURLToPath } from "node:url";

export const REF_PATTERN = "^(REC|ENT|TR|AJ|INI|DEV|REV)/[0-9]{4,}$";
export const PREFIX_OF = { receipt: "REC", delivery: "ENT", internal: "TR", adjust: "AJ", opening: "INI", return: "DEV", reversal: "REV" };

/**
 * Corre la radiografía con cualquier `query(text, params) → { rows }` (pg o
 * PGlite) y devuelve las secciones ya calculadas, sin imprimir. Solo SELECT.
 */
export async function radiografia(query) {
  const companies = (await query(`select id, name from companies order by id`)).rows;
  const out = [];
  for (const c of companies) {
    const p = [c.id, REF_PATTERN];
    // 1. Formato.
    const malformed = (
      await query(
        `select id, ref, move_type, date::text as date, origin
         from stock_moves where company_id = $1 and ref !~ $2 order by id`,
        p,
      )
    ).rows;
    // 1b. Prefijo que no corresponde al tipo (extra: la semilla se agrupa por prefijo).
    const wrongPrefix = (
      await query(
        `select id, ref, move_type from stock_moves
         where company_id = $1 and ref ~ $2
           and split_part(ref, '/', 1) <> case move_type
             when 'receipt' then 'REC' when 'delivery' then 'ENT' when 'internal' then 'TR'
             when 'adjust' then 'AJ' when 'opening' then 'INI' when 'return' then 'DEV'
             when 'reversal' then 'REV' else '' end
         order by id`,
        p,
      )
    ).rows;
    // 2. Un número en más de una serie.
    const shared = (
      await query(
        `select num, count(*)::int as n, string_agg(ref, ', ' order by ref) as refs
         from (select split_part(ref, '/', 2)::int as num, ref from stock_moves where company_id = $1 and ref ~ $2) t
         group by num having count(distinct split_part(ref, '/', 1)) > 1
         order by num`,
        p,
      )
    ).rows;
    // 3 y 5. Conteo global contra máximo global; fechas.
    const totals = (
      await query(
        `select count(*)::int as total,
                count(*) filter (where ref ~ $2)::int as bien_formados,
                max(case when ref ~ $2 then split_part(ref, '/', 2)::int end) as max_num,
                min(case when ref ~ $2 then split_part(ref, '/', 2)::int end) as min_num,
                min(date)::text as desde, max(date)::text as hasta
         from stock_moves where company_id = $1`,
        p,
      )
    ).rows[0];
    // 4. Máximo por serie: la semilla.
    const bySeries = (
      await query(
        `select split_part(ref, '/', 1) as serie, count(*)::int as n,
                max(split_part(ref, '/', 2)::int) as max_num, min(split_part(ref, '/', 2)::int) as min_num
         from stock_moves where company_id = $1 and ref ~ $2
         group by 1 order by 1`,
        p,
      )
    ).rows;
    out.push({ company: c, malformed, wrongPrefix, shared, totals, bySeries });
  }
  return out;
}

export function imprimir(secciones) {
  const lines = [];
  const say = (s = "") => lines.push(s);
  if (!secciones.length) say("No hay empresas.");
  for (const s of secciones) {
    const t = s.totals;
    say(`══ EMPRESA ${s.company.id} · ${s.company.name} ══`);
    say(`5. Movimientos: ${t.total} en total (${t.bien_formados} con formato PREFIJO/NNNN)` + (t.total ? ` · desde ${t.desde} hasta ${t.hasta}` : ""));
    say("");
    say(`1. Refs con formato distinto a ${REF_PATTERN}: ${s.malformed.length}`);
    for (const m of s.malformed) say(`   id ${m.id} · ${JSON.stringify(m.ref)} · ${m.move_type} · ${m.date} · origen ${m.origin || "—"}`);
    say(`   (extra) Refs cuyo prefijo no corresponde a su tipo: ${s.wrongPrefix.length}`);
    for (const w of s.wrongPrefix) say(`   id ${w.id} · ${w.ref} · move_type=${w.move_type} (prefijo esperado ${PREFIX_OF[w.move_type] ?? "?"})`);
    say("");
    say(`2. Números usados por más de un prefijo: ${s.shared.length}`);
    for (const r of s.shared) say(`   ${String(r.num).padStart(4, "0")} → ${r.refs}`);
    say("");
    if (t.total === 0) {
      say("3. count(*) = 0: nada que comparar.");
    } else {
      const veredicto = t.max_num == null ? "sin refs bien formados" : t.max_num < t.total ? "max < count → HUBO choque entre series alguna vez" : t.max_num === t.total ? "max = count → nunca chocó" : "max > count → hay huecos en la numeración global (¿renglones borrados?)";
      say(`3. count(*) = ${t.total} · max(número) = ${t.max_num ?? "—"} · min = ${t.min_num ?? "—"} → ${veredicto}`);
    }
    say("");
    say("4. Máximo por serie (la semilla de folio_counters):");
    say("   serie | movimientos | max | min");
    for (const b of s.bySeries) say(`   ${b.serie.padEnd(5)} | ${String(b.n).padStart(11)} | ${String(b.max_num).padStart(4, "0")} | ${String(b.min_num).padStart(4, "0")}`);
    for (const pref of Object.values(PREFIX_OF)) if (!s.bySeries.some((b) => b.serie === pref)) say(`   ${pref.padEnd(5)} | ${"0".padStart(11)} |    — |    —   (sin movimientos: la semilla nace en 0)`);
    say("");
  }
  return lines.join("\n");
}

const esCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (esCli) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("Falta DATABASE_URL (solo lectura).");
    process.exit(1);
  }
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const client = await pool.connect();
    try {
      // Solo lectura, de verdad: la transacción se declara READ ONLY.
      await client.query("begin read only");
      const secciones = await radiografia((text, params) => client.query(text, params));
      await client.query("rollback");
      console.log(imprimir(secciones));
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
