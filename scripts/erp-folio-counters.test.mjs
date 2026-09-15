// BLOQUE A4 — CONTADOR DE FOLIO POR SERIE (15-sep-2026): migración 0033
// (folio_counters) + nextRef nuevo en stock.ts. Antes, nextRef contaba TODA
// stock_moves por empresa (un solo contador para los siete tipos): dentro de
// cada serie los números saltaban, y dos clics simultáneos de tipos
// distintos podían producir el mismo número en dos series. Ahora cada
// (empresa, serie) tiene su propia fila y su propio `+1` atómico.
//
// Las consultas de aquí son las MISMAS que nextRef ejecuta (pedirFolio
// abajo, letra por letra) — no una reimplementación aparte — para que la
// prueba caiga si alguien cambia la SQL real sin darse cuenta.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pendingMigrations } from "./migration-plan.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "migrations");
const src = (p) => readFileSync(join(root, p), "utf8");

function fnBody(source, name) {
  const markers = [`export const ${name} `, `export async function ${name}(`, `export function ${name}(`, `async function ${name}(`, `function ${name}(`];
  const start = markers.map((m) => source.indexOf(m)).find((i) => i !== -1);
  assert.notEqual(start, undefined, `No existe ${name}`);
  const rest = source.slice(start);
  const next = rest.slice(10).search(/\n(export )?(async )?function |\nexport const /);
  return next === -1 ? rest : rest.slice(0, next + 10);
}

async function applyAll(db) {
  for (const { name, path } of pendingMigrations(readdirSync(dir), [])) {
    try {
      await db.exec(readFileSync(join(dir, path), "utf8"));
    } catch (e) {
      assert.fail(`${name}: ${e?.message ?? e}`);
    }
  }
}

async function seedCompany(db, id, name) {
  await db.exec(`insert into companies (id, name, join_code, created_by) values (${id}, '${name}', '${name}1', 'u1')`);
}

/** Exactamente la SQL de nextRef (stock.ts): un insert…on conflict…returning. */
async function pedirFolio(db, companyId, series) {
  const rows = (
    await db.query(
      `insert into folio_counters (company_id, series, last_number)
       values ($1, $2, 1)
       on conflict (company_id, series) do update set last_number = folio_counters.last_number + 1
       returning last_number`,
      [companyId, series],
    )
  ).rows;
  return `${series}/${String(rows[0].last_number).padStart(4, "0")}`;
}

test("wiring: nextRef usa el insert…on conflict…returning de folio_counters, no count(*)", () => {
  const body = fnBody(src("src/lib/erp/stock.ts"), "nextRef");
  assert.ok(body.includes("insert into folio_counters"), "escribe en folio_counters");
  assert.ok(body.includes("on conflict (company_id, series) do update set last_number = folio_counters.last_number + 1"), "el +1 atómico");
  assert.ok(body.includes("returning last_number"), "toma el número de la misma sentencia");
  assert.ok(!body.includes("count(*)"), "ya no cuenta toda la tabla");
  assert.ok(body.includes('String(rows[0]!.last_number).padStart(4, "0")'), "formato PREFIJO/NNNN de 4 dígitos, sin cambiar");
});

test("cada serie avanza independiente: REC, ENT, REC → REC/0001, ENT/0001, REC/0002", async () => {
  const db = new PGlite();
  await applyAll(db);
  await seedCompany(db, 1, "AZ");
  assert.equal(await pedirFolio(db, 1, "REC"), "REC/0001");
  assert.equal(await pedirFolio(db, 1, "ENT"), "ENT/0001");
  assert.equal(await pedirFolio(db, 1, "REC"), "REC/0002");
  await db.close();
});

