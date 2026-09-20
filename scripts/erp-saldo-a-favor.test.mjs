// EL SALDO A FAVOR DEL CLIENTE — L5 y L3c (Decisiones 11, 12 y 13, 19-sep-2026).
//
// El defecto que cierra, verificado en el código antes de tocarlo: un cobro
// mayor al saldo perdía el sobrante DOS veces. En la cartera, por
// `applied = Math.min(importe, saldo)`; y en el BANCO, porque el movimiento se
// registraba por lo aplicado y no por lo que de verdad se depositó. Un depósito
// de $1,000 contra un saldo de $700 dejaba $300 que no estaban en la cartera,
// no estaban en la caja y no estaban en ningún lado — y la conciliación contra
// el banco quedaba descuadrada sin que nada lo explicara.
//
// La forma: el anticipo NO es un documento nuevo. Es un cobro (PAG) sin
// aplicar, y el saldo a favor se DERIVA: amount − Σ aplicaciones.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyableCredit, depositSplit, hasCredit, proposeSplit, unappliedOf } from "../src/lib/erp/advance.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

// ---------------------------------------------------------------------------
// 1. El caso que se perdía
// ---------------------------------------------------------------------------
test("el caso del defecto: $1,000 contra un saldo de $700 deja $300, no cero", () => {
  const d = depositSplit({ deposited: 1000, used: 700 });
  assert.equal(d.used, 700, "a la factura se le aplica lo que debía, ni un peso más");
  assert.equal(d.leftover, 300, "y los otros 300 NO desaparecen");
  // Lo que entra al banco es el depósito completo: 700 + 300.
  assert.equal(d.used + d.leftover, 1000, "el banco cuadra con lo que de verdad se depositó");
});

test("un cobro exacto no inventa un saldo a favor de centavos", () => {
  assert.equal(depositSplit({ deposited: 700, used: 700 }).leftover, 0);
  assert.equal(hasCredit(700, 700), false);
  // Y un pago parcial tampoco: se aplicó todo lo que se depositó.
  assert.equal(depositSplit({ deposited: 300, used: 300 }).leftover, 0);
});

test("lo consumido nunca puede pasar del depósito: el sobrante no se vuelve negativo", () => {
  const d = depositSplit({ deposited: 700, used: 1000 });
  assert.equal(d.used, 700);
  assert.equal(d.leftover, 0, "nunca un saldo a favor negativo, que sería deuda disfrazada");
});

// ---------------------------------------------------------------------------
// 2. El saldo a favor se DERIVA, y baja conforme se aplica
// ---------------------------------------------------------------------------
test("el saldo a favor es lo que el cobro tiene menos lo que ya se aplicó", () => {
  assert.equal(unappliedOf(300, 0), 300, "recién nacido: todo disponible");
  assert.equal(unappliedOf(300, 120), 180, "se aplicaron 120 a una factura");
  assert.equal(unappliedOf(300, 300), 0, "se acabó");
  assert.equal(unappliedOf(300, 400), 0, "nunca negativo");
  assert.equal(hasCredit(300, 299.995), false, "el umbral de siempre: medio centavo no es saldo");
});

test("cuánto de un saldo a favor cabe en una factura, y por qué no cabe cuando no cabe", () => {
  assert.equal(applyableCredit(300, 1000).amount, 300, "cabe todo el crédito");
  assert.equal(applyableCredit(300, 120).amount, 120, "cabe lo que la factura debe, no más");
  const sinCredito = applyableCredit(0, 1000);
  assert.equal(sinCredito.amount, 0);
  assert.match(sinCredito.reason, /ya no tiene saldo a favor/, "dice por qué, no enseña un 0 mudo");
  const sinDeuda = applyableCredit(300, 0);
  assert.equal(sinDeuda.amount, 0);
  assert.match(sinDeuda.reason, /ya no debe nada/);
});

// ---------------------------------------------------------------------------
// 3. La propuesta de reparto (Decisión 13)
// ---------------------------------------------------------------------------
test("un depósito para varias facturas se propone de la más vieja a la más nueva", () => {
  // $1,000 contra tres facturas de 400, 400 y 400, en ese orden de antigüedad.
  const p = proposeSplit(1000, [{ id: 1, residual: 400 }, { id: 2, residual: 400 }, { id: 3, residual: 400 }]);
  assert.deepEqual(p.rows, [{ id: 1, amount: 400 }, { id: 2, amount: 400 }, { id: 3, amount: 200 }]);
  assert.equal(p.leftover, 0);
});

test("lo que no cupo en ninguna factura queda como saldo a favor, no se fuerza en la última", () => {
  const p = proposeSplit(1000, [{ id: 1, residual: 400 }, { id: 2, residual: 300 }]);
  assert.deepEqual(p.rows, [{ id: 1, amount: 400 }, { id: 2, amount: 300 }]);
  assert.equal(p.leftover, 300, "300 sin aplicar — Decisión 12, no se descartan ni se meten a la fuerza");
});

test("la propuesta salta las facturas que ya no deben y respeta el orden que le dan", () => {
  const p = proposeSplit(500, [{ id: 1, residual: 0 }, { id: 2, residual: 200 }, { id: 3, residual: 900 }]);
  assert.deepEqual(p.rows, [{ id: 2, amount: 200 }, { id: 3, amount: 300 }]);
  assert.equal(p.leftover, 0);
  // Es una PROPUESTA: la función no aplica nada, solo devuelve renglones.
  assert.ok(!src("src/lib/erp/advance.ts").includes("insert into"), "advance.ts no escribe: solo calcula");
});

