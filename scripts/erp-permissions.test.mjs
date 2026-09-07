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
  // Cobrar/pagar vive en Cartera, no en Bancos (sesión de permisos, 7-sep-2026).
  { file: "src/lib/azagro.ts", fn: "registerPayment", guard: `assertCan(sql, context.userId, "credit", "edit")` },
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
  // sendDirectMail: el permiso del DOCUMENTO que se envía, no credit:edit fijo
  // (sesión de permisos, 7-sep-2026) — ver test dedicado más abajo.
  { file: "src/lib/erp/alerts.ts", fn: "sendDirectMail", guard: `assertCan(sql, context.userId, data.module, "edit")` },
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
  // getDocFile: el permiso depende de a qué tipo de documento pertenece el
  // archivo (DOC_KIND_MODULE) — ver test dedicado más abajo, no un literal fijo.
  { file: "src/lib/erp/files.ts", fn: "getDocFile", guard: `DOC_KIND_MODULE[rows[0].kind]` },
  { file: "src/lib/erp/cutover.ts", fn: "dbStatus", guard: `assertCan(sql, context.userId, "settings", "view")` },
  { file: "src/lib/erp/orders.ts", fn: "orderLookups", guard: `assertCan(sql, context.userId, "sales", "view")` },
  // márgenes y costos: solo quien puede verlos
  { file: "src/lib/erp/orders.ts", fn: "getDealPnl", guard: `canSeeMargins(me.role)` },
  { file: "src/lib/erp/reports.ts", fn: "listDealPnl", guard: `canSeeMargins(me.role)` },
  { file: "src/lib/erp/reports.ts", fn: "getCompanyPnl", guard: `canSeeMargins(me.role)` },
  { file: "src/lib/erp/requests.ts", fn: "saveLineMargin", guard: `canSeeMargins(me.role)` },
  // Familia "elegir proveedor": vive en la solicitud (quotes), no en compras
  // (sesión de permisos, 7-sep-2026) — antes exigían purchases:edit y
  // bloqueaban a ventas en su propia pantalla.
  { file: "src/lib/erp/requests.ts", fn: "saveLineFreight", guard: `assertCan(sql, context.userId, "quotes", "edit")` },
  { file: "src/lib/erp/requests.ts", fn: "sendVendorRfq", guard: `assertCan(sql, context.userId, "quotes", "edit")` },
  { file: "src/lib/erp/requests.ts", fn: "pickVendor", guard: `assertCan(sql, context.userId, "quotes", "edit")` },
  { file: "src/lib/erp/requests.ts", fn: "applyCheapest", guard: `assertCan(sql, context.userId, "quotes", "edit")` },
  // applyRfqWinners: /rfq es compras sin excepción, sea de inventario o de
  // cliente — ya no alterna a quotes:edit para las RFQ de cliente.
  { file: "src/lib/erp/rfq.ts", fn: "applyRfqWinners", guard: `assertCan(sql, context.userId, "purchases", "edit")` },
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
    [ops, "decideQuote", "decidir cotización"],
    [users, "approveAccess", "alta de usuario"],
    [users, "rejectAccess", "rechazo de solicitud"],
    [users, "updateMember", "cambio de rol/permisos"],
  ]) {
    assert.ok(fnBody(source, fn).includes("writeAudit("), `${fn}: falta bitácora de ${label}`);
  }
  // Facturar mora: la bitácora vive centralizada en issueMoraInvoice (todas
  // las FI — manuales o automáticas al cobrar — pasan por ahí con su cálculo).
  const moraFn = ops.slice(ops.indexOf("export async function issueMoraInvoice"));
  assert.ok(moraFn.includes("writeAudit("), "issueMoraInvoice: falta bitácora de facturar mora");
  assert.ok(az.includes("issueMoraInvoice(sql, m.company_id, data.invoiceId, { requireCharge: true, userId: context.userId })"), "applyLateInterest debe pasar el usuario para la bitácora");
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
// Actualizado en la sesión de permisos (7-sep-2026): cobrarPagar pasó de
// banks a credit; mandarCorreos se partió en una entrada por documento
// (SendButton ya no exige credit:edit fijo); se agregaron las de la solicitud
// (elegirProveedorSolicitud) y el cierre de RFQ (cerrarRfq).
const OPS = {
  cobrarPagar: ["credit", "edit"],
  recibirMercancia: ["purchases", "edit"],
  entregarMercancia: ["sales", "edit"],
  crearOC: ["purchases", "edit"],
  cerrarRfq: ["purchases", "edit"],
  elegirProveedorSolicitud: ["quotes", "edit"],
  facturarMora: ["credit", "edit"],
  conciliarBanco: ["banks", "edit"],
  enviarCotizacion: ["quotes", "edit"],
  enviarPedido: ["sales", "edit"],
  enviarOCoRFQ: ["purchases", "edit"],
  enviarFactura: ["credit", "edit"],
  enviarEstadoCuenta: ["statements", "edit"],
  ajustarStock: ["inventory", "edit"],
  verCartera: ["credit", "view"],
  verEstadoCuenta: ["statements", "view"],
  administrarUsuarios: ["users", "edit"],
  importarCorte: ["settings", "edit"],
};

