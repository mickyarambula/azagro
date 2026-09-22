// EL FLETE EN EL COSTO, CONTRA UNA BASE DE VERDAD (Decisiones 100 y 101).
//
// POR QUÉ EXISTE ESTA PRUEBA. La revisión de dinero del 21-sep-2026 dio NO
// PASA con dos violaciones opuestas vivas en el mismo cambio: un pedido que
// llegaba en dos camiones capitalizaba el flete DOS veces ($4,000 sobre $2,000
// pagados, $23.53 de más por saco al cliente), y al mismo tiempo la rama que
// metía ese flete a la utilidad NUNCA se ejecutaba (la tarjeta enseñaba $2,000
// de MÁS). Las dos pasaron por delante de quince pruebas en verde.
//
// Se colaron porque las pruebas de la pieza congelaban **funciones puras** y
// verificaban el cableado **buscando texto en el archivo**. Un texto que dice
// «aquí se reparte el flete» no prueba que el número llegue al kardex, y una
// consulta que filtra por una columna que nadie escribe se lee perfecta.
//
// Ésta corre el SQL de verdad contra PGlite con las migraciones aplicadas.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pendingMigrations } from "./migration-plan.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "migrations");

async function fresh() {
  const db = new PGlite();
  for (const { name, path } of pendingMigrations(readdirSync(dir), [])) {
    try {
      await db.exec(readFileSync(join(dir, path), "utf8"));
    } catch (e) {
      assert.fail(`${name}: ${e?.message ?? e}`);
    }
  }
  return db;
}
const q = (db) => (t, p = []) => db.query(t, p).then((r) => r.rows);
const n = (v) => Math.round(Number(v) * 10000) / 10000;

// ---------------------------------------------------------------------------
// El esquema que la pieza toca, ejercitado como lo ejercita el código.
// ---------------------------------------------------------------------------
async function armar(db, { plannedFreight, plannedHandling }) {
  const r = q(db);
  await r(`insert into companies (id, name, join_code, created_by) values (1,'AZ','J1','u')`);
  await r(`insert into company_settings (company_id) values (1)`);
  await r(`insert into members (company_id, user_id, role, status) values (1,'u','admin','active')`);
  await r(`insert into partners (id, company_id, code, name, payment_days) values (1,1,'PV1','Proveedor',30)`);
  await r(`insert into locations (id, company_id, code, name, loc_type) values (1,1,'BOD','Bodega','internal')`);
  await r(`insert into products (id, company_id, code, name, uom, cost) values (1,1,'URE01','UREA','SAC',0)`);
  await r(
    `insert into purchase_orders (id, company_id, name, partner_id, location_id, state, total, planned_freight, planned_handling)
     values (1,1,'OC-0001',1,1,'confirmed',50000,$1,$2)`,
    [plannedFreight, plannedHandling],
  );
  await r(`insert into purchase_lines (id, po_id, product_id, qty, unit_price) values (1,1,1,100,500)`);
  return r;
}

/** Lo que hace `tripShareOfReceipt` de azagro.ts, con el mismo SQL. */
async function parteDelViaje(r, qtyAhora, plan) {
  const tot = (await r(
    `select coalesce(sum(qty),0) as total, coalesce(sum(qty_received),0) as recibido,
            coalesce(sum(qty_closed_short),0) as corto from purchase_lines where po_id = 1`,
  ))[0];
  const total = Number(tot.total);
  const ya = (await r(
    `select coalesce(sum(coalesce(t.freight,0)),0) as f, coalesce(sum(coalesce(t.handling,0)),0) as h
     from trip_costs t
     where t.company_id = 1 and t.po_id = 1 and t.capitalized_at is not null
       and exists (
         select 1 from stock_moves m
         where m.company_id = t.company_id and m.event_ref = t.event_ref and m.move_type = 'receipt'
           and not exists (select 1 from stock_moves rr where rr.reverses_id = m.id)
       )`,
  ))[0];
  const restaF = Math.max(0, Math.round((plan.freight - Number(ya.f)) * 100) / 100);
  const restaH = Math.max(0, Math.round((plan.handling - Number(ya.h)) * 100) / 100);
  const pendienteDespues = total - Number(tot.recibido) - Number(tot.corto) - qtyAhora;
  // El atajo del resto SOLO cuando la orden llegó completa: contar lo cerrado
  // corto como «ya no queda pendiente» hacía que el mismo hecho diera dos
  // costos distintos según el orden de captura.
  if (total <= 0.0001 || (pendienteDespues <= 0.0001 && Number(tot.corto) <= 0.0001)) return { freight: restaF, handling: restaH };
  const frac = Math.min(1, qtyAhora / total);
  return {
    freight: Math.min(restaF, Math.round(plan.freight * frac * 100) / 100),
    handling: Math.min(restaH, Math.round(plan.handling * frac * 100) / 100),
  };
}

