import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

function fnBody(source, name) {
  const start = source.indexOf(`export const ${name} `);
  assert.notEqual(start, -1, `No existe export const ${name}`);
  const rest = source.slice(start + 10);
  const next = rest.search(/\nexport /);
  return next === -1 ? rest : rest.slice(0, next);
}

// ---------------------------------------------------------------------------
// CRÍTICO 1 — el pedido confirmado no se edita sin rastro.
// ---------------------------------------------------------------------------
test("editar un pedido deja bitácora con anterior → nuevo, y marca los confirmados", () => {
  const ord = src("src/lib/erp/orders.ts");
  const save = fnBody(ord, "saveOrder");
  assert.ok(save.includes(`"editar-pedido"`), "toda edición de pedido va a bitácora");
  assert.ok(save.includes(`"crear-pedido"`), "la creación de pedido va a bitácora");
  assert.ok(save.includes("precio ${Number(ol.unit_price)} → ${nl.unitPrice}"), "los cambios de precio quedan con anterior → nuevo");
  assert.ok(save.includes("cant ${Number(ol.qty)} → ${nl.qty}"), "los cambios de cantidad quedan con anterior → nuevo");
  assert.ok(save.includes(`CONFIRMADO · `), "las ediciones a pedidos confirmados quedan marcadas");
  assert.ok(save.includes("estado ${current[0].state} → ${nextState}"), "confirmar también deja rastro");
});

// ---------------------------------------------------------------------------
// CRÍTICO 2 — la FI guarda su cálculo, y los demás cálculos también.
// ---------------------------------------------------------------------------
test("la FI guarda TIIE, spread, días, capital y FEGA, con autor y desglose", () => {
  const ops = src("src/lib/erp/ops.ts");
  const mora = ops.slice(ops.indexOf("export async function issueMoraInvoice"));
  assert.ok(mora.includes("${rateLabel(pick)} vigente al ${moraDue}"), "la FI guarda la TIIE usada y de qué renglón de la tabla salió");
  assert.ok(mora.includes("requireRate("), "sin renglón de TIIE no se emite FI (error claro), no se estima");
  assert.ok(mora.includes("spread ${(pol.collectionSpread * 100).toFixed(2)}%"), "la FI guarda el spread");
  assert.ok(mora.includes("d vencidos"), "la FI guarda los días");
  assert.ok(mora.includes("capital (cargo original)"), "la FI guarda el capital base");
  assert.ok(mora.includes("created_by, calc, calc_client, int_part, fega_part"), "la FI guarda autor, fórmula y desglose interés/FEGA");
  assert.ok(mora.includes("writeAudit("), "la emisión de FI (manual o al cobrar) queda en bitácora");
});

test("la FV congela sus parámetros al emitirse (foto contra cambios futuros de Ajustes)", () => {
  const az = src("src/lib/azagro.ts");
  const deliver = fnBody(az, "deliverSale");
  for (const campo of ["tiieIssue", "costSpread", "commissionRate", "financialDays", "collectionSpread", "fegaRate"]) {
    assert.ok(deliver.includes(campo), `la foto de la FV incluye ${campo}`);
  }
  assert.ok(deliver.includes("params_snap"), "la foto se guarda en la factura");
  assert.ok(
    deliver.includes("const tiiePick = financedDays > 0 ? requireRate(tiieTable, today, `emisión de ${iname} a crédito`) : nearestRate(tiieTable, today);"),
    "a crédito la FV exige renglón de TIIE (se detiene sin él); de contado guarda el que haya o nada, nunca un número del código",
  );
  const rep = src("src/lib/erp/reports.ts");
  assert.ok(rep.includes("JSON.parse(fv[0].params_snap)"), "el P&L usa la foto guardada, no los Ajustes de hoy");
  assert.ok(rep.includes("snap.tiieIssue != null"), "la TIIE de emisión sale de la foto; si no hay foto, de la tabla (con fecha), nunca de un número del código");
});

