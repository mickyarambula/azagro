import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

/**
 * Corta el cuerpo de una función exportada (desde `export const NAME` hasta el
 * siguiente `export`). Si la función se renombra o se borra, el test falla.
 */
function fnBody(source, name) {
  const start = source.indexOf(`export const ${name} `);
  assert.notEqual(start, -1, `No existe export const ${name}`);
  const rest = source.slice(start + 10);
  const next = rest.search(/\nexport /);
  return next === -1 ? rest : rest.slice(0, next);
}

// ---------------------------------------------------------------------------
// 1) Cableado: cada función delicada llama la validación de rol en el servidor.
//    Esconder el botón no protege nada; esta lista es el contrato.
// ---------------------------------------------------------------------------

const GUARDS = [
  // dinero y kardex (CRÍTICOS 1 y 2)
  { file: "src/lib/azagro.ts", fn: "registerPayment", guard: `assertCan(sql, context.userId, "banks", "edit")` },
  { file: "src/lib/azagro.ts", fn: "receivePurchase", guard: `assertCan(sql, context.userId, "purchases", "edit")` },
  { file: "src/lib/azagro.ts", fn: "deliverSale", guard: `assertCan(sql, context.userId, "sales", "edit")` },
  { file: "src/lib/azagro.ts", fn: "createPurchase", guard: `assertCan(sql, context.userId, "purchases", "edit")` },
  { file: "src/lib/azagro.ts", fn: "applyLateInterest", guard: `assertCan(sql, context.userId, "credit", "edit")` },
  { file: "src/lib/azagro.ts", fn: "createSale", guard: `assertCan(sql, context.userId, "sales", "edit")` },
  { file: "src/lib/azagro.ts", fn: "transferStock", guard: `assertCan(sql, context.userId, "inventory", "edit")` },
  { file: "src/lib/azagro.ts", fn: "adjustStock", guard: `assertCan(sql, context.userId, "inventory", "edit")` },
  { file: "src/lib/azagro.ts", fn: "returnSale", guard: `assertCan(sql, context.userId, "sales", "edit")` },
  { file: "src/lib/erp/ops.ts", fn: "invoiceLiveMora", guard: `assertCan(sql, context.userId, "credit", "edit")` },
  { file: "src/lib/erp/ops.ts", fn: "reconcileMove", guard: `assertCan(sql, context.userId, "banks", "edit")` },
  { file: "src/lib/erp/ops.ts", fn: "saveContact", guard: `assertCan(sql, context.userId, "partners", "edit")` },
  { file: "src/lib/erp/ops.ts", fn: "saveDocument", guard: `assertCan(sql, context.userId, "statements", "edit")` },
  // TIIE y tipo de cambio: SOLO administrador (CRÍTICO 4)
  { file: "src/lib/erp/ops.ts", fn: "saveTiie", guard: `assertAdmin(sql, context.userId)` },
  { file: "src/lib/erp/ops.ts", fn: "saveFx", guard: `assertAdmin(sql, context.userId)` },
  // correos a nombre de la empresa (IMPORTANTE 7)
  { file: "src/lib/erp/alerts.ts", fn: "sendDirectMail", guard: `assertCan(sql, context.userId, "credit", "edit")` },
  { file: "src/lib/erp/alerts.ts", fn: "sendPaymentReminder", guard: `assertCan(sql, context.userId, "credit", "edit")` },
  { file: "src/lib/erp/alerts.ts", fn: "sendPartnerReminders", guard: `assertCan(sql, context.userId, "credit", "edit")` },
  { file: "src/lib/erp/alerts.ts", fn: "sendDueAlerts", guard: `assertCan(sql, context.userId, "credit", "edit")` },
  // lecturas reservadas (IMPORTANTE 6)
  { file: "src/lib/azagro.ts", fn: "listInvoices", guard: `assertCan(sql, context.userId, "credit", "view")` },
  { file: "src/lib/azagro.ts", fn: "getStatement", guard: `assertCan(sql, context.userId, "statements", "view")` },
  { file: "src/lib/erp/ops.ts", fn: "getLiveStatement", guard: `Sin permiso para ver la cartera` },
  { file: "src/lib/erp/deal.ts", fn: "getDealTrail", guard: `assertCan(sql, context.userId, "sales", "view")` },
  { file: "src/lib/erp/rfq.ts", fn: "listRfqs", guard: `assertCan(sql, context.userId, "purchases", "view")` },
  { file: "src/lib/erp/rfq.ts", fn: "getRfq", guard: `assertCan(sql, context.userId, "purchases", "view")` },
  { file: "src/lib/erp/files.ts", fn: "getDocFile", guard: `assertCan(sql, context.userId, "sales", "view")` },
  { file: "src/lib/erp/cutover.ts", fn: "dbStatus", guard: `assertCan(sql, context.userId, "settings", "view")` },
  { file: "src/lib/erp/orders.ts", fn: "orderLookups", guard: `assertCan(sql, context.userId, "sales", "view")` },
  // márgenes y costos: solo quien puede verlos
  { file: "src/lib/erp/orders.ts", fn: "getDealPnl", guard: `canSeeMargins(me.role)` },
  { file: "src/lib/erp/reports.ts", fn: "listDealPnl", guard: `canSeeMargins(me.role)` },
  { file: "src/lib/erp/reports.ts", fn: "getCompanyPnl", guard: `canSeeMargins(me.role)` },
  { file: "src/lib/erp/requests.ts", fn: "saveLineMargin", guard: `canSeeMargins(me.role)` },
  { file: "src/lib/erp/requests.ts", fn: "saveLineFreight", guard: `assertCan(sql, context.userId, "purchases", "edit")` },
];