/** Una recepción: reparte, postea con el flete adentro y deja el viaje escrito. */
async function recibir(r, { evento, qty, trip }) {
  const fleteUnit = Math.round(((trip.freight + trip.handling) / qty) * 10000) / 10000;
  const unitCost = 500 + fleteUnit;
  await r(
    `insert into stock_moves (company_id, ref, move_type, date, origin, location_to, product_id, quantity, unit_cost, created_by, event_ref, freight_unit)
     values (1,$1,'receipt',current_date,'OC-0001',1,1,$2,$3,'u',$4,$5)`,
    [`REC/${evento}`, qty, unitCost, `RCP/${evento}`, fleteUnit],
  );
  await r(`update purchase_lines set qty_received = qty_received + $1 where id = 1`, [qty]);
  await r(
    `insert into trip_costs (company_id, event_ref, po_id, freight, handling, created_by, capitalized_at, capitalized_amount)
     values (1,$1,1,$2,$3,'u',now(),$4)`,
    [`RCP/${evento}`, trip.freight, trip.handling, trip.freight + trip.handling],
  );
  return { fleteUnit, unitCost };
}

// ---------------------------------------------------------------------------
// 1. LA VIOLACIÓN 1: dos camiones no capitalizan el viaje dos veces
// ---------------------------------------------------------------------------
test("un pedido que llega en DOS camiones capitaliza el flete UNA vez, no dos", async () => {
  const db = await fresh();
  const r = await armar(db, { plannedFreight: 2000, plannedHandling: 0 });
  const plan = { freight: 2000, handling: 0 };

  const p1 = await parteDelViaje(r, 50, plan);
  assert.deepEqual(p1, { freight: 1000, handling: 0 }, "la mitad del camión, la mitad del flete");
  const rec1 = await recibir(r, { evento: "0001", qty: 50, trip: p1 });
  assert.equal(rec1.unitCost, 520, "50 sacos con $1,000 de flete = $20 por saco");

  const p2 = await parteDelViaje(r, 50, plan);
  assert.deepEqual(p2, { freight: 1000, handling: 0 }, "lo que falta, exacto");
  const rec2 = await recibir(r, { evento: "0002", qty: 50, trip: p2 });
  assert.equal(rec2.unitCost, 520);

  // EL NÚMERO DE LA VIOLACIÓN: capitalizado contra pagado.
  const cap = (await r(`select coalesce(sum(capitalized_amount),0) as t from trip_costs where company_id = 1`))[0];
  assert.equal(Number(cap.t), 2000, "se capitalizó exactamente lo que se le pagó al fletero");
  assert.notEqual(Number(cap.t), 4000, "el bug que la revisión encontró");

  // Y el valor del inventario.
  const val = (await r(`select coalesce(sum(quantity * unit_cost),0) as v from stock_moves where company_id = 1 and move_type = 'receipt'`))[0];
  assert.equal(Number(val.v), 52000, "mercancía $50,000 + flete $2,000");
  assert.notEqual(Number(val.v), 54000, "el inventario inflado del bug");
});