// ---------------------------------------------------------------------------
// 4. Cableado: el agujero del banco, cerrado en las cuatro monedas
// ---------------------------------------------------------------------------
test("el banco registra el depósito real y el sobrante nace con su folio", () => {
  const ops = src("src/lib/erp/ops.ts");
  assert.ok(ops.includes("const deposito = depositSplit({ deposited: opts.amount, used: bankAmount });"), "se separa lo depositado de lo consumido");
  assert.ok(ops.includes("if (sobrante > 0.009) {"), "y el sobrante nace como documento");
  assert.ok(ops.includes('advanceName = await nextDocFolio(sql, opts.companyId, "PAG");'), "con folio de la serie de siempre");
  assert.ok(ops.includes("// Sin `payment_allocs` a propósito: eso ES el saldo a favor."), "sin aplicar: eso es el saldo a favor");
  // El saldo de la cuenta después refleja el depósito COMPLETO.
  assert.ok(ops.includes('const cashAfter = cash + (inv[0].kind === "customer" ? bankAmount + sobrante : -(bankAmount + sobrante));'), "la caja cuenta lo aplicado MÁS el sobrante");
  // Y de una cuenta sale el importe completo: el candado de saldo lo mira.
  assert.ok(ops.includes("cash + 0.009 < bankAmount + sobrante"), "no se deja sacar más de lo que hay, contando el sobrante");
  // Queda en bitácora, con los tres números.
  assert.ok(ops.includes('action: "saldo-a-favor"'), "bitácora del sobrante");
});

test("la pantalla lo DICE: un sobrante nunca se registra en silencio", () => {
  const p = src("src/routes/credit.tsx");
  assert.ok(p.includes("r.advance > 0.009"), "el mensaje del cobro mira el sobrante");
  assert.ok(p.includes("quedó como saldo a favor"), "y lo nombra");
  assert.ok(p.includes("${r.advanceName}"), "con su folio, para poder ir a buscarlo");
});

// ---------------------------------------------------------------------------
// 5. Las salidas, construidas ANTES que los candados
// ---------------------------------------------------------------------------
test("un saldo a favor SÍ se puede revertir: antes el candado de la reversa lo dejaba sin salida", () => {
  const r = src("src/lib/erp/reversal.ts");
  // Cero aplicaciones = saldo a favor: camino corto, sin factura que rehacer.
  // APLICACIONES VIVAS, no filas: desaplicar deja la aplicación y su contraria
  // (+X, −X). Contando filas, un anticipo aplicado y luego quitado parecía
  // «repartido entre 2 facturas», quedaba bloqueado, y la salida que el
  // mensaje nombraba contestaba «ya no le abona nada» — candado sin salida.
  assert.ok(r.includes("group by invoice_id having sum(amount) > 0.009"), "se cuentan aplicaciones vivas, no filas");
  assert.ok(r.includes("if (vivas.length === 0) {"), "cero aplicaciones tiene su propio camino");
  assert.ok(r.includes("isAdvance: true"), "la cadena sabe que es un saldo a favor");
  assert.ok(r.includes("if (!chain.isAdvance) {"), "sin factura no nace un abono contrario que apuntaría a la nada");
  assert.ok(r.includes("chain.isAdvance ? 0 : await refreshInvoiceResidual(sql, invoiceId)"), "ni se rehace un saldo que no existe");
});

test("un cobro repartido entre varias facturas no se queda sin salida: el mensaje nombra la correcta", () => {
  const r = src("src/lib/erp/reversal.ts");
  assert.ok(r.includes("if (vivas.length > 1) {"), "varias aplicaciones siguen bloqueadas para la reversa");
  assert.ok(r.includes("usa «Quitar de esta factura»"), "pero el mensaje dice qué hacer en su lugar");
  assert.ok(r.includes("Revertir el cobro completo solo procede si el dinero nunca debió entrar"), "y distingue las dos intenciones");
  // Y esa salida existe de verdad.
  assert.ok(src("src/lib/erp/advance-query.ts").includes("export const unapplyCredit"), "desaplicar existe");
});

test("el diferencial cambiario del mes no se cuenta dos veces cuando un cobro paga varias facturas", () => {
  const f = src("src/lib/erp/fx-cost-query.ts");
  // Antes: `pa.amount` suelto con `bm.amount` completo en cada renglón.
  assert.ok(f.includes("(select coalesce(sum(pa2.amount),0) from payment_allocs pa2 where pa2.payment_id = p.id)::text as aplicado"), "lo aplicado se suma por PAGO");
  assert.ok(f.includes("select distinct on (p.id)"), "y un pago con varias facturas en dólares deja un solo renglón");
  // Y solo entran los pagos APLICADOS POR COMPLETO: banco − aplicado mide
  // movimiento del dólar solo entonces. Con un sobrante de $300 aplicado $200
  // daría $100 de diferencial fantasma en el Resultado del mes. La prueba es
  // ESTRUCTURAL, no de texto — el memo lo teclea la persona —, y así atrapa
  // también al contra-PAG de un cobro aplicado en parte.
  assert.ok(
    f.includes("and abs(p.amount - coalesce((select sum(pa4.amount) from payment_allocs pa4 where pa4.payment_id = p.id), 0)) <= 0.009"),
    "solo los pagos aplicados por completo entran al diferencial del periodo",
  );
  assert.ok(!f.includes("memo not like"), "no se decide por texto que teclea la persona");
});

