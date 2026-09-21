// LO QUE COSTÓ TRAER UN VIAJE (Decisión 100, pieza 1 — 21-sep-2026).
//
// El dueño: comprando para inventario se pagan DOS fletes —uno para traerla y
// otro para llevársela al cliente— y «en ocasiones también se pagan
// cargadores, para descarga y carga». De ahí: lo que cuesta TRAERLA (flete de
// entrada + maniobras) es costo de la mercancía; lo que cuesta LLEVÁRSELA es
// costo del pedido y vive donde ya vive.
//
// ESTA PIEZA SOLO CAPTURA Y ENSEÑA. La mitad de esta prueba existe para fijar
// que NO mueve un peso: meter el flete al costo del inventario sin apagar la
// segunda suma le cobraría $2,352.94 de más al cliente por camión, porque la
// cotización toma el costo del inventario y le vuelve a sumar el flete.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

// ---------------------------------------------------------------------------
// 1. Lo que esta pieza NO toca — la mitad importante
// ---------------------------------------------------------------------------
test("el costo con el que entra la mercancía al inventario NO cambió", () => {
  const a = src("src/lib/azagro.ts");
  assert.ok(
    a.includes("unitCost: receiptUnitCostMxn({ unitPrice: line[0].unit_price, currency: poFx[0].currency, fx: poFx[0].fx_rate, poName: opts.poName }),"),
    "la recepción sigue entrando al precio del proveedor, byte a byte",
  );
  assert.ok(!a.includes("trip_costs"), "azagro.ts ni se entera de que existen los costos de viaje");
});

test("el precio y la utilidad NO leen el costo del viaje: si lo hicieran, el flete se contaría dos veces", () => {
  // La cotización toma el costo del inventario y le vuelve a sumar el flete
  // (`ops.ts`). Con 100 sacos a $500 y $2,000 de viaje, el precio subiría
  // $23.53 por saco — $2,352.94 cobrados de más en ese camión.
  for (const p of ["src/lib/erp/ops.ts", "src/lib/erp/pricing.ts", "src/lib/erp/reports.ts", "src/lib/erp/cost.ts", "src/lib/erp/stock.ts", "src/lib/erp/parciales.ts"]) {
    assert.ok(!src(p).includes("trip_costs"), `${p} no debe leer el costo del viaje todavía`);
    assert.ok(!src(p).includes("tripCost"), `${p} no debe leer el costo del viaje todavía`);
  }
  assert.ok(src("src/lib/erp/ops.ts").includes("const landed = cost + (line.freight ?? 0) + (line.other ?? 0);"), "el costo puesto de la cotización, intacto");
  assert.ok(src("src/lib/erp/reports.ts").includes("const landed = cogs + freight + other;"), "el costo puesto de la utilidad, intacto");
});

test("y la pantalla lo dice, para que nadie crea que ya está haciendo algo", () => {
  const p = src("src/routes/purchases.tsx");
  assert.ok(
    p.includes("Todavía no entra al costo del inventario ni cambia ningún precio: eso es el paso siguiente."),
    "el aviso en pantalla",
  );
});

// ---------------------------------------------------------------------------
// 2. El concepto: flete Y maniobras, un solo costo
// ---------------------------------------------------------------------------
test("las maniobras van junto al flete, no aparte: son parte de lo que costó traerla", () => {
  const m = src("migrations/0050_costo_del_viaje.sql");
  assert.ok(m.includes("freight numeric(14,2)"), "el flete");
  assert.ok(m.includes("handling numeric(14,2)"), "las maniobras");
  assert.ok(m.includes("son parte del mismo costo de traerla (Decisión 100)"), "y queda dicho por qué juntas");
  const t = src("src/lib/erp/trip-cost.ts");
  assert.ok(t.includes("pagan cargadores, para descarga y carga»"), "con las palabras del dueño");
});

test("vacío NO es cero: un viaje sin flete capturado no es un viaje gratis", () => {
  const m = src("migrations/0050_costo_del_viaje.sql");
  // Sin `not null default 0`: eso convertiría «no se capturó» en «fue gratis».
  assert.ok(!/freight numeric\(14,2\) not null/.test(m), "el flete nace vacío");
  assert.ok(!/handling numeric\(14,2\) not null/.test(m), "las maniobras también");
  assert.ok(m.includes("vacío NO es cero (Decisiones 64 y 67)"), "y se dice de dónde viene la regla");
  const t = src("src/lib/erp/trip-cost.ts");
  assert.ok(t.includes("freight: t.freight == null ? null : Number(t.freight),"), "null viaja hasta la pantalla");
  const p = src("src/routes/purchases.tsx");
  assert.ok(p.includes('Flete {t.freight == null ? "sin capturar" : money(t.freight)}'), "y la pantalla lo distingue");
  assert.ok(p.includes('freight: flete.trim() === "" ? null : Number(flete),'), "dejar el campo vacío no guarda un cero");
});