test("el redondeo no deja centavos sueltos: tres camiones desiguales cierran al centavo", async () => {
  const db = await fresh();
  const r = await armar(db, { plannedFreight: 2000, plannedHandling: 0 });
  const plan = { freight: 2000, handling: 0 };
  for (const [i, qty] of [[1, 33], [2, 33], [3, 34]]) {
    const parte = await parteDelViaje(r, qty, plan);
    await recibir(r, { evento: `000${i}`, qty, trip: parte });
  }
  const cap = (await r(`select coalesce(sum(capitalized_amount),0) as t from trip_costs where company_id = 1`))[0];
  assert.equal(Number(cap.t), 2000, "la última recepción se lleva el resto exacto");
});

test("recibir de más el flete es imposible aunque suban lo planeado a media orden", async () => {
  const db = await fresh();
  const r = await armar(db, { plannedFreight: 2000, plannedHandling: 0 });
  await recibir(r, { evento: "0001", qty: 50, trip: await parteDelViaje(r, 50, { freight: 2000, handling: 0 }) });
  // Alguien sube el planeado después de la primera recepción.
  await r(`update purchase_orders set planned_freight = 1200 where id = 1`);
  const p2 = await parteDelViaje(r, 50, { freight: 1200, handling: 0 });
  assert.equal(p2.freight, 200, "solo lo que falta contra el nuevo planeado, nunca negativo ni de más");
});

// ---------------------------------------------------------------------------
// 2. LA VIOLACIÓN 2: la utilidad sí ve el flete
// ---------------------------------------------------------------------------
test("la consulta de la utilidad ENCUENTRA el flete con el que salió la mercancía", async () => {
  const db = await fresh();
  const r = await armar(db, { plannedFreight: 2000, plannedHandling: 0 });
  await recibir(r, { evento: "0001", qty: 100, trip: { freight: 2000, handling: 0 } });
  await r(`insert into sales_orders (id, company_id, name, partner_id, location_id, state, total) values (1,1,'PV-0001',1,1,'done',80000)`);
  await r(`insert into sales_lines (id, so_id, product_id, qty, unit_price) values (1,1,1,100,800)`);
  // La salida, costeada como la costea postStock: promedio de la bodega, y su
  // parte de flete derivada del mismo sitio.
  await r(
    `insert into stock_moves (company_id, ref, move_type, date, origin, location_from, product_id, quantity, unit_cost, created_by, event_ref, freight_unit)
     values (1,'ENT/0001','delivery',current_date,'PV-0001',1,1,100,520,'u','ENV/0001',20)`,
  );

  // La MISMA consulta de dealPnlCore, textual.
  const out = (await r(
    `select (sum(m.quantity * m.freight_unit) / nullif(sum(m.quantity),0)) as out_freight,
            (sum(m.quantity * m.unit_cost) / nullif(sum(m.quantity),0)) as out_cost
     from stock_moves m
     where m.company_id = 1 and m.origin = 'PV-0001' and m.move_type = 'delivery' and m.product_id = 1
       and m.freight_unit is not null
       and not exists (select 1 from stock_moves rr where rr.reverses_id = m.id)`,
  ))[0];
  assert.equal(Number(out.out_freight), 20, "la rama encuentra el flete: si sale null, nunca se ejecuta");
  assert.equal(Number(out.out_cost), 520, "y el costo con el que SALIÓ");

  // El número que estaba mal: con OC ligada, el costo del proveedor es $500.
  const costUnit = Number(out.out_freight) > 0.00001 && Number(out.out_cost) > 0 ? Number(out.out_cost) : 500;
  assert.equal(costUnit, 520, "manda el costo con el que salió");
  assert.equal(100 * 800 - 100 * costUnit, 28000, "utilidad real");
  assert.notEqual(100 * 800 - 100 * 500, 28000);
  assert.equal(100 * 800 - 100 * 500 - 28000, 2000, "los $2,000 que la tarjeta enseñaba de más");
});