// ---------------------------------------------------------------------------
// 6. El saldo a favor baja lo que ocupa la línea de crédito
// ---------------------------------------------------------------------------
test("la línea de crédito mide deuda NETA: el saldo a favor la baja, y nunca por debajo de cero", () => {
  const cl = src("src/lib/erp/credit-limit.ts");
  assert.ok(cl.includes("Math.max(0, x.invoiced + x.reserved - (x.credit ?? 0))"), "resta el saldo a favor, con piso en cero");
  assert.ok(cl.includes("sería cobrarle dos veces la misma línea"), "y dice por qué");
  assert.ok(cl.includes("saldo a favor ${x.credit.toFixed(0)}"), "el rechazo lo desglosa en vez de dar un total mudo");
});

// ---------------------------------------------------------------------------
// 7. L3c NO entra en esta pieza — y la nota dice por qué
// ---------------------------------------------------------------------------
test("L3c: el crédito de una NC que no cupo ya no queda atrapado en un residual negativo", () => {
  const az = src("src/lib/azagro.ts");
  // Estaba atrapado: `applyInvoicePayment` lo rechazaba con «esta factura ya
  // está saldada» (cualquier negativo cumple `residual <= 0.009`) y
  // `refreshInvoiceResidual` lo habría colapsado a $0 (`Math.max(0, …)`).
  assert.ok(!az.includes("set residual = ${-leftover}"), "ningún documento lleva ya un saldo negativo");
  assert.ok(az.includes("`Saldo a favor (devolución ${ncName})`"), "nace como saldo a favor del cliente");
  assert.ok(az.includes("favorName ? ` · saldo a favor ${favorName}"), "y queda en la bitácora de la devolución");
  // EL MEMO HACE TRES TRABAJOS: empieza con «Saldo a favor» (para que
  // `unapplyCredit` lo acepte) y lleva el folio de la NC (para que la reversa
  // lo encuentre y para que no se revierta solo).
  assert.ok(az.includes("EL MEMO HACE TRES TRABAJOS"), "y está dicho por qué el memo es así");
});

test("L3c: el crédito de una devolución no se revierte solo — se va con su devolución", () => {
  const r = src("src/lib/erp/reversal.ts");
  const rr = src("src/lib/erp/return-reversal.ts");
  // Revertirlo solo extinguiría el crédito dejando vivos la NC, el movimiento
  // de kardex y el `qty_returned`: media reversa desde la pantalla equivocada.
  assert.ok(r.includes('if (p.memo.startsWith("Saldo a favor (devolución ")) {'), "bloqueado en el paso 5");
  assert.ok(r.includes("se deshace revirtiendo esa devolución, no solo"), "y el mensaje nombra el camino");
  assert.ok(r.includes("usa «Quitar de esta factura»"), "y la otra salida, si lo que está mal es a qué factura se aplicó");
  // Y el paso 8 se lo lleva: si no, el cliente se queda la mercancía Y el dinero.
  assert.ok(rr.includes('p.memo = ${"Saldo a favor (devolución " + n.name + ")"}'), "el paso 8 lo busca por su memo");
  assert.ok(rr.includes("ya se aplicó a otra factura"), "si ya se gastó, no revierte a ciegas");
  assert.ok(rr.includes("Quítalo de esa factura primero"), "y nombra la salida");
  assert.ok(rr.includes("if (pv.advance) {"), "y cuando procede, nace su contrario");
});