// ---------------------------------------------------------------------------
// 3. Un viaje por recepción, y el viaje tiene que existir
// ---------------------------------------------------------------------------
test("un renglón por RECEPCIÓN, no por orden: una orden puede llegar en tres camiones", () => {
  const m = src("migrations/0050_costo_del_viaje.sql");
  assert.ok(m.includes("unique (company_id, event_ref)"), "un costo por viaje");
  assert.ok(m.includes("llegar en tres camiones"), "y queda dicho por qué no es columna de la orden");
  const t = src("src/lib/erp/trip-cost.ts");
  assert.ok(t.includes("and m.event_ref is not null and m.move_type = 'receipt'"), "los eventos salen del kardex");
});

test("un folio inventado se detiene: un costo no puede colgar de un viaje que no existe", () => {
  const t = src("src/lib/erp/trip-cost.ts");
  assert.ok(t.includes("if (!existe[0]?.n) throw new Error(`La recepción ${data.eventRef} no pertenece a ${po[0].name}`);"), "la guarda");
});

test("una recepción revertida conserva su costo: el dinero del fletero ya salió", () => {
  // Decisión 38: revertir no es devolver. La mercancía regresó, el pago al
  // fletero no.
  const t = src("src/lib/erp/trip-cost.ts");
  assert.ok(t.includes("pero el dinero del fletero ya salió"), "el criterio");
  const p = src("src/routes/purchases.tsx");
  assert.ok(p.includes("recepción revertida — el dinero del fletero ya salió, el costo se queda"), "y la pantalla lo dice");
});

// ---------------------------------------------------------------------------
// 4. Permisos: lo que se enmascara no se escribe (CLAUDE.md § 10)
// ---------------------------------------------------------------------------
test("el costo del viaje lo captura quien ve costos de compra, y el mismo rol lo lee", () => {
  const t = src("src/lib/erp/trip-cost.ts");
  // Leer: quien no ve costos recibe la lista vacía, no el número enmascarado.
  assert.ok(t.includes("if (!canSeeCosts(m.role)) return { puedeVer: false as const, trips: [] };"), "leer exige ver costos");
  // Escribir: el MISMO rol. Si se separan, la máscara se vuelve un borrador.
  assert.ok(t.includes("if (!canSeeCosts(m.role)) throw new Error(SIN_COSTOS);"), "escribir exige el mismo rol");
  assert.ok(t.includes("Lo que se enmascara no se escribe (CLAUDE.md § 10)"), "con la regla citada");
  assert.ok(t.includes('Lo que costó el viaje lo captura quien ve los costos de compra (compras, gerencia o administrador)'), "y dice a quién le toca");
  // Y el permiso del módulo, además del rol.
  assert.ok(t.includes('await assertCan(sql, context.userId, "purchases", "edit");'), "editar la compra");
  assert.ok(t.includes('await assertCan(sql, context.userId, "purchases", "view");'), "y ver la compra para leerlo");
});

test("el almacén recibe pero no captura el costo: no ve costos (regla 10)", () => {
  const t = src("src/lib/erp/trip-cost.ts");
  assert.ok(t.includes("El almacén recibe pero no ve costos, así que no"), "el criterio queda escrito");
  // El camino de recibir no cambió: capturar el costo es otro acto, de otro rol.
  assert.ok(!src("src/lib/azagro.ts").includes("saveTripCost"), "recibir no captura el costo");
});

// ---------------------------------------------------------------------------
// 5. Bitácora y borrado de pruebas
// ---------------------------------------------------------------------------
test("cada captura y cada corrección quedan en bitácora, con los dos números", () => {
  const t = src("src/lib/erp/trip-cost.ts");
  assert.ok(t.includes('action: antes[0] ? "costo-de-viaje-corregido" : "costo-de-viaje",'), "distingue capturar de corregir");
  assert.ok(t.includes("flete ${num(antes[0]?.freight)} → ${num("), "con el número de antes y el de después");
  assert.ok(t.includes('num = (v: string | null | undefined) => (v == null ? "sin capturar"'), "y «sin capturar» no se imprime como 0.00");
});

test("la tabla nueva está clasificada en el borrado de pruebas", () => {
  const p = src("scripts/purge-plan.mjs");
  assert.ok(p.includes('{ step: 3, table: "trip_costs", kind: "delete", sql: "delete from trip_costs where company_id = $1" },'), "se borra");
  assert.ok(p.includes("no importa viajes"), "y se dice por qué no lleva cutover_key");
});