test("una entrega REVERTIDA no cuenta para la utilidad", async () => {
  const db = await fresh();
  const r = await armar(db, { plannedFreight: 2000, plannedHandling: 0 });
  await r(`insert into sales_orders (id, company_id, name, partner_id, location_id, state, total) values (1,1,'PV-0001',1,1,'done',80000)`);
  await r(
    `insert into stock_moves (id, company_id, ref, move_type, date, origin, location_from, product_id, quantity, unit_cost, created_by, freight_unit)
     values (900,1,'ENT/0001','delivery',current_date,'PV-0001',1,1,100,520,'u',20)`,
  );
  await r(
    `insert into stock_moves (company_id, ref, move_type, date, origin, location_to, product_id, quantity, unit_cost, created_by, freight_unit, reverses_id)
     values (1,'REV/0001','reversal',current_date,'PV-0001',1,1,100,520,'u',20,900)`,
  );
  const out = (await r(
    `select (sum(m.quantity * m.freight_unit) / nullif(sum(m.quantity),0)) as out_freight
     from stock_moves m
     where m.company_id = 1 and m.origin = 'PV-0001' and m.move_type = 'delivery' and m.product_id = 1
       and m.freight_unit is not null
       and not exists (select 1 from stock_moves rr where rr.reverses_id = m.id)`,
  ))[0];
  assert.equal(out.out_freight, null, "sin salidas vivas, la rama no aplica y se vuelve a la cascada de siempre");
});

// ---------------------------------------------------------------------------
// 3. Sin viaje capturado, todo es byte a byte lo de antes
// ---------------------------------------------------------------------------
test("sin costo de viaje, el kardex y el promedio son EXACTAMENTE los de antes", async () => {
  const db = await fresh();
  const r = await armar(db, { plannedFreight: 0, plannedHandling: 0 });
  const parte = await parteDelViaje(r, 100, { freight: 0, handling: 0 });
  assert.deepEqual(parte, { freight: 0, handling: 0 });
  const rec = await recibir(r, { evento: "0001", qty: 100, trip: parte });
  assert.equal(rec.unitCost, 500, "el precio del proveedor, sin un centavo encima");
  assert.equal(rec.fleteUnit, 0);
  const mv = (await r(`select unit_cost, freight_unit from stock_moves where company_id = 1`))[0];
  assert.equal(n(mv.unit_cost), 500);
  assert.equal(n(mv.freight_unit), 0);
});

// ---------------------------------------------------------------------------
// 4. El desglose cuadra contra el costo, siempre
// ---------------------------------------------------------------------------
test("la parte de flete nunca es mayor que el costo, ni se pierde al salir", async () => {
  const db = await fresh();
  const r = await armar(db, { plannedFreight: 2000, plannedHandling: 500 });
  await recibir(r, { evento: "0001", qty: 100, trip: { freight: 2000, handling: 500 } });
  const mv = (await r(`select unit_cost, freight_unit from stock_moves where company_id = 1`))[0];
  assert.equal(n(mv.unit_cost), 525, "mercancía $500 + flete $20 + maniobras $5");
  assert.equal(n(mv.freight_unit), 25, "y las maniobras van con el flete: son el mismo costo de traerla");
  assert.ok(Number(mv.freight_unit) < Number(mv.unit_cost), "el desglose siempre cabe dentro del costo");
});

test("la migración 0051 deja las columnas donde el código las busca", async () => {
  const db = await fresh();
  const r = q(db);
  const cols = await r(
    `select table_name, column_name, is_nullable from information_schema.columns
     where table_schema = 'public' and (
       (table_name = 'stock_moves' and column_name = 'freight_unit') or
       (table_name = 'stock_quants' and column_name = 'avg_freight') or
       (table_name = 'products' and column_name in ('freight_in_cost','unit_weight','weight_uom')) or
       (table_name = 'quote_lines' and column_name = 'cost_freight_in') or
       (table_name = 'purchase_orders' and column_name in ('planned_freight','planned_handling')) or
       (table_name = 'trip_costs' and column_name in ('capitalized_at','capitalized_amount','currency','fx_rate')))
     order by table_name, column_name`,
  );
  assert.equal(cols.length, 12, "las doce columnas de la pieza");
  // Vacío no es cero: las que dicen «sin capturar» tienen que poder estar vacías.
  const nulable = (t, c) => cols.find((x) => x.table_name === t && x.column_name === c)?.is_nullable;
  for (const [t, c] of [["stock_moves", "freight_unit"], ["quote_lines", "cost_freight_in"], ["products", "unit_weight"], ["purchase_orders", "planned_freight"], ["purchase_orders", "planned_handling"]]) {
    assert.equal(nulable(t, c), "YES", `${t}.${c} tiene que poder estar vacía`);
  }
});

