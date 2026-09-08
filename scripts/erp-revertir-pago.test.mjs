// BLOQUE DE DESHACER — PASO 5 (8-sep-2026): reversa de un cobro o pago.
//
// Decisión 16: nunca se borra un movimiento de dinero; se mete uno contrario
// y quedan los tres. Decisión 21: la FI se queda. Decisión 22: la reversa del
// banco nace sin conciliar y el original no se toca. Decisión 25: una acción
// que enseña todo y pregunta una vez.
//
// Prueba central: el saldo del banco y el de la cartera quedan EXACTAMENTE
// como estaban antes del cobro, al centavo — por construcción (+A −A), no por
// un cálculo aparte — y los tres movimientos quedan visibles y ligados.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

function fnBody(source, name) {
  const markers = [`export const ${name} `, `export async function ${name}(`, `export function ${name}(`, `async function ${name}(`, `function ${name}(`];
  const start = markers.map((m) => source.indexOf(m)).find((i) => i !== -1);
  assert.notEqual(start, undefined, `No existe ${name}`);
  const rest = source.slice(start);
  const next = rest.slice(10).search(/\n(export )?(async )?function |\nexport const /);
  return next === -1 ? rest : rest.slice(0, next + 10);
}

// ---------------------------------------------------------------------------
// 1) CENTRAL — identidad al centavo, por construcción.
//    Copia literal de cómo se rehace el saldo (refreshInvoiceResidual: amount −
//    opening_paid − Σ abonos) y de cómo se lee el banco (opening + Σ movimientos).
// ---------------------------------------------------------------------------
const residualOf = (amount, openingPaid, allocs) => Math.max(0, amount - openingPaid - allocs.reduce((s, a) => s + a, 0));
const bankOf = (opening, moves) => opening + moves.reduce((s, m) => s + m, 0);
const r2 = (n) => Math.round(n * 100) / 100;

test("CENTRAL: cartera — con el contra-abono (−A) el saldo vuelve al centavo a lo que era antes del cobro", () => {
  const amount = 186404.55;
  const antes = residualOf(amount, 0, []);
  const conCobro = residualOf(amount, 0, [184300, 2104.55]); // cobro + pronto pago
  assert.equal(conCobro, 0);
  const revertido = residualOf(amount, 0, [184300, 2104.55, -2104.55, -184300]);
  assert.equal(r2(revertido), r2(antes));
  assert.equal(r2(revertido), 186404.55);
  // Con un abono anterior que se queda (LIFO): solo se regresa el último.
  const parcial = residualOf(amount, 0, [50000, 136404.55, -136404.55]);
  assert.equal(r2(parcial), 136404.55, "el abono anterior sigue aplicado");
  // Con abonos del corte Compaq (opening_paid) también cuadra.
  assert.equal(r2(residualOf(100000, 30000, [70000, -70000])), 70000);
});

test("CENTRAL: banco — con el contra-movimiento (−S) el saldo vuelve al centavo a lo que era antes del cobro", () => {
  const opening = 500000;
  const antes = bankOf(opening, [12000.5, -3000]);
  const conCobro = bankOf(opening, [12000.5, -3000, 184300]);
  assert.equal(r2(conCobro - antes), 184300);
  const revertido = bankOf(opening, [12000.5, -3000, 184300, -184300]);
  assert.equal(r2(revertido), r2(antes));
  // Pago a proveedor (sale del banco) y su reversa (entra).
  assert.equal(r2(bankOf(opening, [-38200, 38200])), opening);
});