// ---------------------------------------------------------------------------
// 6. Lo comprometido y lo pagado, la forma de la Decisión 99
// ---------------------------------------------------------------------------
test("el gasto pagado apunta al mismo viaje, Y HAY POR DÓNDE CAPTURARLO", () => {
  // Prometer «comprometido contra pagado» sin puerta para llenarlo deja la
  // comparación muerta: `paidN` sería siempre 0 y el renglón nunca se dibuja.
  const m = src("migrations/0050_costo_del_viaje.sql");
  assert.ok(m.includes("alter table expenses add column if not exists event_ref text not null default '';"), "la liga");
  const e = src("src/lib/erp/expenses.ts");
  assert.ok(e.includes("eventRef: z.string().optional(),"), "el gasto lo acepta");
  assert.ok(e.includes("is_freight, event_ref)"), "y lo guarda");
  assert.ok(e.includes("coalesce(e.event_ref,'') as event_ref"), "y lo devuelve al listado");
  const g = src("src/routes/gastos.tsx");
  assert.ok(g.includes('<Field label="¿Qué viaje pagó?">'), "la pantalla lo pregunta");
  assert.ok(g.includes("flete comprometido"), "y enseña contra qué se va a comparar");
  assert.ok(g.includes("Viaje {e.event_ref}"), "el listado dice a cuál quedó ligado");
  const t = src("src/lib/erp/trip-cost.ts");
  assert.ok(t.includes("where company_id = ${m.company_id} and event_ref = any(${refs})"), "se lee lo pagado, acotado a la empresa y a esos viajes");
  // Pero TODAVÍA no manda sobre nada: eso es la pieza siguiente.
  assert.ok(t.includes("Todavía no manda sobre nada"), "y queda dicho");
  const p = src("src/routes/purchases.tsx");
  assert.ok(p.includes("Pagado {money(t.paid)}"), "la pantalla de compras enseña los dos");
});

test("un viaje inventado se detiene también desde el gasto, y exige la orden de compra", () => {
  const e = src("src/lib/erp/expenses.ts");
  assert.ok(e.includes("Para ligarlo a un viaje, liga el gasto a la orden de compra que llegó en él"), "sin OC no hay viaje");
  assert.ok(e.includes("no pertenece a esa orden de compra"), "y el folio tiene que ser de esa orden");
});

test("una sola llamada para toda la lista, y los gastos acotados a esos viajes", () => {
  // Un componente por orden llamando al servidor serían N viajes y N barridos
  // de gastos por carga de pantalla.
  const t = src("src/lib/erp/trip-cost.ts");
  assert.ok(t.includes("validator(z.object({ poIds: z.array(z.number()).max(200) }))"), "recibe la lista entera");
  assert.ok(t.includes("and po.id = any(${data.poIds})"), "y consulta de una vez");
  const p = src("src/routes/purchases.tsx");
  assert.ok(p.includes("async function loadTrips("), "la pantalla carga una vez");
  assert.ok(!p.includes("useEffect(() => {\n    void load();\n    // eslint"), "el componente ya no llama al servidor por su cuenta");
});

test("lo que una puerta no manda, no lo borra: el upsert conserva fletero y nota", () => {
  const t = src("src/lib/erp/trip-cost.ts");
  assert.ok(t.includes("partner_id = coalesce(excluded.partner_id, trip_costs.partner_id),"), "el fletero se conserva");
  assert.ok(t.includes("notes = coalesce(excluded.notes, trip_costs.notes),"), "la nota también");
  const m = src("migrations/0050_costo_del_viaje.sql");
  assert.ok(!/notes text not null/.test(m), "y por eso la nota es nullable: «no se mandó» ≠ «se borró»");
});

test("el aviso cuenta los viajes SIN FLETE, no los que solo les faltan maniobras", () => {
  // Un viaje siempre tuvo flete; cargadores no siempre. Contarlos empujaría a
  // teclear un 0 que nadie verificó.
  const p = src("src/routes/purchases.tsx");
  assert.ok(p.includes("const falta = trips.filter((t) => !t.reversed && t.freight == null).length;"), "solo el flete");
  assert.ok(p.includes("viajes sin flete capturado"), "y el texto lo dice");
});

test("la bitácora enseña las acciones con nombre, no con su nombre interno", () => {
  const b = src("src/routes/bitacora.tsx");
  for (const [slug, texto] of [
    ["costo-de-viaje", "Capturó lo que costó traer un viaje"],
    ["costo-de-viaje-corregido", "Corrigió lo que costó traer un viaje"],
    // Hueco heredado de la Decisión 99 y del arreglo del flete borrado.
    ["marcar-flete", "Marcó un gasto como flete del pedido"],
    ["desmarcar-flete", "Quitó la marca de flete a un gasto"],
    ["flete-de-solicitud", "Capturó el flete de una solicitud"],
  ]) {
    assert.ok(b.includes(`"${slug}": "${texto}"`), `${slug} sin nombre legible`);
  }
});