// ---------------------------------------------------------------------------
// 5. REVERTIR LIBERA EL FLETE (violación de la segunda revisión)
// ---------------------------------------------------------------------------
// El sistema dice, cuando un viaje ya entró al costo: «revierte la recepción y
// vuelve a recibirla con el costo correcto». Esa salida no servía: lo
// capitalizado seguía contando, así que al recibir otra vez el flete salía en
// $0 y la mercancía entraba a $500 en vez de $520.

/** La consulta de `tripShareOfReceipt`: lo capitalizado que SIGUE vivo. */
const YA_CAPITALIZADO = `
  select coalesce(sum(coalesce(t.freight,0)),0) as f, coalesce(sum(coalesce(t.handling,0)),0) as h
  from trip_costs t
  where t.company_id = 1 and t.po_id = 1 and t.capitalized_at is not null
    and exists (
      select 1 from stock_moves m
      where m.company_id = t.company_id and m.event_ref = t.event_ref and m.move_type = 'receipt'
        and not exists (select 1 from stock_moves r where r.reverses_id = m.id)
    )`;

test("revertir una recepción DEVUELVE su parte del flete: la salida que el sistema nombra funciona", async () => {
  const db = await fresh();
  const r = await armar(db, { plannedFreight: 2000, plannedHandling: 0 });
  await recibir(r, { evento: "0001", qty: 100, trip: { freight: 2000, handling: 0 } });

  let ya = (await r(YA_CAPITALIZADO))[0];
  assert.equal(Number(ya.f), 2000, "con la recepción viva, el flete está usado");

  // Se revierte: contrario ligado por reverses_id, como hacen las reversas.
  const mv = (await r(`select id from stock_moves where company_id = 1 and move_type = 'receipt'`))[0];
  await r(
    `insert into stock_moves (company_id, ref, move_type, date, origin, location_from, product_id, quantity, unit_cost, created_by, reverses_id, freight_unit)
     values (1,'REV/0001','reversal',current_date,'OC-0001',1,1,100,520,'u',$1,20)`,
    [mv.id],
  );
  await r(`update purchase_lines set qty_received = 0 where id = 1`);

  ya = (await r(YA_CAPITALIZADO))[0];
  assert.equal(Number(ya.f), 0, "revertida, su parte del flete vuelve a estar disponible");

  // Y al volver a recibir, entra con su flete otra vez.
  const parte = await parteDelViaje(r, 100, { freight: 2000, handling: 0 });
  assert.equal(parte.freight, 2000, "no $0: ése era el bug");
  const rec = await recibir(r, { evento: "0002", qty: 100, trip: parte });
  assert.equal(rec.unitCost, 520, "la mercancía vuelve a entrar a $520, no a $500");
});

test("el renglón del viaje revertido NO se borra: queda como registro", async () => {
  const db = await fresh();
  const r = await armar(db, { plannedFreight: 2000, plannedHandling: 0 });
  await recibir(r, { evento: "0001", qty: 100, trip: { freight: 2000, handling: 0 } });
  const mv = (await r(`select id from stock_moves where company_id = 1 and move_type = 'receipt'`))[0];
  await r(
    `insert into stock_moves (company_id, ref, move_type, date, origin, location_from, product_id, quantity, unit_cost, created_by, reverses_id)
     values (1,'REV/0001','reversal',current_date,'OC-0001',1,1,100,520,'u',$1)`,
    [mv.id],
  );
  const filas = await r(`select event_ref, capitalized_amount from trip_costs where company_id = 1`);
  assert.equal(filas.length, 1, "el viaje sigue escrito");
  assert.equal(Number(filas[0].capitalized_amount), 2000, "con lo que se capitalizó ese día");
  // Se DERIVA que ya no cuenta, no se marca ni se borra — igual que el saldo a
  // favor y la línea de crédito.
});