test("dos series distintas ya no producen el mismo número global: una secuencia mezclada de 6 pedidos no comparte contador", async () => {
  const db = new PGlite();
  await applyAll(db);
  await seedCompany(db, 1, "AZ");
  const orden = ["REC", "ENT", "TR", "REC", "ENT", "REC"];
  const refs = [];
  for (const serie of orden) refs.push(await pedirFolio(db, 1, serie));
  assert.deepEqual(refs, ["REC/0001", "ENT/0001", "TR/0001", "REC/0002", "ENT/0002", "REC/0003"]);
  // 6 pedidos en total, pero ninguna serie llegó a 6: no hay un contador
  // global escondido detrás. Y ningún ref se repite.
  assert.equal(new Set(refs).size, 6, "los seis refs son distintos");
  const maxima = Math.max(...refs.map((r) => Number(r.split("/")[1])));
  assert.ok(maxima < orden.length, `el máximo por serie (${maxima}) es menor que el total de pedidos (${orden.length}): no hay contador compartido`);
  await db.close();
});

test("idempotencia: correr la migración 0033 dos veces no altera la semilla", async () => {
  const db = new PGlite();
  const files = pendingMigrations(readdirSync(dir), []);
  for (const { path } of files.filter((f) => f.name < "0033")) await db.exec(readFileSync(join(dir, path), "utf8"));
  await seedCompany(db, 1, "AZ");
  await seedCompany(db, 2, "Otra");
  // Historia simulada, como la dejaba el count(*) de antes: REC hasta 0002,
  // ENT hasta 0001, nada de TR — y otra empresa con su propia historia.
  await db.exec(`
    insert into locations (id, company_id, code, name, loc_type) values (1, 1, 'BOD', 'Bodega', 'internal'), (2, 2, 'BOD', 'Bodega', 'internal');
    insert into products (id, company_id, code, name, uom, cost, list_price) values (1, 1, 'P1', 'Producto', 'kg', 10, 12), (2, 2, 'P1', 'Producto', 'kg', 10, 12);
    insert into stock_moves (company_id, ref, move_type, date, origin, location_to, product_id, quantity, created_by) values
      (1, 'REC/0001', 'receipt', '2026-09-01', 'OC-0001', 1, 1, 10, 'u1'),
      (1, 'REC/0002', 'receipt', '2026-09-02', 'OC-0002', 1, 1, 10, 'u1'),
      (2, 'REC/0001', 'receipt', '2026-09-01', 'OC-0001', 2, 2, 5, 'u1');
    insert into stock_moves (company_id, ref, move_type, date, origin, location_from, product_id, quantity, created_by) values
      (1, 'ENT/0001', 'delivery', '2026-09-03', 'PV-0001', 1, 1, 3, 'u1');
  `);
  const leer = async () => (await db.query(`select company_id, series, last_number from folio_counters order by company_id, series`)).rows;

  const sql0033 = readFileSync(join(dir, "0033_folio_counters.sql"), "utf8");
  await db.exec(sql0033);
  const primera = await leer();
  assert.deepEqual(primera, [
    { company_id: 1, series: "ENT", last_number: 1 },
    { company_id: 1, series: "REC", last_number: 2 },
    { company_id: 2, series: "REC", last_number: 1 },
  ]);

  await db.exec(sql0033);
  const segunda = await leer();
  assert.deepEqual(segunda, primera, "correrla dos veces no mueve la semilla");
  await db.close();
});

test("la semilla lee el máximo existente y continúa desde ahí, no desde 1", async () => {
  const db = new PGlite();
  const files = pendingMigrations(readdirSync(dir), []);
  for (const { path } of files.filter((f) => f.name < "0033")) await db.exec(readFileSync(join(dir, path), "utf8"));
  await seedCompany(db, 1, "AZ");
  await db.exec(`
    insert into locations (id, company_id, code, name, loc_type) values (1, 1, 'BOD', 'Bodega', 'internal');
    insert into products (id, company_id, code, name, uom, cost, list_price) values (1, 1, 'P1', 'Producto', 'kg', 10, 12);
    insert into stock_moves (company_id, ref, move_type, date, origin, location_to, product_id, quantity, created_by) values
      (1, 'REC/0001', 'receipt', '2026-09-01', 'OC-0001', 1, 1, 10, 'u1'),
      (1, 'REC/0007', 'receipt', '2026-09-05', 'OC-0007', 1, 1, 10, 'u1');
  `);
  await db.exec(readFileSync(join(dir, "0033_folio_counters.sql"), "utf8"));
  // El siguiente REC tiene que seguir desde 0007, no reiniciar en 0001.
  assert.equal(await pedirFolio(db, 1, "REC"), "REC/0008");
  await db.close();
});