test("CENTRAL (cableado): el contra-PAG es del MISMO tipo con importe NEGATIVO, ligado por reverses_id; nunca se borra nada", () => {
  const body = fnBody(src("src/lib/erp/reversal.ts"), "applyReversal");
  assert.ok(body.includes("values (${companyId}, ${pv.payment.kind}, ${cname}, ${partnerId}, ${-pv.payment.amount}"), "mismo kind, importe negativo");
  assert.ok(body.includes("${today}, ${pv.payment.id})\n    returning id"), "reverses_id → el PAG original");
  assert.ok(body.includes("insert into payment_allocs (payment_id, invoice_id, amount) values (${contra[0]!.id}, ${invoiceId}, ${-pv.payment.amount})"), "contra-abono negativo en la misma factura");
  assert.ok(body.includes("values (${companyId}, ${chain.bankMove.bank_id}, ${today}, ${-chain.bankMove.amount}"), "contra-movimiento con importe opuesto");
  assert.ok(body.includes("${userId}, false, ${chain.bankMove.id})"), "nace SIN conciliar y ligado al movimiento original (Decisión 22)");
  const c = src("src/lib/erp/reversal.ts");
  assert.ok(!c.includes("delete from"), "Decisión 16: nunca se borra");
  assert.ok(!/update bank_moves set/.test(c), "el movimiento original no se toca, ni su conciliación");
  assert.ok(!/update payments set/.test(c), "el PAG original no se toca");
});

test("por qué negativo y no tipo contrario: el P&L suma cobros y pagos por kind, así netean en cero", () => {
  const reports = src("src/lib/erp/reports.ts");
  assert.ok(reports.includes("where company_id = ${companyId} and kind = 'inbound' and date between"), "cobros = Σ amount de inbound");
  assert.ok(reports.includes("where company_id = ${companyId} and kind = 'outbound' and date between"), "pagos = Σ amount de outbound");
  // Un contra-cobro 'inbound' negativo deja 'cobros' en cero neto; uno 'outbound' positivo inflaría los dos.
  const cobros = [184300, -184300].reduce((s, a) => s + a, 0);
  assert.equal(cobros, 0);
});

// ---------------------------------------------------------------------------
// 2) La cadena: qué se revierte, qué se queda.
// ---------------------------------------------------------------------------
test("la FI se queda (Decisión 21): la reversa no toca interest_invoiced ni ninguna FI", () => {
  const c = src("src/lib/erp/reversal.ts");
  assert.ok(!c.includes("interest_invoiced"), "no se toca lo ya facturado de interés");
  assert.ok(!c.includes("inv_class = 'interest' and") || !/update invoices[^;]*inv_class = 'interest'/.test(c), "ninguna FI se marca ni se modifica");
  const chain = fnBody(c, "chainForPayment");
  assert.ok(chain.includes("origin = ${\"Mora \" + i.name} and date = ${p.date}"), "la FI del mismo clic se identifica…");
  assert.ok(chain.includes("mora facturada con este cobro: ese interés sí corrió (Decisión 21)"), "…y se enseña como 'se queda'");
  // Y el interés vuelve a correr desde donde la FI se detuvo: es la resta que ya existía.
  assert.ok(src("src/lib/erp/credit.ts").includes("const interestNew = round2(Math.max(0, base.interest - Math.max(0, input.interestInvoiced)));"));
});

test("la factura vuelve a deber por refreshInvoiceResidual: 'paid' → 'open' y paid_date limpia; una 'reversed' no se toca", () => {
  const body = fnBody(src("src/lib/erp/reversal.ts"), "applyReversal");
  assert.ok(body.includes("const residual = await refreshInvoiceResidual(sql, invoiceId);"), "el saldo se rehace desde los abonos, no se escribe a mano");
  const stock = src("src/lib/erp/stock.ts");
  assert.ok(stock.includes("state = 'open', paid_date = null"), "al reabrir, paid_date se limpia");
  // Copia literal de nextInvoiceState: la transición que este paso necesita, y la que prohíbe.
  const nextInvoiceState = (current, residual) => (current === "reversed" ? "reversed" : residual <= 0.009 ? "paid" : "open");
  assert.equal(nextInvoiceState("paid", 186404.55), "open", "pagada con saldo vuelve a abrir");
  assert.equal(nextInvoiceState("reversed", 186404.55), "reversed", "una revertida no revive por un contra-abono");
});

