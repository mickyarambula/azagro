// LA MORA SE AJUSTA POR LO DEVUELTO — L3b, Decisión 10 del dueño (7-sep-2026),
// construida el 20-sep-2026.
//
// EL CHOQUE APARENTE DE REGLAS, y por qué no lo es: `CLAUDE.md` § 1 dice que el
// interés corre sobre el CARGO ORIGINAL y que un abono parcial no reduce la
// base (regla del Excel). Una DEVOLUCIÓN no es un abono: un abono es dinero que
// paga la deuda; una devolución es mercancía que regresó, o sea que el cargo
// original resultó ser otro. Sobre la parte devuelta nunca hubo venta que
// financiar, así que nunca hubo interés que cobrar. El sistema ya había escrito
// esa distinción tres veces: `returnedOfInvoices`, la Decisión 96 (lo devuelto
// sale de la base del pronto pago) y la Decisión 97 («mercancía devuelta nunca
// fue dinero disponible»).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { moraBase } from "../src/lib/erp/advance.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

// Los números del § 5 del diseño: cargo $111,876.11, tasa de cobro 7.05 % +
// spread de mora 9 % = 16.05 %.
const CARGO = 111876.11, TASA = 0.1605;
const interes = (base, dias) => Math.round(((base * TASA * dias) / 360) * 100) / 100;

test("el caso de la Decisión 10: se devuelve la mitad, el interés se parte a la mitad", () => {
  assert.equal(moraBase(CARGO, 0), CARGO, "sin devolución, el cargo entero");
  assert.equal(interes(moraBase(CARGO, 0), 30), 1496.34, "el número del diseño, intacto");
  // Devuelve $55,938.06 (la mitad): la base baja y el interés con ella.
  assert.equal(moraBase(CARGO, 55938.06), 55938.05);
  assert.equal(interes(55938.05, 30), 748.17, "la mitad exacta, al centavo");
});

test("devolver TODO deja la base en cero: no hay venta que financiar", () => {
  assert.equal(moraBase(CARGO, CARGO), 0);
  assert.equal(interes(0, 365), 0, "ni un peso de interés, corran los días que corran");
  // Y devolver de más (no debería pasar) tampoco da base negativa.
  assert.equal(moraBase(1000, 1500), 0);
});

test("el interruptor de la Decisión 10: quien tenga permiso apaga el ajuste", () => {
  // «Es el comportamiento POR OMISIÓN, no una regla fija»: con `ajusta = false`
  // la base vuelve a ser el cargo entero — el caso del sobrante del cliente,
  // que no es lo mismo que un error de Azagro.
  assert.equal(moraBase(CARGO, 55938.06, false), CARGO);
  assert.equal(interes(moraBase(CARGO, 55938.06, false), 30), 1496.34, "cobra como si no hubiera devuelto");
  assert.equal(moraBase(CARGO, 55938.06, true), 55938.05, "y encendido, la mitad");
  // Por omisión se ajusta: es lo que decidió el dueño.
  assert.equal(moraBase(CARGO, 55938.06), moraBase(CARGO, 55938.06, true));
});

test("redondeo a centavos, como todo el dinero del sistema", () => {
  assert.equal(moraBase(100.005, 0.004), 100.01, "cada parte se redondea a dos, como earlyPayBase");
  assert.equal(moraBase(0, 0), 0);
});

// ---------------------------------------------------------------------------
// Cableado: LOS CUATRO lectores de la base usan la misma regla.
// Partirlos es lo que deja el sistema peor que hoy — el papel diría un interés
// y la FI cobraría otro.
// ---------------------------------------------------------------------------
test("los cuatro que calculan mora usan moraBase, con el mismo devuelto y el mismo interruptor", () => {
  const ops = src("src/lib/erp/ops.ts");
  const rep = src("src/lib/erp/reports.ts");
  // 1. La FI que de verdad se emite.
  assert.ok(ops.includes("cargo: moraBase(Number(inv[0].amount), devueltoFv, inv[0].mora_ajusta !== false),"), "issueMoraInvoice");
  // 2. El interés y el FEGA del estado de cuenta.
  assert.ok(ops.includes("capital: moraBase(cargo, devueltoMap.get(inv.id) ?? 0, inv.mora_ajusta !== false),"), "estado de cuenta");
  // 3. La fila del Excel del mismo estado de cuenta.
  assert.ok(ops.includes("cargo: moraBase(cargo, devueltoMap.get(inv.id) ?? 0, inv.mora_ajusta !== false),"), "fila del Excel");
  // 4. «Lo que viene» del inicio.
  assert.ok(rep.includes("const baseMora = moraBase(Number(inv.amount), devueltoMora.get(inv.id) ?? 0, inv.mora_ajusta !== false);"), "getUpcomingDue");
  assert.ok(rep.includes("const interesMensual = pick ? (baseMora * rate * 30) / 360 : 0;"), "y estima con esa base");
  // Y nadie calcula mora sobre el cargo crudo: una quinta respuesta sería un
  // quinto número.
  assert.ok(!ops.includes("capital: Math.max(0, cargo),"), "el estado de cuenta ya no usa el cargo crudo");
  assert.ok(!rep.includes("(Number(inv.amount) * rate * 30) / 360"), "ni el inicio");
});