test("almacén: existencias, entregas y recepción sí; dinero, cartera y correos de cliente no", () => {
  const u = { status: "active", role: "almacen" };
  assert.equal(can(u, ...OPS.ajustarStock), true);
  assert.equal(can(u, ...OPS.entregarMercancia), true);
  assert.equal(can(u, ...OPS.recibirMercancia), true);
  assert.equal(can(u, ...OPS.crearOC), true);
  assert.equal(can(u, ...OPS.cerrarRfq), true);
  assert.equal(can(u, ...OPS.enviarOCoRFQ), true);
  assert.equal(can(u, ...OPS.enviarPedido), true);
  // Efecto lateral bueno del repunteo 1: antes almacén heredaba
  // "elegir proveedor" de su purchases:edit aunque tiene quotes:none; ahora
  // que esa familia pide quotes:edit, se cierra sola sin tocar su plantilla.
  assert.equal(can(u, ...OPS.elegirProveedorSolicitud), false);
  assert.equal(can(u, ...OPS.enviarCotizacion), false);
  assert.equal(can(u, ...OPS.cobrarPagar), false);
  assert.equal(can(u, ...OPS.facturarMora), false);
  assert.equal(can(u, ...OPS.conciliarBanco), false);
  assert.equal(can(u, ...OPS.enviarFactura), false);
  assert.equal(can(u, ...OPS.verCartera), false);
  assert.equal(can(u, ...OPS.verEstadoCuenta), false);
  assert.equal(can(u, ...OPS.administrarUsuarios), false);
  // Pendiente, anotado en ESTADO.md H4e: sales:edit/purchases:edit siguen
  // completos (crear/editar pedido y OC), no solo entregar/recibir. No se
  // repuntea aquí: hace falta un nivel angosto que hoy no existe.
});

test("ventas: cierra su propia solicitud→cotización→pedido, incluida elegir proveedor y enviar por correo", () => {
  const u = { status: "active", role: "ventas" };
  assert.equal(can(u, ...OPS.verCartera), true);
  assert.equal(can(u, "inventory", "view"), true); // lectura de existencias para prometer entrega
  // Repunteo 1: elegir proveedor / enviar RFQ / aplicar el más barato / flete
  // vivían en la solicitud (quotes) pero pedían purchases:edit — bloqueaba a
  // ventas en su propia pantalla. Ahora piden quotes:edit.
  assert.equal(can(u, ...OPS.elegirProveedorSolicitud), true);
  // Repunteo 4: "Enviar como Azagro" ya no exige credit:edit fijo — ventas
  // manda su propia cotización y su propio pedido.
  assert.equal(can(u, ...OPS.enviarCotizacion), true);
  assert.equal(can(u, ...OPS.enviarPedido), true);
  // Lo que sigue sin ser de ventas, sin cambio:
  assert.equal(can(u, ...OPS.cobrarPagar), false);
  assert.equal(can(u, ...OPS.crearOC), false);
  assert.equal(can(u, ...OPS.cerrarRfq), false);
  assert.equal(can(u, ...OPS.recibirMercancia), false);
  assert.equal(can(u, ...OPS.enviarOCoRFQ), false);
  assert.equal(can(u, ...OPS.enviarFactura), false);
  assert.equal(can(u, ...OPS.conciliarBanco), false);
  assert.equal(can(u, ...OPS.importarCorte), false);
  assert.equal(can(u, ...OPS.administrarUsuarios), false);
});