test("cada función delicada valida rol en el servidor", () => {
  const cache = new Map();
  for (const g of GUARDS) {
    if (!cache.has(g.file)) cache.set(g.file, src(g.file));
    const body = fnBody(cache.get(g.file), g.fn);
    assert.ok(
      body.includes(g.guard),
      `${g.file} → ${g.fn} no valida: falta ${g.guard}`,
    );
  }
});

test("bitácora: TIIE, tipo de cambio, conciliación, mora, usuarios y cotizaciones", () => {
  const ops = src("src/lib/erp/ops.ts");
  const users = src("src/lib/erp/users.ts");
  const az = src("src/lib/azagro.ts");
  for (const [source, fn, label] of [
    [ops, "saveTiie", "cambio de TIIE"],
    [ops, "saveFx", "cambio de tipo de cambio"],
    [ops, "reconcileMove", "conciliar banco"],
    [ops, "invoiceLiveMora", "facturar mora"],
    [ops, "decideQuote", "decidir cotización"],
    [az, "applyLateInterest", "facturar mora"],
    [users, "approveAccess", "alta de usuario"],
    [users, "rejectAccess", "rechazo de solicitud"],
    [users, "updateMember", "cambio de rol/permisos"],
  ]) {
    assert.ok(fnBody(source, fn).includes("writeAudit("), `${fn}: falta bitácora de ${label}`);
  }
  // TIIE/FX guardan valor anterior → nuevo
  assert.ok(fnBody(ops, "saveTiie").includes("→"), "saveTiie: la bitácora debe llevar anterior → nuevo");
  assert.ok(fnBody(ops, "saveFx").includes("→"), "saveFx: la bitácora debe llevar anterior → nuevo");
});

test("usuario desactivado no entra por ningún helper de membresía", () => {
  const files = [
    "src/lib/azagro.ts",
    "src/lib/erp/ops.ts",
    "src/lib/erp/audit.ts",
    "src/lib/erp/alerts.ts",
    "src/lib/erp/orders.ts",
    "src/lib/erp/requests.ts",
    "src/lib/erp/rfq.ts",
    "src/lib/erp/reports.ts",
    "src/lib/erp/deal.ts",
    "src/lib/erp/links.ts",
    "src/lib/erp/files.ts",
    "src/lib/erp/cutover.ts",
    "src/lib/erp/catalogs.ts",
    "src/lib/erp/locations.ts",
    "src/lib/erp/expenses.ts",
    "src/lib/erp/cpo.ts",
  ];
  for (const f of files) {
    const s = src(f);
    // Toda consulta "de qué empresa es este usuario" debe exigir status activo.
    const loose = s.match(/from members where user_id = \$\{userId\}(?! and status = 'active')/g);
    assert.equal(loose, null, `${f}: hay un chequeo de membresía que no exige estado activo`);
  }
  const acl = src("src/lib/erp/acl.ts");
  assert.ok(acl.includes(`m[0].status !== "active"`), "assertCan debe rechazar usuarios no activos");
});