// ---------------------------------------------------------------------------
// 3 — bitácora como herramienta.
// ---------------------------------------------------------------------------
test("la bitácora filtra por folio/texto, tipo, usuario y fechas, con paginación", () => {
  const audit = src("src/lib/erp/audit.ts");
  const list = fnBody(audit, "listAudit");
  assert.ok(list.includes("a.name ilike") && list.includes("a.detail ilike"), "búsqueda por folio o texto");
  assert.ok(list.includes("a.action = ${action}"), "filtro por tipo de movimiento");
  assert.ok(list.includes("a.user_id = ${userId}"), "filtro por usuario");
  assert.ok(list.includes("a.created_at >=") && list.includes("a.created_at <="), "filtro por rango de fechas");
  assert.ok(list.includes("offset ${offset}"), "paginación (ya no hay tope de 200)");
  const ui = src("src/routes/bitacora.tsx");
  assert.ok(ui.includes("Cargar más"), "la pantalla puede seguir cargando historia");
  for (const label of ["Descuento pronto pago", "Ajuste TC", "RECHAZADO por límite", "RECHAZADO sin permiso", "Cambio de parámetros", "Editó pedido", "Renegoció cotización"]) {
    assert.ok(ui.includes(label), `la pantalla traduce la acción: ${label}`);
  }
});

// ---------------------------------------------------------------------------
// 4 — ciclo comercial con huella; renegociar conserva precios anteriores.
// ---------------------------------------------------------------------------
test("crear solicitud/cotización/OC, margen y proveedor ganador dejan bitácora", () => {
  const req = src("src/lib/erp/requests.ts");
  const ops = src("src/lib/erp/ops.ts");
  const az = src("src/lib/azagro.ts");
  assert.ok(fnBody(req, "createRequest").includes(`"crear-solicitud"`), "crear solicitud");
  assert.ok(fnBody(req, "updateRequest").includes(`"editar-solicitud"`), "editar solicitud");
  // Dos márgenes por partida: la bitácora dice cuál (contado / crédito) y anterior → nuevo.
  assert.ok(fnBody(req, "saveLineMargin").includes("margen ${etiqueta} ${old} → ${nuevo}"), "margen con cuál, anterior → nuevo");
  assert.ok(fnBody(req, "pickVendor").includes(`"elegir-proveedor"`), "proveedor ganador manual");
  assert.ok(fnBody(req, "applyCheapest").includes(`"elegir-proveedor"`), "proveedor ganador automático");
  assert.ok(fnBody(ops, "createQuote").includes(`"crear-cotizacion"`), "crear cotización");
  assert.ok(fnBody(az, "createPurchase").includes(`"crear-oc"`), "crear OC (y la FP que genera)");
});

test("renegociar una cotización guarda los precios anteriores en la bitácora", () => {
  const ops = src("src/lib/erp/ops.ts");
  const revise = fnBody(ops, "reviseQuote");
  assert.ok(revise.includes(`"renegociar-cotizacion"`), "la renegociación queda en bitácora");
  assert.ok(revise.includes("const oldLines = await sql"), "lee los precios ANTES de sobreescribirlos");
  assert.ok(revise.includes("Rev ${q[0].revision} → ${q[0].revision + 1}"), "queda de qué revisión a cuál se pasó");
  assert.ok(revise.includes("precio ${Number(prev.cash_price)}/${Number(prev.credit_price)} →"), "los precios viejos quedan escritos");
});

// ---------------------------------------------------------------------------
// 5 — cambios sensibles con anterior → nuevo.
// ---------------------------------------------------------------------------
test("límite de crédito, costo/precio de producto y saldo inicial de banco a bitácora", () => {
  const az = src("src/lib/azagro.ts");
  const ops = src("src/lib/erp/ops.ts");
  const partner = fnBody(az, "savePartner");
  assert.ok(partner.includes(`"credito-cliente"`) && partner.includes("límite ${Number(before[0].credit_limit)} →"), "límite de crédito con anterior → nuevo");
  const product = fnBody(az, "saveProduct");
  assert.ok(product.includes(`"precio-producto"`) && product.includes("costo ${Number(before[0].cost)} →"), "costo/precio con anterior → nuevo");
  const bank = fnBody(ops, "saveBankOpening");
  assert.ok(bank.includes(`"saldo-banco"`) && bank.includes("Saldo inicial ${Number(before[0].opening)} →"), "saldo inicial de banco con anterior → nuevo");
});