test("el motor de mora NO cambió: `moraBase` se aplica antes, en el argumento", () => {
  const credit = src("src/lib/erp/credit.ts");
  const adv = src("src/lib/erp/advance.ts");
  // `computeMora` y `moraBilling` siguen recibiendo un capital y multiplicando
  // igual que siempre. Lo que cambió es qué capital se les pasa.
  assert.ok(credit.includes("const interest = daysOverdue > 0 && cobraInteres ? (input.capital * annualRate * daysOverdue) / YEAR_DAYS : 0;"), "la fórmula del interés, intacta");
  assert.ok(credit.includes("const fega = daysOverdue > 0 && !input.fegaAlreadyCharged ? input.capital * input.fegaRate : 0;"), "la del FEGA, intacta");
  // Y la regla del Excel sigue escrita donde estaba: un ABONO no baja la base.
  assert.ok(credit.includes("El interés corre SIEMPRE sobre el cargo original, no sobre el saldo"), "la regla del Excel se queda");
  assert.ok(adv.includes("Una DEVOLUCIÓN no es un abono"), "y queda dicho por qué no se contradicen");
});

test("el interruptor exige admin/gerencia, motivo, y deja bitácora", () => {
  const a = src("src/lib/erp/advance-query.ts");
  assert.ok(a.includes("export const setMoraAjusta"), "existe el verbo");
  assert.ok(a.includes("await assertAdminOrGerencia(sql, context.userId);"), "como revertir: no es de cualquiera");
  assert.ok(a.includes('reason: z.string().min(3,'), "el motivo es obligatorio");
  assert.ok(a.includes('action: data.ajusta ? "mora-ajusta-si" : "mora-ajusta-no"'), "queda en bitácora");
  assert.ok(a.includes("· base ${moraBase(Number(inv[0].amount), devuelto, data.ajusta).toFixed(2)} · ${data.reason}"), "con cargo, devuelto, base y motivo");
  // No escribe ningún número: solo el interruptor. La FI ya emitida se queda
  // (Decisión 21).
  assert.ok(a.includes("update invoices set mora_ajusta = ${data.ajusta}"), "solo el interruptor");
  assert.ok(!a.includes("update invoices set interest_invoiced"), "no toca lo ya facturado");
  // Y la bitácora los nombra en vez de enseñar el slug.
  const b = src("src/routes/bitacora.tsx");
  assert.ok(b.includes('"mora-ajusta-no":') && b.includes('"mora-ajusta-si":'), "etiquetas");
});

test("la migración 0047 es aditiva y no inventa un número de negocio", () => {
  const m = src("migrations/0047_mora_ajusta.sql");
  assert.ok(m.includes("alter table invoices add column if not exists mora_ajusta boolean not null default true;"), "una columna, aditiva");
  assert.ok(!/numeric|integer|date/.test(m.split("--").pop() ?? ""), "sin números de negocio");
  // `true` es la decisión escrita del dueño, no un valor por omisión inventado:
  // sin devolución la base es el cargo completo de todos modos.
  assert.equal(moraBase(CARGO, 0, true), moraBase(CARGO, 0, false), "sin devolución, el interruptor no cambia nada");
});

// ---------------------------------------------------------------------------
// Lo que encontró el revisor de dinero (primera pasada de L3b)
// ---------------------------------------------------------------------------
test("el papel de la FI dice la base que de VERDAD se cobra, no el cargo entero", () => {
  const ops = src("src/lib/erp/ops.ts");
  const dt = src("src/lib/erp/doc-text.ts");
  // Decía «cargo original $111,876.11 × 16.05 % × 30 / 360 = $748.17», y ese
  // producto es $1,496.34: el cliente que la verifique encuentra $748.17 de
  // diferencia en la cara del documento que le cobran.
  assert.ok(ops.includes("capital: bill.capital,"), "el texto al cliente usa la base cobrada");
  assert.ok(!ops.includes("capital: Number(inv[0].amount),\n    annualRate"), "ya no el cargo entero");
  assert.ok(dt.includes("− ${m(i.returned)} devueltos = ${m(i.capital)} × tasa anual"), "y explica de dónde sale");
  assert.ok(dt.includes('(el cargo menos lo devuelto)'), "el FEGA también");
  // Sin devolución, el texto de siempre, byte a byte.
  assert.ok(dt.includes("`Intereses moratorios al ${dateDMY(i.asOf)}: cargo original ${m(i.capital)}"), "sin devolución no cambia");
  // Y el cálculo guardado no se contradice a sí mismo.
  assert.ok(ops.includes("`capital ${bill.capital.toFixed(2)} (cargo ${Number(inv[0].amount).toFixed(2)}"), "un solo capital en la bitácora de la FI");
});