test("la clave de equipo ya no da acceso directo ni se muestra a todos", () => {
  const az = src("src/lib/azagro.ts");
  const join = fnBody(az, "joinCompany");
  assert.ok(!join.includes("insert into members"), "joinCompany no debe crear miembros activos");
  assert.ok(join.includes("access_requests"), "joinCompany debe dejar solicitud pendiente");
  assert.ok(fnBody(az, "getWorkspace").includes(`m.role === "admin" ? m.join_code : ""`), "getWorkspace: la clave solo al admin");
  const users = src("src/lib/erp/users.ts");
  assert.ok(users.includes(`role === "admin" ? member[0].join_code : ""`), "getAccessState: la clave solo al admin");
});

test("candados de usuarios: nadie se auto-modifica y no se queda la empresa sin admin", () => {
  const body = fnBody(src("src/lib/erp/users.ts"), "updateMember");
  assert.ok(body.includes("No puedes modificar tu propio rol"), "falta el candado de auto-modificación");
  assert.ok(body.includes("último administrador activo"), "falta el candado del último admin");
});

test("exceder límite de crédito: solo lo autoriza un administrador y queda en bitácora", () => {
  for (const [file, fn] of [
    ["src/lib/erp/orders.ts", "saveOrder"],
    ["src/lib/azagro.ts", "createSale"],
  ]) {
    const body = fnBody(src(file), fn);
    assert.ok(body.includes(`data.overrideCredit && member.role === "admin"`), `${fn}: la autorización debe exigir rol admin`);
    assert.ok(body.includes(`"autorizar-credito"`), `${fn}: la autorización debe quedar en bitácora`);
  }
});

// ---------------------------------------------------------------------------
// 2) Matriz de decisión. Copia de templateAcl y de la regla de assertCan
//    (src/lib/erp/acl.ts) — si cambia el motor, actualiza aquí y piensa por qué.
// ---------------------------------------------------------------------------

const MODULES = ["dashboard", "quotes", "sales", "purchases", "inventory", "credit", "gastos", "banks", "statements", "partners", "products", "settings", "users"];
const ALL_EDIT = Object.fromEntries(MODULES.map((m) => [m, "edit"]));
const ALL_VIEW = Object.fromEntries(MODULES.map((m) => [m, "view"]));

function templateAcl(role) {
  if (role === "admin") return { ...ALL_EDIT };
  if (role === "gerencia") return { ...ALL_EDIT, users: "view" };
  if (role === "consulta") return { ...ALL_VIEW, settings: "none", users: "none" };
  if (role === "administracion")
    return { dashboard: "view", quotes: "view", sales: "view", purchases: "view", inventory: "view", credit: "edit", gastos: "edit", banks: "edit", statements: "edit", partners: "edit", products: "view", settings: "view", users: "none" };
  if (role === "ventas")
    return { dashboard: "view", quotes: "edit", sales: "edit", purchases: "none", inventory: "view", credit: "view", gastos: "view", banks: "none", statements: "view", partners: "edit", products: "view", settings: "none", users: "none" };
  if (role === "compras")
    return { dashboard: "view", quotes: "none", sales: "none", purchases: "edit", inventory: "edit", credit: "view", gastos: "edit", banks: "none", statements: "none", partners: "edit", products: "edit", settings: "none", users: "none" };
  if (role === "almacen")
    return { dashboard: "view", quotes: "none", sales: "edit", purchases: "edit", inventory: "edit", credit: "none", gastos: "none", banks: "none", statements: "none", partners: "view", products: "view", settings: "none", users: "none" };
  return { dashboard: "view", quotes: "none", sales: "view", purchases: "none", inventory: "none", credit: "edit", gastos: "view", banks: "edit", statements: "edit", partners: "view", products: "view", settings: "none", users: "none" };
}

/** Regla de assertCan: activo + nivel del módulo. */
function can({ status, role }, module, need) {
  if (status !== "active") return false;
  const have = templateAcl(role)[module];
  if (need === "view") return have !== "none";
  return have === "edit";
}