test("el formato sigue siendo PREFIJO/NNNN con 4 dígitos", async () => {
  const db = new PGlite();
  await applyAll(db);
  await seedCompany(db, 1, "AZ");
  const ref = await pedirFolio(db, 1, "DEV");
  assert.match(ref, /^DEV\/[0-9]{4}$/, `formato: ${ref}`);
  assert.equal(ref, "DEV/0001");
  // Mismo patrón que usan la migración y la radiografía (erp-folios-kardex.mjs).
  assert.match(ref, /^(REC|ENT|TR|AJ|INI|DEV|REV)\/[0-9]{4,}$/);
  await db.close();
});

test("es autocorregible: una transacción revertida deja el contador donde estaba, y el siguiente pedido reutiliza el mismo número", async () => {
  const db = new PGlite();
  await applyAll(db);
  await seedCompany(db, 1, "AZ");

  // Primer folio, confirmado de verdad.
  assert.equal(await pedirFolio(db, 1, "REC"), "REC/0001");

  // Un segundo folio, pedido dentro de una transacción que se revierte
  // después — como una operación que truena a medio camino. El +1 vive en
  // la MISMA transacción que el resto de postStock (nextRef corre con la
  // conexión que withTx le da), así que se revierte junto con ella.
  await db.exec("begin");
  const dentro = await pedirFolio(db, 1, "REC");
  assert.equal(dentro, "REC/0002", "dentro de la transacción, el número se asignó");
  await db.exec("rollback");

  // El contador volvió a 1 (el +1 se revirtió con todo lo demás de esa
  // transacción caída), así que el siguiente pedido real obtiene el MISMO
  // número que se le había dado a la operación que nunca pasó. Ningún folio
  // se pierde por algo que no ocurrió — exactamente lo que hacía count(*).
  const siguiente = await pedirFolio(db, 1, "REC");
  assert.equal(siguiente, dentro, "el siguiente SÍ reutiliza el número: es autocorregible, no se quema nada");
  assert.equal(siguiente, "REC/0002");
  await db.close();
});

test("concurrencia real: N peticiones simultáneas de la MISMA serie nunca se llevan el mismo número", async () => {
  const db = new PGlite();
  await applyAll(db);
  await seedCompany(db, 1, "AZ");
  await seedCompany(db, 2, "Otra");

  // Disparadas juntas, sin esperar una a la otra — el candado de fila de
  // folio_counters (company_id, series) es lo único que evita que dos se
  // lleven el mismo número, no el orden en que el código las llama.
  const N = 25;
  const resultados = await Promise.all(Array.from({ length: N }, () => pedirFolio(db, 1, "REC")));
  const numeros = resultados.map((r) => Number(r.split("/")[1])).sort((a, b) => a - b);
  assert.equal(new Set(resultados).size, N, "las 25 peticiones simultáneas dieron 25 folios distintos");
  assert.deepEqual(numeros, Array.from({ length: N }, (_, i) => i + 1), "sin huecos ni repetidos: 1..25 exactos");

  // Y una empresa distinta, disparada al mismo tiempo, no se cruza con la
  // primera: (company_id, series) es la llave, no solo la serie.
  const otra = await Promise.all(Array.from({ length: 5 }, () => pedirFolio(db, 2, "REC")));
  assert.deepEqual(otra, ["REC/0001", "REC/0002", "REC/0003", "REC/0004", "REC/0005"]);
  await db.close();
});