// ---------------------------------------------------------------------------
// 6 — lo que NO pasó también deja rastro.
// ---------------------------------------------------------------------------
test("intentos sin permiso, rechazos por crédito e importaciones fallidas se registran", () => {
  const acl = src("src/lib/erp/acl.ts");
  assert.ok(acl.includes("'rechazado-permiso'"), "assertCan registra el intento rechazado");
  assert.ok(acl.includes("conexión fresca") || acl.includes("logDenied"), "el registro sobrevive al rollback del rechazo");
  const ord = src("src/lib/erp/orders.ts");
  assert.ok(fnBody(ord, "saveOrder").includes(`"rechazado-credito"`), "el rebote por límite de crédito queda registrado");
  const az = src("src/lib/azagro.ts");
  assert.ok(fnBody(az, "createSale").includes(`"rechazado-credito"`), "también en el camino alterno de venta");
  const cut = src("src/lib/erp/cutover.ts");
  assert.ok(cut.includes(`"importacion-fallida"`), "una importación que truena deja constancia");
  assert.ok((cut.match(/logImportFailure\(boot/g) ?? []).length >= 2, "aplica a saldos abiertos y a existencias");
});

// ---------------------------------------------------------------------------
// 7 — estado de cuenta a fecha pasada: el estado REAL de ese día.
// ---------------------------------------------------------------------------
test("reconstrucción histórica: saldo al corte = cargo − abono Compaq − pagos hasta esa fecha", () => {
  // Fórmula del corte histórico (copia de getLiveStatement):
  const cargo = 150000;
  const openingPaid = 20000;
  const pagos = [
    { date: "2026-03-10", amount: 30000 },
    { date: "2026-04-20", amount: 100000 }, // pago posterior al corte
  ];
  const asOf = "2026-03-31";
  const abonoAlCorte = pagos.filter((p) => p.date <= asOf).reduce((s, p) => s + p.amount, 0);
  const saldoAlCorte = Math.max(0, cargo - openingPaid - abonoAlCorte);
  assert.equal(abonoAlCorte, 30000);
  assert.equal(saldoAlCorte, 100000); // NO 0: el pago de abril no existía ese día
  const ops = src("src/lib/erp/ops.ts");
  assert.ok(ops.includes("const historico = asOf <"), "detecta el corte histórico");
  assert.ok(ops.includes("historico ? allocsAll.filter((p) => p.date <= asOf) : allocsAll"), "solo pagos hasta la fecha");
  assert.ok(ops.includes("cargo - Number(inv.opening_paid) - abono"), "saldo reconstruido de ese día");
  assert.ok(ops.includes("historico ? invoices.filter((i) => i.date <= asOf)"), "solo facturas que ya existían");
  assert.ok(ops.includes("misFis.reduce((s, f) => s + Number(f.int_part), 0)"), "FI hasta la fecha, con su desglose guardado");
});

// ---------------------------------------------------------------------------
// 8 — las facturas llevan autor.
// ---------------------------------------------------------------------------
test("FV, FP, NC, FI, ATC y facturas de corte guardan quién las generó", () => {
  const az = src("src/lib/azagro.ts");
  const ops = src("src/lib/erp/ops.ts");
  const cut = src("src/lib/erp/cutover.ts");
  const stock = src("src/lib/erp/stock.ts");
  assert.ok(stock.includes("add column if not exists created_by"), "la columna de autor existe");
  assert.ok(fnBody(az, "deliverSale").includes("created_by"), "FV con autor");
  assert.ok(fnBody(az, "createPurchase").includes("created_by"), "FP de OC con autor");
  assert.ok(fnBody(az, "receivePurchase").includes("created_by"), "FP de recepción con autor");
  assert.ok(fnBody(az, "returnSale").includes("created_by"), "NC con autor");
  assert.ok(ops.slice(ops.indexOf("export async function issueMoraInvoice")).includes("created_by"), "FI con autor");
  assert.ok(ops.slice(ops.indexOf("export async function applyInvoicePayment"), ops.indexOf("export const addBankMove")).includes("created_by"), "ATC con autor");
  assert.ok(cut.includes("opening_paid, policy_code, created_by"), "facturas importadas con autor y con su política de cobro");
});

// ---------------------------------------------------------------------------
// Pendientes menores cerrados + decisión de negocio (bloque final).
// ---------------------------------------------------------------------------
test("folios con candado de unicidad (migración y arranque), sin romper el corte Compaq", () => {
  const mig = src("migrations/0015_folios_unicos.sql");
  const az = src("src/lib/azagro.ts");
  for (const fuente of [mig, az]) {
    assert.ok(fuente.includes("invoices_folio_uq on invoices (company_id, name) where cutover_key is null"), "facturas del sistema únicas; importadas fuera (folios de terceros)");
    assert.ok(fuente.includes("sales_orders_folio_uq"), "pedidos únicos");
    assert.ok(fuente.includes("purchase_orders_folio_uq"), "OCs únicas");
    assert.ok(fuente.includes("quotes_folio_uq"), "cotizaciones únicas");
    assert.ok(fuente.includes("payments_folio_uq"), "pagos únicos");
    assert.ok(fuente.includes("stock_moves_ref_uq"), "referencias de kardex únicas");
  }
  assert.ok(az.includes("await ensureFolioLocks(sql)"), "el candado también corre en PGLite al arrancar");
});

test("decisión de negocio: tras confirmar, cliente y moneda quedan fijos; precio y fechas siguen con rastro", () => {
  const ord = src("src/lib/erp/orders.ts");
  const save = fnBody(ord, "saveOrder");
  assert.ok(save.includes("Pedido confirmado: el cliente no se cambia"), "cliente bloqueado tras confirmar");
  assert.ok(save.includes("Pedido confirmado: la moneda no se cambia"), "moneda bloqueada tras confirmar");
  // Precios y fechas NO se bloquean: siguen pasando por el diff con bitácora.
  assert.ok(save.includes("precio ${Number(ol.unit_price)} → ${nl.unitPrice}"), "el precio sigue editable con rastro");
  assert.ok(save.includes("fecha ${current[0].date} → ${data.date}"), "la fecha sigue editable con rastro");
});

test("borrar una solicitud deja el contenido completo escrito en la bitácora", () => {
  const req = src("src/lib/erp/requests.ts");
  const del = fnBody(req, "deleteRequest");
  assert.ok(del.includes("const contenido = await sql"), "lee las partidas ANTES de borrar");
  assert.ok(del.includes("partidas:"), "las partidas quedan en el detalle");
  assert.ok(del.includes("costo ${Number(l.cost)}"), "con costo");
  assert.ok(del.includes("prov ${l.supplier}"), "con proveedor elegido");
  assert.ok(del.includes("margen ${Number(l.margin_pct)}%"), "con margen");
  assert.ok(del.includes(".slice(0, 900)"), "acotado para no desbordar la bitácora");
});

test("los recordatorios de cobro quedan registrados (enviado vs borrador abierto)", () => {
  const alerts = src("src/lib/erp/alerts.ts");
  const uno = fnBody(alerts, "sendPaymentReminder");
  assert.ok(uno.includes(`"recordatorio"`), "el recordatorio individual va a bitácora");
  assert.ok(uno.includes("Enviado a ${to}"), "cuando salió por correo directo, dice a quién");
  assert.ok(uno.includes("Borrador abierto"), "cuando solo se abrió el correo, también queda claro");
  const masivo = fnBody(alerts, "sendPartnerReminders");
  assert.ok(masivo.includes("Recordatorios masivos"), "el envío masivo queda con conteo");
  const interno = fnBody(alerts, "sendDueAlerts");
  assert.ok(interno.includes("Aviso interno de vencimientos"), "el aviso al equipo también");
  const ui = src("src/routes/bitacora.tsx");
  assert.ok(ui.includes("Recordatorio de cobro"), "la pantalla lo traduce");
});

test("bitácora: el filtro de fechas no truena cuando 'Desde'/'Hasta' vienen vacíos", () => {
  const audit = src("src/lib/erp/audit.ts");
  const list = fnBody(audit, "listAudit");
  // El bug real: concatenar "" + "T00:00:00" y castear siempre a timestamptz
  // tronaba con "invalid input syntax" aunque el filtro no se usara.
  assert.ok(!list.includes('${from} = \'\' or a.created_at'), "ya no debe castear la cadena vacía concatenada");
  assert.ok(!list.includes('${to} = \'\' or a.created_at'), "ya no debe castear la cadena vacía concatenada");
  assert.ok(list.includes("const fromTs = from ?"), "null explícito cuando no hay 'Desde'");
  assert.ok(list.includes("const toTs = to ?"), "null explícito cuando no hay 'Hasta'");
  assert.ok(list.includes("${fromTs}::timestamptz is null or"), "compara contra null, nunca castea una cadena vacía");
  assert.ok(list.includes("${toTs}::timestamptz is null or"), "compara contra null, nunca castea una cadena vacía");
});