// (módulo, nivel) que exige cada operación protegida — mismo contrato que GUARDS.
const OPS = {
  cobrarPagar: ["banks", "edit"],
  recibirMercancia: ["purchases", "edit"],
  entregarMercancia: ["sales", "edit"],
  crearOC: ["purchases", "edit"],
  facturarMora: ["credit", "edit"],
  conciliarBanco: ["banks", "edit"],
  mandarCorreos: ["credit", "edit"],
  ajustarStock: ["inventory", "edit"],
  verCartera: ["credit", "view"],
  verEstadoCuenta: ["statements", "view"],
  administrarUsuarios: ["users", "edit"],
  importarCorte: ["settings", "edit"],
};

test("almacén: existencias sí; dinero, cartera y correos no", () => {
  const u = { status: "active", role: "almacen" };
  assert.equal(can(u, ...OPS.ajustarStock), true);
  assert.equal(can(u, ...OPS.entregarMercancia), true);
  assert.equal(can(u, ...OPS.cobrarPagar), false);
  assert.equal(can(u, ...OPS.facturarMora), false);
  assert.equal(can(u, ...OPS.conciliarBanco), false);
  assert.equal(can(u, ...OPS.mandarCorreos), false);
  assert.equal(can(u, ...OPS.verCartera), false);
  assert.equal(can(u, ...OPS.verEstadoCuenta), false);
  assert.equal(can(u, ...OPS.administrarUsuarios), false);
});

test("ventas: cotiza y ve cartera, pero no toca bancos ni compras", () => {
  const u = { status: "active", role: "ventas" };
  assert.equal(can(u, ...OPS.verCartera), true);
  assert.equal(can(u, "inventory", "view"), true); // lectura de existencias para prometer entrega
  assert.equal(can(u, ...OPS.cobrarPagar), false);
  assert.equal(can(u, ...OPS.crearOC), false);
  assert.equal(can(u, ...OPS.recibirMercancia), false);
  assert.equal(can(u, ...OPS.conciliarBanco), false);
  assert.equal(can(u, ...OPS.importarCorte), false);
  assert.equal(can(u, ...OPS.administrarUsuarios), false);
});

test("contabilidad (administración): cartera y bancos sí, kardex no", () => {
  const u = { status: "active", role: "administracion" };
  assert.equal(can(u, ...OPS.cobrarPagar), true);
  assert.equal(can(u, ...OPS.facturarMora), true);
  assert.equal(can(u, ...OPS.conciliarBanco), true);
  assert.equal(can(u, ...OPS.mandarCorreos), true);
  assert.equal(can(u, ...OPS.ajustarStock), false);
  assert.equal(can(u, ...OPS.recibirMercancia), false);
  assert.equal(can(u, ...OPS.entregarMercancia), false);
  assert.equal(can(u, ...OPS.administrarUsuarios), false);
});

test("solo consulta: no ejecuta ninguna operación protegida", () => {
  const u = { status: "active", role: "consulta" };
  for (const [name, [mod, need]] of Object.entries(OPS)) {
    if (need === "edit") assert.equal(can(u, mod, need), false, `consulta no debe poder: ${name}`);
  }
});

test("usuario desactivado: nada, sin importar el rol", () => {
  for (const role of ["admin", "gerencia", "administracion", "ventas", "compras", "almacen", "cobranza", "consulta"]) {
    const u = { status: "disabled", role };
    for (const [name, [mod, need]] of Object.entries(OPS)) {
      assert.equal(can(u, mod, need), false, `desactivado (${role}) no debe poder: ${name}`);
    }
    assert.equal(can(u, "dashboard", "view"), false, `desactivado (${role}) no debe ni ver el tablero`);
  }
});

test("TIIE y tipo de cambio: la regla es rol admin, no un módulo", () => {
  const acl = src("src/lib/erp/acl.ts");
  assert.ok(acl.includes(`if (m.role !== "admin") throw new Error("Solo un administrador`), "assertAdmin debe exigir rol admin");
  // y assertAdmin pasa por activeMember, que rechaza desactivados
  assert.ok(acl.includes("export async function assertAdmin"), "falta assertAdmin");
});

test("la copia de plantillas no se desfasó del motor (valores ancla)", () => {
  const acl = src("src/lib/erp/acl.ts");
  // Anclas de la plantilla real; si cambian en acl.ts este test truena a propósito.
  for (const anchor of [`credit: "none"`, `banks: "none"`, `settings: "none"`, `users: "none"`]) {
    assert.ok(acl.includes(anchor), `acl.ts ya no contiene ${anchor}: revisa la copia de templateAcl en este test`);
  }
});
