#!/usr/bin/env node
/**
 * Solo lectura. Contesta "¿hay una factura duplicada o es correcto?" con datos
 * reales, sin tocar nada.
 *
 * Para cada factura de cliente muestra de qué pedido nació (origin / order_id)
 * y el total de ese pedido, y marca tres cosas distintas que se confunden:
 *
 *   [DUPLICADA]   dos FV vivas del MISMO pedido — eso sí es un error.
 *   [PEDIDO GEMELO] dos PEDIDOS distintos con el mismo cliente y el mismo
 *                 importe: no es factura duplicada, es que se levantó dos veces.
 *   [≠ PEDIDO]    la factura no vale lo mismo que su pedido (el pedido se editó
 *                 después de facturar, o la factura vino del corte Compaq).
 *
 * También explica los folios: FV-#### se numera con el COUNT de todas las
 * facturas de cliente (incluidas FI de mora y ATC de tipo de cambio), así que
 * FV-0002 no tiene por qué venir de PV-0002. Los folios saltan.
 *
 * Uso:  DATABASE_URL=postgres://… node scripts/erp-facturas-repetidas.mjs [CLIENTE]
 *   CLIENTE = código o parte del nombre (p. ej. "SL AGRICOLA"). Sin filtro: todos.
 */
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Falta DATABASE_URL (solo lectura).");
  process.exit(1);
}
const filtro = (process.argv[2] || "").trim().toUpperCase();
const fmt = (n) => Number(n).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  const inv = await pool.query(
    `select i.id, i.name, i.date::text as date, i.amount::text as amount, i.residual::text as residual,
            coalesce(i.inv_class,'product') as clase, coalesce(i.origin,'') as origin,
            i.order_id, coalesce(i.currency,'MXN') as currency,
            p.code as partner_code, p.name as partner,
            so.name as pedido, so.total::text as pedido_total, so.state as pedido_estado
     from invoices i
     join partners p on p.id = i.partner_id
     left join sales_orders so on so.id = i.order_id
     where i.kind = 'customer'
       and ($1 = '' or upper(p.code) like '%'||$1||'%' or upper(p.name) like '%'||$1||'%')
     order by p.name, i.id`,
    [filtro],
  );

  // Dos FV de producto colgadas del mismo pedido: eso sí es duplicado.
  const porPedido = new Map();
  for (const r of inv.rows) {
    if (r.clase !== "product" || !r.order_id || !r.name.startsWith("FV-")) continue;
    porPedido.set(r.order_id, [...(porPedido.get(r.order_id) ?? []), r.name]);
  }
  // Pedidos distintos con el mismo cliente y el mismo importe.
  const gemelos = await pool.query(
    `select p.name as partner, so.total::text as total, count(*)::int as n,
            string_agg(so.name, ', ' order by so.name) as pedidos
     from sales_orders so join partners p on p.id = so.partner_id
     where ($1 = '' or upper(p.code) like '%'||$1||'%' or upper(p.name) like '%'||$1||'%')
     group by p.name, so.total having count(*) > 1
     order by p.name`,
    [filtro],
  );
  const gemeloDe = new Set();
  for (const g of gemelos.rows) for (const n of g.pedidos.split(", ")) gemeloDe.add(n);

  console.log("FACTURAS DE CLIENTE — de qué pedido nació cada una");
  console.log(["cliente", "factura", "clase", "fecha", "importe", "saldo", "origen", "pedido", "total del pedido", "marcas"].join(" | "));
  for (const r of inv.rows) {
    const marcas = [];
    if (r.order_id && (porPedido.get(r.order_id) ?? []).length > 1) marcas.push(`DUPLICADA (${porPedido.get(r.order_id).join(" y ")} del mismo pedido)`);
    if (r.pedido && gemeloDe.has(r.pedido)) marcas.push("PEDIDO GEMELO");
    if (r.pedido_total != null && Math.abs(Number(r.amount) - Number(r.pedido_total)) > 0.009 && r.clase === "product" && r.name.startsWith("FV-")) {
      marcas.push(`≠ PEDIDO (factura ${fmt(r.amount)} vs pedido ${fmt(r.pedido_total)})`);
    }
    console.log(
      [
        `${r.partner_code} ${r.partner}`,
        r.name,
        r.clase,
        r.date,
        `${fmt(r.amount)} ${r.currency}`,
        fmt(r.residual),
        r.origin || "—",
        r.pedido ?? "—",
        r.pedido_total != null ? fmt(r.pedido_total) : "—",
        marcas.join(" · ") || "",
      ].join(" | "),
    );
  }

  if (gemelos.rows.length) {
    console.log("\nPEDIDOS CON EL MISMO CLIENTE Y EL MISMO IMPORTE (dos capturas de lo mismo, o dos ventas iguales de verdad):");
    for (const g of gemelos.rows) console.log(`  ${g.partner} · ${fmt(g.total)} · ${g.n} pedidos: ${g.pedidos}`);
  } else {
    console.log("\nNo hay dos pedidos del mismo cliente con el mismo importe.");
  }

  const dups = [...porPedido.entries()].filter(([, v]) => v.length > 1);
  console.log(
    dups.length
      ? `\nFACTURAS DUPLICADAS DE VERDAD (dos FV del mismo pedido): ${dups.map(([id, v]) => `pedido ${id} → ${v.join(", ")}`).join(" · ")}`
      : "\nNinguna factura duplicada: ningún pedido tiene dos FV.",
  );

  // Por qué los folios no cuadran con los del pedido.
  const clases = await pool.query(
    `select coalesce(inv_class,'product') as clase, count(*)::int as n
     from invoices where kind = 'customer' group by 1 order by 1`,
  );
  console.log(
    `\nFolios: FV-#### se numera con el total de facturas de CLIENTE (${clases.rows.map((c) => `${c.clase} ${c.n}`).join(", ")}),` +
      " así que FV-0002 no corresponde a PV-0002. Los folios saltan cuando entre medio salió una FI de mora o un ATC de tipo de cambio.",
  );
} finally {
  await pool.end();
}