test("mora: sin paid_date, issueMoraInvoice cuenta hasta hoy desde el plazo financiero", () => {
  const ops = src("src/lib/erp/ops.ts");
  assert.ok(ops.includes("const paidDate = opts?.paidDate === undefined ? inv[0].paid_date : opts.paidDate;"));
  assert.ok(ops.includes("const endOverdue = paidDate && paidDate < asOf ? paidDate : asOf;"), "paid_date = null → corre hasta asOf");
  // Estado de cuenta: con saldo > 0 no hay fecha de pago para el cálculo, aunque el último abono sea la reversa.
  assert.ok(ops.includes("const paidForCalc = saldo <= 0.009 ? (historico ? fechaAbono : (inv.paid_date ?? fechaAbono)) : null;"));
});

test("el pronto pago que dependía del cobro se revierte junto; el ATC sin abonos se marca revertido; fx_result regresa el diferencial derivado", () => {
  const c = src("src/lib/erp/reversal.ts");
  const chain = fnBody(c, "chainForPayment");
  assert.ok(chain.includes('l.memo === `Pronto pago ${i.name}`'), "el pronto pago se amarra por memo + factura + fecha + sin banco");
  assert.ok(chain.includes("!l.has_bank"), "y no tiene movimiento de banco");
  assert.ok(chain.includes("const fxDiff = isUsdCustomer && bankMove ? r2(Math.abs(bankMove.amount) - amount) : 0;"), "diferencial = |banco| − PAG: derivable exacto, no se inventa");
  const apply = fnBody(c, "applyReversal");
  assert.ok(apply.includes("${-chain.discount.amount}"), "contra-abono del pronto pago, negativo");
  assert.ok(apply.includes("update invoices set state = 'reversed', cancelled_at = now(), cancelled_by = ${userId}, cancel_reason = ${reason}\n      where id = ${chain.atc.id}"), "ATC revertido por estado (sin documento contrario)");
  assert.ok(apply.includes("fx_result = fx_result - ${fxBack}"), "fx_result se regresa");
  assert.ok(apply.includes("fx_invoiced = greatest(0, fx_invoiced - ${Math.max(0, -chain.fxDiff)})"), "y fx_invoiced también");
});

// ---------------------------------------------------------------------------
// 3) Los bloqueos: se detiene antes de tocar nada, con el folio y en simple.
// ---------------------------------------------------------------------------
test("bloqueos: abono posterior (regla del último abono), abono de devolución, una reversa, el pronto pago solo, ATC con abonos", () => {
  const chain = fnBody(src("src/lib/erp/reversal.ts"), "chainForPayment");
  assert.ok(chain.includes("Se revierte primero el último:"), "LIFO: nombra cuál va primero");
  assert.ok(chain.includes("const later = live.filter((l) => l.id > p.id && l.id !== discountRow?.id);"), "el pronto pago de este cobro no cuenta como posterior");
  assert.ok(chain.includes("se revierte con la devolución, y eso todavía no está construido"), "abono virtual de NC → paso 8");
  assert.ok(chain.includes("Una reversa no se revierte: para corregir, se captura el cobro o pago correcto."), "Decisión 16 en el candado");
  assert.ok(chain.includes("ya está revertido ("), "no se revierte dos veces");
  assert.ok(chain.includes("se revierte junto con ese cobro, no sola"), "el pronto pago no se revierte solo");
  assert.ok(chain.includes("ya tiene abonos. Revierte ese cobro primero."), "ATC cobrado");
  // Solo abonos VIVOS cuentan: ni reversas ni revertidos.
  assert.ok(chain.includes("where pa.invoice_id = ${invoiceId} and p2.reverses_id is null\n      and not exists (select 1 from payments r where r.reverses_id = p2.id)"));
});