test("compras: cierra su propio RFQ→OC→recepción y envía sus documentos, sin entrar a cotizaciones", () => {
  const u = { status: "active", role: "compras" };
  assert.equal(can(u, ...OPS.crearOC), true);
  assert.equal(can(u, ...OPS.recibirMercancia), true);
  // Repunteo 2: applyRfqWinners ya no alterna a quotes:edit para las RFQ de
  // cliente — compras cierra CUALQUIER RFQ que ve en su propia pantalla.
  assert.equal(can(u, ...OPS.cerrarRfq), true);
  // Repunteo 4: compras manda su propia OC/RFQ por correo.
  assert.equal(can(u, ...OPS.enviarOCoRFQ), true);
  assert.equal(can(u, ...OPS.ajustarStock), true);
  // La solicitud y la cotización del cliente siguen sin ser de compras
  // (por diseño: no entra ni a /solicitudes, quotes:none).
  assert.equal(can(u, ...OPS.elegirProveedorSolicitud), false);
  assert.equal(can(u, ...OPS.enviarCotizacion), false);
  assert.equal(can(u, ...OPS.enviarPedido), false);
  assert.equal(can(u, ...OPS.cobrarPagar), false);
  assert.equal(can(u, ...OPS.enviarFactura), false);
  assert.equal(can(u, ...OPS.conciliarBanco), false);
  assert.equal(can(u, ...OPS.administrarUsuarios), false);
});

test("contabilidad (administración): cartera y bancos sí, kardex no", () => {
  const u = { status: "active", role: "administracion" };
  assert.equal(can(u, ...OPS.cobrarPagar), true);
  assert.equal(can(u, ...OPS.facturarMora), true);
  assert.equal(can(u, ...OPS.conciliarBanco), true);
  assert.equal(can(u, ...OPS.enviarFactura), true);
  assert.equal(can(u, ...OPS.enviarEstadoCuenta), true);
  assert.equal(can(u, ...OPS.ajustarStock), false);
  assert.equal(can(u, ...OPS.recibirMercancia), false);
  assert.equal(can(u, ...OPS.entregarMercancia), false);
  assert.equal(can(u, ...OPS.elegirProveedorSolicitud), false);
  assert.equal(can(u, ...OPS.enviarCotizacion), false);
  assert.equal(can(u, ...OPS.enviarPedido), false);
  assert.equal(can(u, ...OPS.enviarOCoRFQ), false);
  assert.equal(can(u, ...OPS.administrarUsuarios), false);
});

test("cobranza: cobra, factura mora y envía factura/estado de cuenta, nada de operación", () => {
  const u = { status: "active", role: "cobranza" };
  assert.equal(can(u, ...OPS.cobrarPagar), true);
  assert.equal(can(u, ...OPS.facturarMora), true);
  assert.equal(can(u, ...OPS.conciliarBanco), true);
  assert.equal(can(u, ...OPS.enviarFactura), true);
  assert.equal(can(u, ...OPS.enviarEstadoCuenta), true);
  assert.equal(can(u, ...OPS.elegirProveedorSolicitud), false);
  assert.equal(can(u, ...OPS.enviarCotizacion), false);
  assert.equal(can(u, ...OPS.enviarPedido), false);
  assert.equal(can(u, ...OPS.enviarOCoRFQ), false);
  assert.equal(can(u, ...OPS.crearOC), false);
  assert.equal(can(u, ...OPS.recibirMercancia), false);
  assert.equal(can(u, ...OPS.entregarMercancia), false);
  assert.equal(can(u, ...OPS.ajustarStock), false);
});

