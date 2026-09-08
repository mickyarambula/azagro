#!/usr/bin/env node
/**
 * Solo lectura. Dos preguntas, con datos reales, antes de que suba el paso 3
 * (Decisión 14: la deuda con el proveedor nace al RECIBIR, no al capturar la
 * orden de compra).
 *
 *   1. ¿Cuántas facturas de proveedor existen hoy de órdenes que todavía no se
 *      reciben? Son las que nacieron con el defecto viejo. La Decisión 23 dice
 *      que se MARCAN — ni se revierten ni se dejan calladas — y la marca se
 *      deriva de esto mismo: se limpia sola al recibir o al cancelar la orden.
 *
 *   2. ¿A cuántos proveedores CON ÓRDENES ABIERTAS les falta el plazo de pago?
 *      Desde el paso 3, recibir se detiene si el proveedor no tiene plazo
 *      capturado (antes se colaba un coalesce(payment_days,0) que decía
 *      "contado" sin que nadie lo hubiera capturado). Esta lista es a quién
 *      hay que capturarle el plazo ANTES de desplegar, para que nadie se
 *      quede con el camión en la puerta.
 *
 * Uso:  DATABASE_URL=... node scripts/erp-fp-sin-recibir.mjs
 * No escribe nada. Ni un update, ni un insert.
 */
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Falta DATABASE_URL (solo lectura).");
  process.exit(1);
}
const fmt = (n) => Number(n).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  // ---------------------------------------------------------------------
  // 1) Facturas de proveedor de mercancía que todavía no llega.
  // ---------------------------------------------------------------------
  const fps = await pool.query(
    `select i.id, i.name, i.date::text as fecha, i.due_date::text as vence,
            i.amount::text as importe, i.residual::text as saldo, i.state as estado,
            coalesce(i.currency,'MXN') as moneda,
            p.name as proveedor, coalesce(p.payment_days::text,'SIN PLAZO') as plazo,
            po.name as oc, po.state as oc_estado,
            coalesce(po.fulfill_kind,'inventory') as tipo
     from invoices i
     join partners p on p.id = i.partner_id
     join purchase_orders po on po.company_id = i.company_id and po.name = i.origin
     where i.kind = 'supplier'
       and po.state not in ('done','cancelled')
     order by i.due_date, i.id`,
  );

  console.log("=".repeat(78));
  console.log("1) FACTURAS DE PROVEEDOR DE MERCANCÍA QUE TODAVÍA NO LLEGA");
  console.log("=".repeat(78));
  if (!fps.rows.length) {
    console.log("Ninguna. No hay nada que marcar: el defecto viejo no dejó rastro en esta base.");
  } else {
    let total = 0;
    let vivo = 0;
    for (const r of fps.rows) {
      total += Number(r.importe);
      if (r.estado !== "paid") vivo += Number(r.saldo);
      const alerta = r.plazo === "SIN PLAZO" ? "  [PROVEEDOR SIN PLAZO]" : "";
      const brokeraje = r.tipo === "direct" ? "  [DIRECTA/BROKERAJE]" : "";
      console.log(
        `${r.name.padEnd(9)} ${r.fecha}  vence ${r.vence}  ${fmt(r.importe).padStart(13)} ${r.moneda}` +
          `  saldo ${fmt(r.saldo).padStart(13)}  ${r.estado.padEnd(8)}` +
          `  ${r.oc} (${r.oc_estado})  ${r.proveedor}${brokeraje}${alerta}`,
      );
    }
    console.log("-".repeat(78));
    console.log(`TOTAL: ${fps.rows.length} factura(s) · importe ${fmt(total)} · saldo vivo ${fmt(vivo)}`);
    console.log(
      "Se marcan solas en el tablero y en Cartera → Por pagar, y la marca desaparece\n" +
        "cuando esa orden se reciba (o se cancele, en el paso 4). No hay que tocar nada a mano.",
    );
  }

  // ---------------------------------------------------------------------
  // 2) Proveedores con órdenes abiertas y sin plazo de pago capturado.
  //    Éstos son los que van a topar con el candado nuevo al recibir.
  // ---------------------------------------------------------------------
  const sinPlazo = await pool.query(
    `select p.id, p.code, p.name,
            count(*)::int as ocs,
            sum(po.total)::text as importe,
            min(po.date)::text as mas_vieja,
            bool_or(coalesce(po.fulfill_kind,'inventory') = 'direct') as tiene_directas
     from purchase_orders po
     join partners p on p.id = po.partner_id
     where po.state not in ('done','cancelled')
       and p.payment_days is null
     group by p.id, p.code, p.name
     order by count(*) desc, p.name`,
  );

  console.log();
  console.log("=".repeat(78));
  console.log("2) PROVEEDORES CON ÓRDENES ABIERTAS Y SIN PLAZO DE PAGO CAPTURADO");
  console.log("=".repeat(78));
  if (!sinPlazo.rows.length) {
    console.log("Ninguno. Todos los proveedores con órdenes abiertas ya tienen plazo capturado:");
    console.log("nadie se va a quedar sin poder recibir.");
  } else {
    for (const r of sinPlazo.rows) {
      console.log(
        `${(r.code || "").padEnd(10)} ${String(r.name).padEnd(34)}  ${String(r.ocs).padStart(3)} orden(es)` +
          `  ${fmt(r.importe).padStart(13)}  desde ${r.mas_vieja}${r.tiene_directas ? "  [con directas]" : ""}`,
      );
    }
    console.log("-".repeat(78));
    console.log(`TOTAL: ${sinPlazo.rows.length} proveedor(es) a los que hay que capturarles el plazo.`);
    console.log(
      "Captúralo en la ficha del proveedor ANTES de desplegar (0 = contado).\n" +
        "Si no, al recibir su mercancía el sistema se va a detener y va a pedir ese dato.",
    );
  }
  console.log();
} finally {
  await pool.end();
}