test("todo o nada, permiso de admin/gerencia, y el intento rechazado en bitácora fuera de la transacción", () => {
  const c = src("src/lib/erp/reversal.ts");
  const run = fnBody(c, "reversePayment");
  const iAudit = run.indexOf("await auditRejected(sql, companyId, context.userId, chain);");
  const iTx = run.indexOf("return withTx(async (tx) => {");
  assert.ok(iAudit !== -1 && iAudit < iTx, "el rechazo queda ANTES de abrir la transacción");
  assert.ok(run.includes("if (!canRevert(me.role)) throw new Error("), "solo admin o gerencia: ya movió cartera y banco");
  assert.ok(run.includes("for update"), "candado de renglones");
  assert.ok(run.includes("const fresh = await chainForPayment(tx, companyId, data.paymentId, me.role);"), "se vuelve a leer la cadena adentro");
  assert.ok(fnBody(c, "auditRejected").includes('action: "revertir-rechazado"'));
  const bit = src("src/routes/bitacora.tsx");
  for (const a of ['"revertir-pago"', '"revertir-atc"', '"revertir-rechazado"']) assert.ok(bit.includes(a), `etiqueta ${a}`);
});

// ---------------------------------------------------------------------------
// 4) Visibles y ligados: Bancos enseña los dos con etiqueta cruzada; Cartera
//    solo ofrece el último abono vivo.
// ---------------------------------------------------------------------------
test("Bancos: el par original↔reversa se ve en los dos renglones, ninguno se esconde", () => {
  const ops = src("src/lib/erp/ops.ts");
  assert.ok(ops.includes("(select r.id from bank_moves r where r.reverses_id = m.id limit 1) as reversed_by_id"), "el original sabe quién lo revirtió");
  assert.ok(ops.includes("(select o.date::text from bank_moves o where o.id = m.reverses_id) as reverses_date"), "la reversa sabe a quién revierte");
  assert.ok(!ops.includes("where m.company_id = ${cid} and m.reverses_id is null"), "la lista no filtra reversas: se ven todas");
  const ui = src("src/routes/banks.tsx");
  assert.ok(ui.includes("Reversa de #{m.reverses_id} ({m.reverses_date}, {money(m.reverses_amount ?? 0)})"));
  assert.ok(ui.includes("Revertido por #{m.reversed_by_id} el {m.reversed_by_date}"));
  assert.ok(ui.includes("{m.payment_id && !m.reverses_id && !m.reversed_by_id ? ("), "el botón solo en movimientos de pago vivos");
});

test("Cartera: 'Revertir último abono' usa el último abono VIVO de la factura (ni reversas ni revertidos)", () => {
  const az = src("src/lib/azagro.ts");
  assert.ok(az.includes("where pa.invoice_id = i.id and p.reverses_id is null\n            and not exists (select 1 from payments r where r.reverses_id = p.id)\n          order by p.id desc limit 1) as last_payment_id"));
  const ui = src("src/routes/credit.tsx");
  assert.ok(ui.includes('label="Revertir último abono"'));
  assert.ok(ui.includes("reversePayment({ data: { paymentId: r.last_payment_id!, reason } })"));
});

// ---------------------------------------------------------------------------
// 5) La pantalla: la cadena con números, y lo que no se puede deshacer después.
// ---------------------------------------------------------------------------
test("la pantalla enseña qué se revierte, qué vuelve a deber, qué se queda, banco y cartera antes/después, y pregunta una vez", () => {
  const ui = src("src/components/cancel-doc.tsx");
  assert.ok(ui.includes("Se revierte (quedan el original, la reversa y la liga entre los dos):"));
  assert.ok(ui.includes("Vuelve a deber:"));
  assert.ok(ui.includes("la mora vuelve a correr desde el plazo financiero"));
  assert.ok(ui.includes("Se queda:"));
  assert.ok(ui.includes('<span className="font-semibold">Después:</span>'), "banco y cartera antes → después");
  assert.ok(ui.includes("No se puede revertir."), "bloqueo en lugar del botón");
  assert.ok(ui.includes("Confirmar reversa"));
});

test("Decisión 16 dicha en el momento en que importa: la reversa también queda para siempre", () => {
  const ui = src("src/components/cancel-doc.tsx");
  assert.ok(ui.includes("Lo que no se puede deshacer después: la reversa también queda para siempre."));
  assert.ok(ui.includes("No estás borrando este {verbo}, estás agregando un movimiento"));
  assert.ok(ui.includes("Si la reversa resulta ser el error, no se deshace: se captura el {verbo} correcto, y quedan los tres."));
});