test("sesión de permisos (7-sep-2026): ningún rol operativo se queda sin cerrar su propio tramo", () => {
  // El resumen que le importa al dueño: por rol, la acción que antes truena
  // en su propia pantalla ahora pasa, y nada que no le toca se abre de más.
  const ventas = { status: "active", role: "ventas" };
  const compras = { status: "active", role: "compras" };
  const cobranza = { status: "active", role: "cobranza" };
  assert.equal(can(ventas, ...OPS.elegirProveedorSolicitud) && can(ventas, ...OPS.enviarCotizacion) && can(ventas, ...OPS.enviarPedido), true, "ventas cierra solicitud→cotización→pedido sola");
  assert.equal(can(compras, ...OPS.cerrarRfq) && can(compras, ...OPS.enviarOCoRFQ), true, "compras cierra RFQ→OC sola");
  assert.equal(can(cobranza, ...OPS.cobrarPagar) && can(cobranza, ...OPS.enviarFactura) && can(cobranza, ...OPS.enviarEstadoCuenta), true, "cobranza cobra y envía sola");
  // Y ninguno de los tres se metió a lo que no le toca.
  assert.equal(can(ventas, ...OPS.cerrarRfq) || can(ventas, ...OPS.enviarOCoRFQ) || can(ventas, ...OPS.cobrarPagar), false, "ventas sigue fuera de compras y cobranza");
  assert.equal(can(compras, ...OPS.elegirProveedorSolicitud) || can(compras, ...OPS.enviarCotizacion) || can(compras, ...OPS.cobrarPagar), false, "compras sigue fuera de ventas y cobranza");
  assert.equal(can(cobranza, ...OPS.elegirProveedorSolicitud) || can(cobranza, ...OPS.cerrarRfq) || can(cobranza, ...OPS.recibirMercancia), false, "cobranza sigue fuera de ventas y compras");
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

// ---------------------------------------------------------------------------
// 3) Sesión de permisos (7-sep-2026): los siete repunteos, uno por uno.
// ---------------------------------------------------------------------------

test("repunteo 6: /quotes ya tiene módulo — antes caía a dashboard y el link nunca se escondía", () => {
  const acl = src("src/lib/erp/acl.ts");
  assert.ok(
    acl.includes('if (pathname.startsWith("/quotes")) return "quotes";'),
    "pathModule debe mapear /quotes a quotes",
  );
  // Las 26 rutas de src/routes tienen que tener dueño explícito (ninguna cae
  // al "dashboard" del final salvo /ayuda y la raíz, que sí son de dashboard).
  const pm = acl.slice(acl.indexOf("export function pathModule"), acl.indexOf("export function isAppRole"));
  for (const prefix of ["/cpo", "/solicitudes", "/cotizador", "/quotes", "/rfq", "/sales", "/purchases", "/inventory", "/bodegas", "/credit", "/cadena", "/vencimientos", "/gastos", "/banks", "/statements", "/reportes", "/partners", "/products", "/settings", "/importar", "/bitacora", "/users", "/ayuda"]) {
    assert.ok(pm.includes(`"${prefix}"`), `pathModule no menciona ${prefix}`);
  }
});

test("repunteo 7: los archivos del folio piden el permiso del tipo de documento, no sales fijo", () => {
  const files = src("src/lib/erp/files.ts");
  // Copia de DOC_KIND_MODULE — si el mapa cambia en files.ts, revisar aquí.
  const DOC_KIND_MODULE = { sale: "sales", purchase: "purchases", invoice: "credit", request: "quotes", rfq: "purchases", cutover: "settings" };
  for (const [kind, mod] of Object.entries(DOC_KIND_MODULE)) {
    assert.ok(files.includes(`${kind}: "${mod}"`), `DOC_KIND_MODULE no tiene ${kind}: "${mod}"`);
  }
  assert.ok(fnBody(files, "listDocFiles").includes("DOC_KIND_MODULE[data.kind]"), "listDocFiles debe leer el módulo del kind");
  assert.ok(fnBody(files, "uploadDocFile").includes("DOC_KIND_MODULE[data.kind]"), "uploadDocFile debe leer el módulo del kind");
  assert.ok(fnBody(files, "getDocFile").includes("DOC_KIND_MODULE[rows[0].kind]"), "getDocFile debe leer el kind del archivo antes de exigir el permiso");
  assert.ok(!files.includes('"cutover" ? "settings" : "sales"'), "el ternario fijo viejo no debe reaparecer");
});

test("repunteo 4: SendButton exige el permiso del documento, no credit:edit fijo, en sus siete pantallas", () => {
  const sendDoc = src("src/components/send-doc.tsx");
  assert.ok(sendDoc.includes("module: SendModule"), "SendButton debe recibir el módulo como prop obligatoria");
  assert.ok(
    sendDoc.includes("sendDirectMail({ data: { to: toEmail, subject: `${title} ${number}`, text, module } })"),
    "sendDirectMail debe recibir el módulo de la pantalla",
  );
  const alerts = src("src/lib/erp/alerts.ts");
  assert.ok(
    alerts.includes('module: z.enum(["quotes", "sales", "purchases", "credit", "statements"])'),
    "sendDirectMail debe validar el módulo contra la lista cerrada de documentos que se envían",
  );
  // Cada pantalla pasa el módulo que le corresponde a ELLA, no uno fijo.
  const sites = [
    ["src/routes/credit.tsx", "credit"],
    ["src/routes/quotes.tsx", "quotes"],
    ["src/routes/sales.$orderId.tsx", "sales"],
    ["src/routes/rfq.$rfqId.tsx", "purchases"],
    ["src/routes/statements.tsx", "statements"],
    ["src/routes/solicitudes.$solicitudId.tsx", "quotes"],
    ["src/routes/purchases.tsx", "purchases"],
  ];
  for (const [file, mod] of sites) {
    const body = src(file);
    const at = body.indexOf("<SendButton");
    assert.notEqual(at, -1, `${file}: no monta <SendButton`);
    const chunk = body.slice(at, body.indexOf("/>", at) === -1 ? undefined : body.indexOf("/>", at) + 2);
    assert.ok(chunk.includes(`module="${mod}"`), `${file}: <SendButton> debe llevar module="${mod}"`);
  }
});

test("repunteo 5: registrar cobro/pago vive en Cartera, no en Bancos", () => {
  const az = src("src/lib/azagro.ts");
  assert.ok(
    fnBody(az, "registerPayment").includes('assertCan(sql, context.userId, "credit", "edit")'),
    "registerPayment debe exigir credit:edit",
  );
  // addBankMove (alta directa desde /banks) es un camino distinto: se queda con banks:edit.
  const ops = src("src/lib/erp/ops.ts");
  assert.ok(
    fnBody(ops, "addBankMove").includes('assertCan(sql, context.userId, "banks", "edit")'),
    "addBankMove debe seguir exigiendo banks:edit",
  );
});

test("repunteo 3: el botón Recibir del pedido se esconde sin purchases:edit", () => {
  const s = src("src/routes/sales.$orderId.tsx");
  assert.ok(s.includes('const canReceive = can("purchases", "edit");'), "falta el candado de visibilidad");
  assert.ok(
    s.includes("canEdit && canReceive && po.state"),
    "el botón Recibir debe exigir canReceive además de canEdit",
  );
});

// ---------------------------------------------------------------------------
// 4) Cartera propia (own_only): extendida a cotizaciones, pedidos, facturas
//    y reportes — antes solo escondía la ficha del cliente y el estado de
//    cuenta, dejando ver el pedido/cotización/margen del mismo cliente.
// ---------------------------------------------------------------------------

test("own_only: listQuotes, listOrders, listInvoices y reports.ts filtran por vendedor del cliente", () => {
  const clause = "own_only} = false or";
  const cases = [
    ["src/lib/erp/ops.ts", "listQuotes", "p.seller_id"],
    ["src/lib/erp/orders.ts", "listOrders", "pt.seller_id"],
    ["src/lib/azagro.ts", "listInvoices", "p.seller_id"],
    ["src/lib/erp/reports.ts", "listDealPnl", "p.seller_id"],
    ["src/lib/erp/reports.ts", "getPanorama", "p.seller_id"],
    ["src/lib/erp/reports.ts", "getUpcomingDue", "p.seller_id"],
  ];
  for (const [file, fn, sellerCol] of cases) {
    const body = fnBody(src(file), fn);
    assert.ok(body.includes(clause), `${fn} (${file}): falta el filtro own_only`);
    assert.ok(body.includes(`${sellerCol} = \${context.userId} or ${sellerCol} is null`), `${fn} (${file}): el filtro no cubre "sin vendedor asignado"`);
  }
});

test("own_only: getCompanyPnl NO se filtra por vendedor (es un total de toda la empresa, no tiene cliente)", () => {
  const body = fnBody(src("src/lib/erp/reports.ts"), "getCompanyPnl");
  assert.ok(!body.includes("own_only"), "getCompanyPnl no debe llevar el filtro: no hay 'mi parte' de un total consolidado");
});

test("clientes sin vendedor: aviso visible en el tablero, no solo el escape del filtro", () => {
  const az = src("src/lib/azagro.ts");
  const dash = fnBody(az, "getDashboard");
  assert.ok(dash.includes("is_customer = true and seller_id is null"), "getDashboard debe contar clientes sin vendedor");
  assert.ok(dash.includes("orphanCustomers"), "getDashboard debe devolver el conteo");
  const idx = src("src/routes/index.tsx");
  assert.ok(idx.includes("data?.orphanCustomers"), "el tablero debe mostrar el aviso sin que nadie lo busque");
  assert.ok(idx.includes("sin vendedor asignado"), "el aviso debe decir qué significa el número");
});

test("el dueño confirmó quién ve costo y margen: queda escrito, no solo en el código", () => {
  const claude = src("CLAUDE.md");
  assert.ok(claude.includes("admin, gerencia y compras"), "CLAUDE.md debe decir quién ve costo de compra");
  assert.ok(claude.includes("admin, gerencia y administración"), "CLAUDE.md debe decir quién ve margen");
  assert.ok(!claude.includes("Solo admin: costos de compra"), "la regla vieja (\"solo admin\") no debe quedar escrita en ningún lado");
});

test("almacén con permiso completo (sales/purchases:edit) queda anotado como pregunta abierta, no resuelto en silencio", () => {
  const estado = src("ESTADO.md");
  assert.ok(estado.includes("### H4e."), "falta la pregunta H4e en ESTADO.md");
  assert.ok(estado.includes("Un tercer nivel de `AclLevel`"), "falta la opción (a) con su costo");
  assert.ok(estado.includes("Una bandera aparte"), "falta la opción (b) con su costo");
});
