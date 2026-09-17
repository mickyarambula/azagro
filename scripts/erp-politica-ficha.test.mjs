// LA POLÍTICA DE COBRO VIVE EN LA FICHA DEL CLIENTE — Decisión 73, hallazgo
// #21 de la auditoría, 17-sep-2026. Antes la decidía el código por el nombre
// del grupo (group_name === "Grupo SL" → GRUPO_SL, lo demás → ESTANDAR).
// Aquí: la migración 0043 sobre PGlite (siembra única, solo «Grupo SL», solo
// si la política existe, idempotente) y el cableado de los cinco puntos.
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
const m43 = () => readFileSync(join(dir, readdirSync(dir).find((f) => f.startsWith("0043"))), "utf8");

test("0043: solo los «Grupo SL» con la política en su empresa reciben GRUPO_SL; nadie más recibe política; lo capturado no se pisa; idempotente", async () => {
  const db = new PGlite();
  for (const { name, path } of pendingMigrations(readdirSync(dir), [])) {
    if (name.startsWith("0043")) continue;
    await db.exec(readFileSync(join(dir, path), "utf8"));
  }
  await db.exec(`
    insert into companies (id, name, join_code, created_by) values (1, 'Azagro', 'AZ1', 'u1'), (2, 'Otra', 'OT1', 'u1');
    insert into credit_policies (company_id, code, name) values (1, 'GRUPO_SL', 'Grupo SL'), (1, 'ESTANDAR', 'Estándar');
    insert into partners (id, company_id, code, name, is_customer, group_name) values
      (1, 1, 'C1', 'Del grupo', true, 'Grupo SL'),
      (2, 1, 'C2', 'Otro grupo', true, 'Varios'),
      (3, 1, 'C3', 'Sin grupo', true, ''),
      (4, 1, 'C4', 'Casi', true, 'grupo sl'),
      (5, 2, 'C5', 'Grupo SL en otra empresa sin la política', true, 'Grupo SL');
  `);
  await db.exec(m43());
  await db.exec(`update partners set policy_code = 'ESTANDAR' where id = 2`); // capturado a mano después
  await db.exec(m43()); // segunda pasada
  const rows = (await db.query(`select id, policy_code from partners order by id`)).rows;
  assert.deepEqual(rows, [
    { id: 1, policy_code: "GRUPO_SL" },
    { id: 2, policy_code: "ESTANDAR" }, // lo capturado manda; ESTANDAR nunca se siembra
    { id: 3, policy_code: null },
    { id: 4, policy_code: null }, // 'grupo sl' no es 'Grupo SL': antes el código tampoco lo trataba como grupo
    { id: 5, policy_code: null }, // la política no existe en esa empresa: no se inventa
  ]);
  await db.close();
});

test("cableado: ficha, alta, lookups, pedido y decideQuote leen la ficha; la regla por nombre de grupo ya no existe en src", () => {
  const az = src("src/lib/azagro.ts");
  const save = fnBody(az, "savePartner");
  assert.ok(save.includes('policy_code: z.string().optional().default("")') && save.includes("no existe en Ajustes → Políticas de cobro"), "la ficha guarda la política y valida que exista");
  assert.ok(save.includes("policy_code = ${policyCode || null}") && save.includes("${context.userId}, ${policyCode || null})"), "vacío = null, nunca una política por omisión");
  assert.equal((az.match(/coalesce\(p\.policy_code,''\) as policy_code/g) || []).length, 1, "listPartners la trae (getPartner usa p.*)");
  assert.ok(src("src/lib/erp/catalogs.ts").includes("return { uoms, kinds, groups, policies };"));
  const form = src("src/components/partner-form.tsx");
  assert.ok(form.includes("Política de cobro — sin política: captúrala") && form.includes('<option value="">Sin política capturada</option>'), "la ficha lo pide y marca la falta");
  assert.ok(src("src/lib/erp/orders.ts").includes("coalesce(policy_code,'') as policy_code\n      from partners where company_id = ${companyId} and is_customer = true"), "orderLookups la trae");
  assert.ok(src("src/components/order-form.tsx").includes('policyCode: partner.policy_code || "",'), "el pedido la propone desde la ficha; sin política, vacío (no arrastra la del cliente anterior)");
  assert.ok(form.includes("policies.filter((p) => p.code !== NO_MORA_POLICY).map((p) => ("), "la ficha no ofrece «Sin mora»: es solo de contado");
  const dq = fnBody(src("src/lib/erp/ops.ts"), "decideQuote");
  assert.ok(dq.includes("const policyCode = days > 0 ? ficha[0]!.policy_code : NO_MORA_POLICY;") && dq.includes("captúrala en Clientes antes de aceptar la cotización a crédito."), "decideQuote: la de la ficha o se detiene");
  for (const f of ["src/lib/erp/ops.ts", "src/components/order-form.tsx", "src/lib/erp/orders.ts", "src/lib/azagro.ts"]) {
    assert.ok(!src(f).includes('=== "Grupo SL"'), `${f}: el nombre del grupo ya no decide dinero`);
  }
});

test("cableado: la lista de Clientes enseña cuántos no tienen política, filtra a solo esos y marca cada renglón (condición del dueño)", () => {
  const p = src("src/routes/partners.tsx");
  assert.ok(p.includes("const sinPolitica = useMemo(() => rows.filter((r) => r.is_customer && !r.policy_code).length, [rows]);"), "conteo");
  assert.ok(p.includes("sin política de cobro · {soloSinPolitica ? \"ver todos\" : \"ver solo estos\"}"), "aviso con filtro");
  assert.ok(p.includes(".filter((r) => !(soloSinPolitica && tab !== \"proveedores\") || !r.policy_code)"), "el filtro solo aplica a clientes");
  assert.ok(p.includes('{isCliente && !r.policy_code && <span className="ml-2 text-[11px] font-normal text-warn">sin política</span>}'), "marca por renglón");
});