test("L3c: devolver mercancía NO gana bonificación de pronto pago", () => {
  const a = src("src/lib/erp/advance-query.ts");
  // El pronto pago devuelve el financiamiento que el precio cobró y que no se
  // usó POR HABER PAGADO ANTES. Devolver mercancía no es pagar antes: es
  // deshacer una venta. Sobre la factura de referencia eran hasta $5,081.04.
  // UN SOLO PREDICADO para las dos reglas que cuelgan de él (la fecha de la
  // mora, Decisión 97; y que no gane pronto pago, Decisión 96). Escribirlo dos
  // veces es cómo empiezan a divergir: un día alguien cambia una cadena y no
  // la otra, y el mismo cobro es devolución para una cosa y no para la otra.
  assert.ok(a.includes("const esDevolucion = isReturnCredit(pay[0].memo);"), "se distingue el crédito de una devolución");
  assert.equal((a.match(/isReturnCredit\(/g) ?? []).length, 1, "y una sola vez");
  assert.ok(!a.includes('startsWith("Saldo a favor (devolución '), "sin una segunda copia de la cadena");
  assert.ok(a.includes("const bono = esDevolucion"), "y no se le otorga bonificación");
  assert.ok(a.includes("? { discount: 0, detail: \"\", residual }"), "el crédito de devolución pasa de largo");
  assert.ok(a.includes("Devolver mercancía no"), "y queda dicho por qué");
  // La mora sí se factura, como con cualquier abono: el dinero de esa otra
  // factura llegó cuando llegó.
  assert.ok(a.includes("mora = await issueMoraInvoice(sql, companyId, data.invoiceId, {"), "la mora sí");
});

test("el saldo a favor NO nace en una operación con tipo de cambio: se detiene antes de escribir", () => {
  const ops = src("src/lib/erp/ops.ts");
  // `payments.amount` significa pesos. Un sobrante en una cuenta en dólares
  // serían dólares en una columna de pesos: US$2,000 leídos como $2,000, y al
  // aplicarlos desaparecerían $34,000 a TC 18.
  assert.ok(ops.includes('const sobrante = mode === "mxn" ? deposito.leftover : 0;'), "solo pesos contra pesos");
  assert.ok(ops.includes('if (mode !== "mxn" && deposito.leftover > 0.009) {'), "en las otras tres se detiene");
  assert.ok(ops.includes("captura el importe exacto de esta factura"), "y el candado nombra su salida");
  assert.ok(ops.includes("${payDate}, 'MXN', ${moveFx ?? 1})"), "el PAG del sobrante vive en pesos, como todos");
});

test("las dos caras del límite de crédito cuentan igual el saldo a favor", () => {
  const cl = src("src/lib/erp/credit-limit.ts");
  // creditExposure (al confirmar un pedido) y creditExceededSummary (la
  // bandeja del inicio) contestan la misma pregunta: tienen que decir lo mismo.
  assert.ok(cl.includes("greatest(0, coalesce(ar.ar, 0) + coalesce(res.reserved, 0) - coalesce(fav.credito, 0)) as used"), "el inicio resta el saldo a favor");
  assert.ok(cl.includes("Math.max(0, x.invoiced + x.reserved - (x.credit ?? 0))"), "y el límite también");
  assert.equal((cl.match(/and pm\.kind = 'inbound'|and p\.kind = 'inbound'/g) ?? []).length, 2, "las dos miran solo COBROS: un sobrante pagado a un proveedor no es crédito del cliente");
});

// ---------------------------------------------------------------------------
// 8. Lo que encontró el revisor de dinero (NO PASA, seis reglas rotas)
// ---------------------------------------------------------------------------
test("el contrario de un abono contraría LO QUE ESA FACTURA RECIBIÓ, no el importe del cobro", () => {
  const r = src("src/lib/erp/reversal.ts");
  // Antes del saldo a favor los dos números eran siempre iguales (un cobro
  // nacía aplicado completo). Con aplicaciones parciales dejaron de serlo:
  // sobrante de $300 aplicado $200 a una factura de $200, contrariado con
  // −$300, deja la factura debiendo $100 que nadie contrajo.
  assert.ok(r.includes("const allocAmount = Number(vivas[0]!.amount);"), "se lee lo que esa factura recibió (vivo)");
  // Y los dos números —el que se promete y el que se escribe— salen de la
  // MISMA cuenta pura, para que no puedan volver a separarse.
  assert.ok(r.includes("const rev = reversalOfAllocation({ residualNow, allocAmount, discount: discount?.amount ?? 0 });"), "una sola cuenta");
  assert.ok(r.includes("const residualAfter = rev.residualAfter;"), "la vista previa sale de ahí");
  assert.ok(r.includes("${chain.contraAlloc})`;"), "y lo que se escribe, también");
  assert.ok(r.includes("deuda que nadie contrajo"), "y queda dicho por qué");
});

test("desaplicar NO borra: contraría (Decisión 16) y solo sobre un saldo a favor", () => {
  const a = src("src/lib/erp/advance-query.ts");
  assert.ok(!a.includes("delete from payment_allocs"), "nada se borra");
  assert.ok(a.includes("insert into payment_allocs (payment_id, invoice_id, amount, applied_at) values (${data.paymentId}, ${data.invoiceId}, ${-quitado}, ${todayMx()})"), "se contraría, con fecha de hoy");
  // Y no se puede usar para deshacer con `credit:edit` lo que es de admin.
  assert.ok(a.includes('if (Number(ligado[0]?.n ?? 0) > 0 || !pay[0].memo.startsWith("Saldo a favor")) {'), "solo sobre un saldo a favor");
  // Y no solo por el memo, que lo teclea la persona: la marca estructural es
  // que su movimiento de banco no cuelga de ninguna factura. Sin esto, quien
  // escribiera «Saldo a favor de Juan» en el memo de un cobro normal podría
  // deshacer con permiso de cartera algo que es de admin/gerencia.
  assert.ok(a.includes("where payment_id = ${data.paymentId} and company_id = ${companyId} and invoice_id is not null"), "con marca estructural, no solo texto");
  assert.ok(a.includes("es una reversa: no se desaplica"), "ni sobre una reversa");
  assert.ok(a.includes("que es una acción de administración porque mueve dinero"), "y el mensaje manda al camino correcto");
  // El par (+X, −X) no debe seguir apareciendo como aplicado.
  assert.ok(a.includes("having sum(pa.amount) > 0.009"), "una aplicación quitada deja de contar");
});

test("el estado de cuenta del cliente enseña su saldo a favor — en pantalla Y en el papel", () => {
  const ops = src("src/lib/erp/ops.ts");
  const st = src("src/routes/statements.tsx");
  assert.ok(ops.includes("const aFavor = Math.round(Number(favorRows[0]?.total ?? 0) * 100) / 100;"), "el servidor lo calcula");
  assert.ok(ops.includes("and pm.date <= ${asOf}"), "a la fecha del corte, como todo lo demás");
  // En el PDF Y en el correo, y el texto vive en doc-text.ts (regla 7): hasta
  // el 19-sep solo estaba en pantalla, así que el papel le cobraba de más a
  // quien había pagado de más — y él sí sabe lo que depositó.
  assert.equal((st.match(/statementCreditNote\(money\(block\.aFavor\), money\(block\.arNeto\)\)/g) ?? []).length, 2, "en el papel y en el correo");
  assert.ok(src("src/lib/erp/doc-text.ts").includes("Saldo neto a cargo:"), "con el neto, desde doc-text");
  // Callarlo le cobraría de más, y el cliente sí sabe lo que depositó.
  assert.ok(st.includes("Callarlo le cobraría de más"), "y queda dicho por qué");
});

// ---------------------------------------------------------------------------
// 9. Lo de la tercera y cuarta pasada del revisor
// ---------------------------------------------------------------------------
test("saldar con saldo a favor factura la mora, igual que un cobro", () => {
  const a = src("src/lib/erp/advance-query.ts");
  // Sin esto la factura quedaba `paid`, y ahí el botón «Mora» desaparece
  // (`invoiceStillOwed` es falso): el interés vencido se perdía y no quedaba
  // pantalla para emitirlo. En ventas a crédito SIEMPRE hay mora (Decisión 68).
  assert.ok(a.includes("mora = await issueMoraInvoice(sql, companyId, data.invoiceId, {"), "la FI nace antes de abonar");
  assert.ok(a.includes("requireCharge: false,"), "sin días vencidos no truena: simplemente no nace FI");
  const i = a.indexOf("issueMoraInvoice(sql, companyId, data.invoiceId");
  const j = a.indexOf("insert into payment_allocs (payment_id, invoice_id, amount, applied_at) values (${data.paymentId}");
  assert.ok(i > 0 && j > i, "y nace ANTES de la aplicación, como en el cobro");
  assert.ok(src("src/routes/credit.tsx").includes("const m = r.mora ? ` Mora ${r.mora}"), "y la pantalla lo dice");
});

test("un saldo a favor YA REVERTIDO no abona ni se desaplica: las DOS puertas", () => {
  const a = src("src/lib/erp/advance-query.ts");
  // Los cuatro lugares que LEEN el saldo a favor ya excluían lo revertido; las
  // dos que ESCRIBEN no lo hacían. Aplicar borraría deuda con dinero ya
  // devuelto; desaplicar escribiría un segundo negativo y dejaría la factura
  // debiendo MÁS de su importe ($1,300 sobre una de $1,000).
  assert.equal(
    (a.match(/select name from payments where reverses_id = \$\{data\.paymentId\} and company_id = \$\{companyId\} limit 1/g) ?? []).length,
    2,
    "el candado está en applyCredit Y en unapplyCredit",
  );
  assert.ok(a.includes("ese dinero salió del banco y su saldo a favor dejó de existir"), "el mensaje de aplicar");
  assert.ok(a.includes("su reversa ya deshizo la aplicación, no hay nada que quitar"), "el de desaplicar");
});

test("el panel de saldo a favor respeta cartera propia, como la lista de facturas", () => {
  const a = src("src/lib/erp/advance-query.ts");
  assert.ok(a.includes("and (${me.own_only} = false or pt.seller_id = ${context.userId} or pt.seller_id is null)"), "mismo patrón que listInvoices");
  assert.ok(a.includes("Ese cliente no está en tu cartera."), "y el endpoint valida el socio que le piden");
});

// ---------------------------------------------------------------------------
// 10. Las tres decisiones del dueño del 19-sep-2026 (respuesta a «¿cómo
//     debería ser?»: criterio técnico con su aval)
// ---------------------------------------------------------------------------
test("una factura queda pagada el día en que el dinero estuvo disponible PARA ELLA", () => {
  const stock = src("src/lib/erp/stock.ts");
  const a = src("src/lib/erp/advance-query.ts");
  // El piso vive en el motor, donde protege todos los caminos: `max(p.date)`
  // sola dejaba una factura de agosto «pagada» en febrero — seis meses antes
  // de nacer —, y de ahí leen la mora, la FI y el P&L.
  assert.ok(stock.includes("case when max(x.d) is null then null else greatest(max(x.d), i.date) end"), "nunca antes de la factura");
  // Y contando solo los abonos que de verdad le abonan algo: una aplicación
  // quitada deja (+X, −X), que suman cero y no deben mandar la fecha.
  assert.ok(stock.includes("having sum(pa.amount) > 0.009"), "una aplicación quitada no manda la fecha");
  assert.ok(stock.includes("${todayMx()}::date)"), "y el respaldo de siempre sigue alcanzable");
  // Y la mora se mide con esa misma fecha.
  assert.ok(a.includes("const fechaEfectiva = origen > inv[0].date ? origen : inv[0].date;"), "la más tarde de las dos");
  // Y la fecha que se ESCRIBE en la aplicación es la misma que mide la mora:
  // un solo hecho (migración 0046).
  assert.ok(a.includes("const appliedAt: string | null = esDevolucion ? todayMx() : null;"), "la aplicación lleva su fecha");
  assert.ok(a.includes("const origen = appliedAt ?? pay[0].date;"), "y la mora mide con esa misma");
  assert.ok(a.includes("amount, applied_at) values (${data.paymentId}, ${data.invoiceId}, ${amount}, ${appliedAt})"), "y se escribe al aplicar");
  assert.ok(a.includes("${-quitado}, ${todayMx()})"), "quitar es un hecho de hoy");
  // Salvo el crédito de una DEVOLUCIÓN: mercancía devuelta nunca fue dinero
  // disponible para OTRA factura, así que su fecha es el día en que se aplica.
  // Si no, un crédito guardado meses se llevaba consigo toda la mora corrida
  // ($5,486.59 sobre la factura de referencia) y además ya no se podía
  // facturar, porque al quedar `paid` desaparece el botón «Mora».
  assert.ok(a.includes("esDevolucion ? todayMx() : null"), "el crédito de una devolución se aplica con fecha de hoy");
  assert.ok(a.includes("asOf: fechaEfectiva,") && a.includes("paidDate: fechaEfectiva,"), "la mora la usa");
  assert.ok(a.includes("cobrar intereses sobre"), "y queda dicho por qué");
});

test("el pronto pago vale lo mismo por las dos puertas: una sola función lo decide", () => {
  const ops = src("src/lib/erp/ops.ts");
  const a = src("src/lib/erp/advance-query.ts");
  assert.ok(ops.includes("export async function earlyPayDiscount("), "existe en un solo lugar");
  // Las dos puertas lo llaman: el cobro por banco y el saldo a favor.
  assert.ok(ops.includes("const bonoRes = await earlyPayDiscount(sql, {"), "el cobro por banco");
  // El invariante de la Decisión 94 sigue en pie con UNA excepción decidida y
  // nombrada (L3c): el crédito de una devolución. Se fija que la excepción sea
  // EXACTAMENTE ésa y ninguna otra — si mañana alguien agrega una segunda
  // condición al ternario, esta prueba lo dice.
  assert.ok(a.includes("const bono = esDevolucion\n        ? { discount: 0, detail: \"\", residual }\n        : await earlyPayDiscount(sql, {"), "la aplicación de saldo a favor lo llama salvo el crédito de una devolución");
  assert.equal((a.match(/await earlyPayDiscount\(sql, \{/g) ?? []).length, 1, "una sola llamada, no varias ramas");
  assert.equal((a.match(/esDevolucion/g) ?? []).length, 3, "se declara una vez y se usa dos: la fecha de la mora y el bono");
  // Y la fecha con la que se MIDE la deriva la propia función de los abonos
  // vivos de la factura, no se la pasa el llamador: así las dos puertas miden
  // igual por construcción, no por coincidencia. Un anticipo viejo ya no hace
  // retroceder el reloj y perdona a quien pagó tarde (5ª pasada del revisor).
  assert.ok(ops.includes("const medida = earlyPayMeasureDate(i.date, abonos.map((a) => a.date));"), "la fecha se deriva");
  assert.ok(ops.includes("payDate: medida,"), "y es esa la que mide el bono");
  assert.ok(ops.includes("where pa.invoice_id = ${i.id} and p.reverses_id is null"), "solo abonos vivos");
  // Y ya no hay una segunda copia de la fórmula dentro del cobro.
  // Dos usos de la fórmula, y solo dos: el que OTORGA (dentro de
  // `earlyPayDiscount`, una sola vez para las dos puertas) y el que ESTIMA en
  // el estado de cuenta. Una tercera copia sería una tercera respuesta.
  assert.equal((ops.match(/earlyPayBonus\(\{/g) ?? []).length, 2, "uno que otorga, uno que estima");
  const otorga = ops.slice(ops.indexOf("export async function earlyPayDiscount"), ops.indexOf("export async function applyInvoicePayment"));
  assert.equal((otorga.match(/earlyPayBonus\(\{/g) ?? []).length, 1, "el que otorga, una sola vez");
  assert.ok(src("src/routes/credit.tsx").includes("Pronto pago: se bonificaron ${money(r.discount)}"), "y la pantalla lo dice por las dos vías");
});

// ---------------------------------------------------------------------------
// 11. EL ORDEN, que es lo que sostiene el arreglo del pronto pago
//
// El revisor de dinero lo dijo así en la sexta pasada: «si alguien mueve esa
// llamada arriba del abono, la lista de abonos queda vacía, la medición cae a
// la fecha de la factura y el agujero vuelve a abrirse ENTERO — y las pruebas
// siguen en verde». Sobre la factura de $111,876.11 cobrada el día 200, eso
// pasa de perdonar $0.00 a perdonar $5,000.00.
//
// `earlyPayDiscount` mide con los abonos VIVOS de la factura, así que el abono
// de este cobro tiene que estar escrito ANTES de llamarla. En las dos puertas.
// ---------------------------------------------------------------------------
test("la bonificación se calcula DESPUÉS de escribir el abono, en las dos puertas", () => {
  const ops = src("src/lib/erp/ops.ts");
  const a = src("src/lib/erp/advance-query.ts");

  // Puerta 1: el cobro por banco.
  const cobro = ops.slice(ops.indexOf("export async function applyInvoicePayment"), ops.indexOf("export const addBankMove"));
  const abonoCobro = cobro.indexOf("insert into payment_allocs (payment_id, invoice_id, amount)\n    values (${pay[0]!.id}");
  const bonoCobro = cobro.indexOf("const bonoRes = await earlyPayDiscount(sql, {");
  assert.ok(abonoCobro > 0, "el abono del cobro se escribe");
  assert.ok(bonoCobro > 0, "y la bonificación se calcula");
  assert.ok(abonoCobro < bonoCobro, "EL ABONO PRIMERO: si no, la medición no lo ve y se perdona de más");

  // Puerta 2: aplicar un saldo a favor.
  const abonoCredito = a.indexOf("insert into payment_allocs (payment_id, invoice_id, amount, applied_at) values (${data.paymentId}, ${data.invoiceId}, ${amount}, ${appliedAt})");
  const bonoCredito = a.indexOf("const bono = esDevolucion");
  assert.ok(abonoCredito > 0 && bonoCredito > 0);
  assert.ok(abonoCredito < bonoCredito, "EL ABONO PRIMERO también aquí");

  // Y la mora, al revés: se factura ANTES de abonar (si no, la factura queda
  // `paid` y el botón «Mora» desaparece).
  const moraCredito = a.indexOf("mora = await issueMoraInvoice(sql, companyId, data.invoiceId, {");
  assert.ok(moraCredito > 0 && moraCredito < abonoCredito, "la mora ANTES del abono");
  const moraCobro = cobro.indexOf("mora = await issueMoraInvoice(sql, opts.companyId, inv[0].id, {");
  assert.ok(moraCobro > 0 && moraCobro < abonoCobro, "igual en el cobro");
});

// ---------------------------------------------------------------------------
// 12. Lo que encontró el crítico de completitud (pasada de L3c, 19-sep-2026):
//     cosas ya rotas HOY, algunas del propio bloque L5.
// ---------------------------------------------------------------------------
test("no se le manda RECORDATORIO DE PAGO a una nota de crédito", () => {
  const a = src("src/lib/erp/alerts.ts");
  // Una NC nace con importe negativo y queda `open` mientras su crédito no se
  // aplique, así que caía en el recordatorio: al cliente le llegaba un correo
  // «Recordatorio de pago NC-000N · Importe −$X · Agradecemos su pronto pago».
  // A dos clics desde Cartera. Se le pedía pagar un documento que dice que
  // algo se le debe A ÉL.
  assert.ok(a.includes("if (Number(inv[0].amount) <= 0 || Number(inv[0].residual) <= 0.009) {"), "se detiene antes de mandar");
  assert.ok(a.includes("no se le manda recordatorio de pago"), "y dice por qué");
  const i = a.indexOf("if (Number(inv[0].amount) <= 0");
  const j = a.indexOf("sendMail");
  assert.ok(i > 0 && (j < 0 || i < j), "el candado va ANTES de mandar el correo");
});

test("el inicio no cuenta una nota de crédito como deuda ni como factura vencida", () => {
  const az = src("src/lib/azagro.ts");
  const dash = az.slice(az.indexOf("export const getDashboard"), az.indexOf("export const listPartners"));
  // Cuatro lectores: por cobrar/vencido, la escalera de antigüedad, el conteo
  // de vencidas y la exposición en dólares.
  assert.ok(dash.includes("and i.kind = 'customer' and i.state = 'open' and i.amount > 0\n"), "por cobrar y vencido");
  assert.ok(dash.includes("where company_id = ${cid} and kind = 'customer' and state = 'open' and amount > 0"), "la escalera de antigüedad");
  assert.ok(dash.includes("and i.state = 'open' and i.amount > 0 and i.due_date < ${today}::date"), "el conteo de vencidas");
  // La de dólares SÍ la cuenta: una NC en dólares es saldo a favor del cliente
  // en esa moneda y baja la exposición de verdad.
  assert.ok(dash.includes("coalesce(i.currency,'MXN') = 'USD' and i.fx_agreed > 1"), "la exposición USD no filtra el signo, a propósito");
});

test("las tres pantallas de reversa no cuentan una NC como deuda del socio", () => {
  for (const f of ["src/lib/erp/return-reversal.ts", "src/lib/erp/reversal.ts", "src/lib/erp/delivery-reversal.ts"]) {
    const t = src(f);
    const total = (t.match(/state = 'open'/g) ?? []).length;
    const conFiltro = (t.match(/state = 'open' and amount > 0/g) ?? []).length;
    assert.ok(conFiltro > 0, `${f}: la deuda del socio filtra el signo`);
    assert.ok(conFiltro <= total);
  }
});

test("la bitácora nombra los verbos del saldo a favor en vez de enseñar el slug", () => {
  const b = src("src/routes/bitacora.tsx");
  for (const a of ["saldo-a-favor", "aplicar-saldo-a-favor", "quitar-saldo-a-favor"]) {
    assert.ok(b.includes(`"${a}":`), `falta la etiqueta de ${a}`);
  }
});

test("L3c: una devolución con sobrante en DÓLARES se detiene, con salida", () => {
  const az = src("src/lib/azagro.ts");
  // El saldo a favor vive en pesos y `applyCredit` no lo deja aplicar a una
  // factura en otra moneda: guardarlo en pesos dejaría al cliente que solo
  // compra en dólares con un crédito SIN una sola factura a la cual aplicarlo.
  // Candado sin salida, que es peor que el problema.
  assert.ok(az.includes('if (leftover > 0.009 && fv[0] && fv[0].currency !== "MXN") {'), "se detiene antes de escribir");
  assert.ok(az.includes("todavía no se puede guardar como saldo a favor"), "y lo dice");
  assert.ok(az.includes("usa «Revertir entrega»"), "y nombra una salida que existe");
  // El candado va ANTES de apagar la NC: si no, quedaría la NC en 0 sin crédito.
  const i = az.indexOf('if (leftover > 0.009 && fv[0] && fv[0].currency !== "MXN") {');
  const j = az.indexOf("await sql`update invoices set residual = 0, state = 'paid', paid_date = ${today} where id = ${nc[0]!.id}`;");
  assert.ok(i > 0 && j > i, "el candado antes de tocar la NC");
});

test("L3c: el estado de cuenta y la línea de crédito no cuentan el crédito dos veces", () => {
  const ops = src("src/lib/erp/ops.ts");
  const cl = src("src/lib/erp/credit-limit.ts");
  // La NC queda en 0 (deja de restar del saldo) y el crédito aparece en
  // `aFavor` (que lo resta una vez). Neto: el mismo número que antes, pero
  // ahora el cliente VE su crédito en vez de tenerlo escondido en un negativo.
  assert.ok(ops.includes("and pm.kind = 'inbound' and pm.amount > 0 and pm.date <= ${asOf}"), "aFavor recoge el PAG virtual");
  assert.ok(!ops.includes("pm.bank_id is not null"), "sin exigir banco: el crédito de una devolución no tiene");
  assert.ok(cl.includes("and pm.kind = 'inbound'"), "y la línea de crédito lo cuenta una sola vez");
});

// ---------------------------------------------------------------------------
// 13. LOS TRES DEL PRONTO PAGO USAN LA MISMA BASE
//
// `CLAUDE.md` § 1 lo dice textual: «los tres del pronto pago tienen que
// coincidir o la pantalla estima una bonificación y el sistema perdona otra».
// La segunda revisión de L3c encontró que se había arreglado solo el que
// OTORGA: sobre una factura con devolución parcial, los dos que ESTIMAN decían
// $4,979.26 y el sistema perdonaba $222.53 — y la tarjeta de utilidad del
// pedido RESTABA de la utilidad una bonificación que nunca se otorgó.
// ---------------------------------------------------------------------------
test("los tres que hablan del pronto pago descuentan lo devuelto de la base", () => {
  const ops = src("src/lib/erp/ops.ts");
  const rep = src("src/lib/erp/reports.ts");
  // Una sola consulta contesta «cuánto de esta factura se devolvió».
  assert.ok(ops.includes("export async function returnedOfInvoices("), "un solo lugar lo contesta");
  // Y la fuente es la NOTA DE CRÉDITO, no las aplicaciones ni el memo
  // (20-sep-2026): las aplicaciones solo veían lo que CUPO, así que una
  // devolución sobre una factura ya pagada reportaba $0 y el bono se calculaba
  // sobre el cargo entero de una venta cuya mercancía regresó toda. La NC nace
  // por el importe completo y sabe a qué factura pertenece (`applies_to_id`).
  // De paso deja de depender de texto que alguien teclea.
  const rf = ops.slice(ops.indexOf("export async function returnedOfInvoices("), ops.indexOf("export async function earlyPayDiscount("));
  assert.ok(rf.includes("select nc.applies_to_id, coalesce(sum(-nc.amount), 0)::text as total"), "la fuente es la nota de crédito");
  assert.ok(rf.includes("and nc.reverses_id is null and nc.state <> 'reversed'"), "solo las vivas");
  assert.ok(!rf.includes("p.memo like"), "ninguna decisión de dinero por texto tecleable");
  assert.equal(
    ((ops + rep).match(/returnedOfInvoices\(/g) ?? []).length,
    4,
    "la declara una vez y la llaman los tres: otorga, estima y tarjeta",
  );
  // 1. El que OTORGA.
  assert.ok(ops.includes("const baseBono = earlyPayBase(Number(i.amount), devuelto.get(i.id) ?? 0);"), "otorga");
  assert.ok(ops.includes("cargo: baseBono,"), "y es esa la base");
  // 2. El que ESTIMA en el estado de cuenta.
  assert.ok(ops.includes("cargo: earlyPayBase(cargo, devueltoMap.get(inv.id) ?? 0),"), "estima");
  // 3. El que RESTA en la tarjeta de utilidad del pedido.
  assert.ok(rep.includes("cargo: earlyPayBase(Number(fv[0].amount), devueltoFv),"), "resta en la utilidad");
  // Y nadie más calcula el bono: una cuarta copia sería una cuarta respuesta.
  assert.equal(((ops + rep).match(/earlyPayBonus\(\{/g) ?? []).length, 3, "tres usos de la fórmula, los tres con la misma base");
});

test("la fecha de pago es la de la APLICACIÓN (migración 0046), sin rodeos por memo", () => {
  const stock = src("src/lib/erp/stock.ts");
  const ops = src("src/lib/erp/ops.ts");
  // El primer intento excluía el crédito de devolución del max(p.date) y eso
  // hacía RETROCEDER el reloj a un abono viejo (la rama l3c-en-pausa). La
  // regla correcta no era una excepción: la aplicación tiene fecha.
  assert.ok(stock.includes("select max(coalesce(pa.applied_at, p.date)) as d"), "paid_date lee la fecha de la aplicación");
  assert.ok(!stock.includes("memo not like"), "y ya no decide nada por memo");
  // El que otorga el pronto pago mide con la MISMA expresión: los dos relojes son uno.
  assert.ok(ops.includes("select max(coalesce(pa.applied_at, p.date))::text as date"), "earlyPayDiscount mide igual");
  // Y el estado de cuenta a una fecha pasada resta solo lo aplicado hasta ese día.
  assert.ok(ops.includes("where pa.payment_id = pm.id and coalesce(pa.applied_at, px.date) <= ${asOf}"), "aFavor histórico, correcto");
  // Y la lista de abonos del estado de cuenta se ORDENA por la misma fecha que
  // trae: el corte histórico toma «el último de la lista» como fecha de pago.
  // Ordenar por la del cobro dejaba un crédito aplicado después de un cobro
  // real antes en la lista: $847.93 de mora de menos en el papel.
  assert.ok(ops.includes("order by coalesce(pa.applied_at, p.date), pa.id"), "la lista de abonos se ordena por fecha de aplicación");
  assert.ok(!ops.includes("order by p.date, pa.id"), "y no por la del cobro");
});