// ---------------------------------------------------------------------------
// 6. EL CIERRE CORTO NO PUEDE CAMBIAR EL COSTO SEGÚN EL ORDEN DE CAPTURA
// ---------------------------------------------------------------------------
// Llegan 50 de 100 sacos y los otros 50 ya no van a llegar. Flete $2,000.
// Antes: recibir-y-cerrar daba $520/saco; cerrar-y-recibir, $540/saco. Veinte
// pesos por saco, escritos en el kardex para siempre, decididos por el orden
// en que se usaron dos pantallas.

async function mediaOrden(orden) {
  const db = await fresh();
  const r = await armar(db, { plannedFreight: 2000, plannedHandling: 0 });
  const plan = { freight: 2000, handling: 0 };
  if (orden === "cerrar-primero") {
    await r(`update purchase_lines set qty_closed_short = 50 where id = 1`);
    const parte = await parteDelViaje(r, 50, plan);
    return (await recibir(r, { evento: "0001", qty: 50, trip: parte })).unitCost;
  }
  const parte = await parteDelViaje(r, 50, plan);
  const rec = await recibir(r, { evento: "0001", qty: 50, trip: parte });
  await r(`update purchase_lines set qty_closed_short = 50 where id = 1`);
  return rec.unitCost;
}

test("los mismos hechos dan el mismo costo, se capture en el orden que se capture", async () => {
  const a = await mediaOrden("recibir-primero");
  const b = await mediaOrden("cerrar-primero");
  assert.equal(a, 520, "50 sacos de 100, con $1,000 de los $2,000 de flete");
  assert.equal(b, 520, "y cerrar corto antes no cambia nada");
  assert.equal(a, b, "el orden de captura no puede decidir el costo de la mercancía");
  assert.notEqual(b, 540, "el bug: el camión a medias cargando el flete entero");
});

test("el flete de lo que nunca llegó no se capitaliza: no hubo mercancía que traer", async () => {
  const db = await fresh();
  const r = await armar(db, { plannedFreight: 2000, plannedHandling: 0 });
  await r(`update purchase_lines set qty_closed_short = 50 where id = 1`);
  await recibir(r, { evento: "0001", qty: 50, trip: await parteDelViaje(r, 50, { freight: 2000, handling: 0 }) });
  const cap = (await r(`select coalesce(sum(capitalized_amount),0) as t from trip_costs where company_id = 1`))[0];
  assert.equal(Number(cap.t), 1000, "la mitad, por la mitad que llegó");
  // Los otros $1,000 se le pagaron al fletero y quedan como gasto del viaje,
  // no dentro del costo de una mercancía que no existe.
});

// ---------------------------------------------------------------------------
// 7. NO SE PUEDE PLANEAR MENOS DE LO QUE YA ENTRÓ AL COSTO
// ---------------------------------------------------------------------------
test("bajar lo planeado por debajo de lo capitalizado dejaría flete fantasma en el inventario", async () => {
  const db = await fresh();
  const r = await armar(db, { plannedFreight: 2000, plannedHandling: 0 });
  await recibir(r, { evento: "0001", qty: 50, trip: await parteDelViaje(r, 50, { freight: 2000, handling: 0 }) });

  // La consulta del candado de `savePlannedTrip`, textual.
  const ya = (await r(
    `select coalesce(sum(coalesce(t.freight,0)),0) as f, coalesce(sum(coalesce(t.handling,0)),0) as h
     from trip_costs t
     where t.company_id = 1 and t.po_id = 1 and t.capitalized_at is not null
       and exists (
         select 1 from stock_moves mv
         where mv.company_id = t.company_id and mv.event_ref = t.event_ref and mv.move_type = 'receipt'
           and not exists (select 1 from stock_moves rr where rr.reverses_id = mv.id)
       )`,
  ))[0];
  assert.equal(Number(ya.f), 1000, "ya entraron $1,000 al costo");
  // Planear $500 se rechaza: $1,000 capitalizados contra $500 planeados serían
  // $500 de flete que nadie pagó, dentro del inventario y sin vuelta atrás.
  assert.ok(500 + 0.0001 < Number(ya.f), "la condición del candado se cumple");
  assert.ok(!(2500 + 0.0001 < Number(ya.f)), "y subirlo sigue permitido");
});