test("el QUINTO lector: la vista previa antes de cobrar estima lo que el sistema va a cobrar", () => {
  const c = src("src/routes/credit.tsx");
  // Estimaba sobre el SALDO y desde el vencimiento visible (día 120), mientras
  // la FI cobra sobre la base desde el plazo financiero (día 150). Con la
  // configuración 120/150 los dos errores se cancelaban por casualidad; con
  // media devolución la pantalla prometía $1,496.34 y el sistema cobra $748.17.
  assert.ok(c.includes("capital: moraBase(num(inv.amount), num(inv.devuelto), inv.mora_ajusta !== false),"), "la misma base");
  assert.ok(c.includes("dueDate: inv.credit_due || inv.due_date,"), "y el mismo plazo financiero");
  assert.ok(!c.includes("capital: num(inv.residual),"), "nunca el saldo");
});

test("un corte a fecha pasada no recalcula la mora de un mes ya cerrado", () => {
  const ops = src("src/lib/erp/ops.ts");
  // Una devolución de septiembre no puede cambiar el estado de cuenta al 31 de
  // agosto: el papel que el cliente ya tiene en la mano no se reescribe.
  assert.ok(ops.includes("export async function returnedOfInvoices(sql: Sql, companyId: number, invoiceIds: number[], asOf?: string)"), "acepta el corte");
  assert.ok(ops.includes("and (${asOf ?? null}::date is null or nc.date <= ${asOf ?? null}::date)"), "y lo aplica");
  assert.ok(ops.includes("historico ? asOf : undefined)"), "el estado de cuenta se lo pasa cuando el corte es pasado");
});

test("la segunda mitad de la Decisión 10 tiene pantalla: el dueño puede ejercerla", () => {
  const c = src("src/routes/credit.tsx");
  assert.ok(c.includes("import { setMoraAjusta }"), "la pantalla llama al verbo");
  assert.ok(c.includes('num(r.devuelto) > 0.009'), "solo aparece si hubo devolución: sin ella no cambia nada");
  assert.ok(c.includes('r.mora_ajusta !== false ? "Mora: ajustada" : "Mora: sin ajustar"'), "y dice en cuál de los dos está");
  assert.ok(c.includes("le sobró mercancía, no fue un error nuestro"), "el motivo se pide con el ejemplo del dueño");
});

// ---------------------------------------------------------------------------
// LA VISTA PREVIA DEL COBRO, con números (2ª revisión de L3b, aviso 2).
//
// Cambió DOS cosas a la vez: la base (saldo → cargo) y la fecha (vencimiento
// visible → plazo financiero). Eso mueve el número de TODA factura vencida, no
// solo las que tienen devolución — y ninguna prueba lo fijaba. Con la
// configuración 120/150 los dos errores se cancelaban en un punto y por eso
// nadie lo había notado.
// ---------------------------------------------------------------------------
test("la previa del cobro acierta ahora, y antes prometía de más", () => {
  // Factura de referencia: cargo $111,876.11, cobrada en parte (saldo
  // $55,938.06), vencimiento visible día 120, plazo financiero día 150.
  // Se mira a 70 días del vencimiento visible = 40 desde el plazo financiero.
  const CARGO = 111876.11, SALDO = 55938.06, TASA = 0.1605;
  const i = (base, dias) => Math.round(((base * TASA * dias) / 360) * 100) / 100;

  // Lo que la FI cobra de verdad: sobre el CARGO, desde el plazo financiero.
  const loQueCobra = i(moraBase(CARGO, 0), 40);
  // Lo que la pantalla prometía: sobre el SALDO, desde el vencimiento visible.
  const loQueDecia = i(SALDO, 70);
  assert.equal(loQueCobra, 1995.12, "lo que el sistema cobra");
  assert.equal(loQueDecia, 1745.73, "lo que la pantalla decía");
  assert.notEqual(loQueCobra, loQueDecia, "no coincidían: dos números para el mismo hecho");

  // Y con devolución de por medio, la pantalla ahora también acierta.
  const conDevolucion = i(moraBase(CARGO, 55938.06), 40);
  assert.equal(conDevolucion, 997.56, "la mitad, como la FI");
  assert.equal(Math.round((loQueCobra - conDevolucion) * 100) / 100, 997.56, "exactamente la mitad");
});

test("el capital nunca se llama «saldo pendiente»: no es el saldo", () => {
  const credit = src("src/lib/erp/credit.ts");
  const dt = src("src/lib/erp/doc-text.ts");
  // Con la base nueva, «saldo pendiente» describía otra cosa: el interés corre
  // sobre el cargo, menos lo devuelto si lo hubo.
  assert.ok(!credit.includes('? "saldo pendiente"'), "esa etiqueta se fue");
  assert.ok(credit.includes('"cargo menos lo devuelto"'), "y se nombra lo que es");
  assert.ok(credit.includes('"cargo original (el documento ya se pagó)"'), "sin perder el dato de que ya se pagó");
  // Y el papel del estado de cuenta lo explica, para que el cliente pueda
  // rehacer la cuenta con su hoja: la fila imprime el cargo entero, y el
  // interés sale de otra base.
  assert.ok(dt.includes("Si hubo devoluciones, el interés se calcula sobre el cargo menos lo devuelto"), "la leyenda lo dice");
});
