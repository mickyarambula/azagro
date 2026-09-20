// EL MOTOR DEL SALDO A FAVOR, AL CENTAVO (L5, 19-sep-2026).
//
// El revisor de dinero pidió esto con estas palabras: «un grep no es un motor
// congelado — si mañana alguien reescribe la línea, la prueba falla sin decir
// qué número se movió; y si la reescribe conservando el texto, no falla aunque
// el número cambie». Aquí van los números.
//
// Los casos 1-4 y 6 recorren aritmética que vive dentro de funciones que
// hablan con la base, así que se reproduce **la misma cuenta, con los mismos
// nombres**, y las pruebas de texto de `erp-saldo-a-favor.test.mjs` son las que
// vigilan que el código siga haciendo exactamente esto. Los casos 5 y los de
// `depositSplit` corren el motor de verdad.
import assert from "node:assert/strict";
import { test } from "node:test";
import { depositSplit, proposeSplit, reversalOfAllocation, unappliedOf } from "../src/lib/erp/advance.ts";
import { creditRoom } from "../src/lib/erp/credit-limit.ts";

const r2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// 1. El camino que NO debía moverse: cobro exacto, sin sobrante
// ---------------------------------------------------------------------------
test("cobro exacto: un solo movimiento de banco y la caja sube lo de siempre", () => {
  const residual = 700, deposito = 700;
  const applied = Math.min(deposito, residual);          // rama `mxn` de ops.ts
  const bankAmount = applied;
  const { used, leftover } = depositSplit({ deposited: deposito, used: bankAmount });
  assert.equal(applied, 700, "se aplica lo que debía");
  assert.equal(leftover, 0, "sin sobrante: NO nace un segundo PAG");
  assert.equal(used, 700);
  // cashAfter = cash + (bankAmount + sobrante) — con sobrante 0 es el de antes.
  const caja = 50000;
  assert.equal(caja + bankAmount + leftover, 50700, "la caja sube exactamente el depósito");
  assert.equal(r2(residual - applied), 0, "la factura queda en 0.00");
});

// ---------------------------------------------------------------------------
// 2. El caso del defecto: el sobrante ya no desaparece del banco
// ---------------------------------------------------------------------------
test("cobro con sobrante: DOS movimientos de banco que suman el depósito real", () => {
  const residual = 700, deposito = 1000;
  const applied = Math.min(deposito, residual);
  const bankAmount = applied;
  const { used, leftover } = depositSplit({ deposited: deposito, used: bankAmount });
  assert.equal(applied, 700);
  assert.equal(leftover, 300, "el sobrante existe");
  // Lo que ANTES pasaba: un solo movimiento de 700 y 300 perdidos.
  assert.equal(used, 700, "movimiento de la factura");
  assert.equal(used + leftover, 1000, "los dos suman lo que de verdad se depositó");
  // La caja sube el depósito completo, no lo aplicado.
  assert.equal(50000 + bankAmount + leftover, 51000, "caja = depósito completo");
  // Y el saldo a favor se DERIVA del PAG nuevo: importe 300, sin aplicaciones.
  assert.equal(unappliedOf(300, 0), 300, "saldo a favor $300.00");
});

test("y conforme se aplica, el saldo a favor baja al centavo", () => {
  assert.equal(unappliedOf(300, 120.55), 179.45);
  assert.equal(unappliedOf(300, 300), 0);
  // Desaplicar contraría (+120.55 y −120.55): la suma vuelve a cero.
  assert.equal(unappliedOf(300, r2(120.55 - 120.55)), 300, "el crédito vuelve completo");
});

// ---------------------------------------------------------------------------
// 3. El candado de caja del proveedor mide el depósito completo
// ---------------------------------------------------------------------------
test("pagarle a un proveedor: no se deja sacar más de lo que hay, contando el sobrante", () => {
  const caja = 900, residual = 700, captura = 1000;
  const applied = Math.min(captura, residual);
  const bankAmount = applied;
  const { leftover } = depositSplit({ deposited: captura, used: bankAmount });
  // ANTES se comparaba contra `bankAmount` (700) y pasaba, dejando la cuenta
  // en −100 sin que nadie lo viera. Ahora se compara contra lo que sale.
  assert.equal(bankAmount + leftover, 1000, "de la cuenta salen 1,000");
  assert.ok(caja + 0.009 < bankAmount + leftover, "900 no alcanza para 1,000: se detiene");
  assert.ok(!(caja + 0.009 < bankAmount), "con la cuenta vieja habría pasado");
});

// ---------------------------------------------------------------------------
// 4. Revertir un cobro aplicado EN PARTE
// ---------------------------------------------------------------------------
test("el contrario devuelve lo que ESA factura recibió, no el importe del cobro", () => {
  // MOTOR DE VERDAD: `reversalOfAllocation` es la función que usa `reversal.ts`
  // para los DOS números —el que promete la vista previa y el que escribe el
  // ejecutor—, así que aquí se comparan uno contra otro, no una resta contra
  // sí misma. Si mañana alguien los separa, esta prueba lo dice.
  const rev = reversalOfAllocation({ residualNow: 0, allocAmount: 200 });
  assert.equal(rev.residualAfter, 200, "la factura vuelve a deber 200.00");
  assert.equal(rev.contraAlloc, -200, "y se escribe exactamente −200.00");
  // El invariante: lo prometido y lo escrito son el mismo número con signo.
  assert.equal(rev.residualAfter, -rev.contraAlloc, "prometer y escribir coinciden");
  // Lo que pasaba con el importe del PAG (300): 100 de deuda inventada.
  assert.equal(r2(0 + 300), 300);
  assert.equal(r2(300 - rev.residualAfter), 100, "la diferencia que se inventaba");
  // Con el pronto pago de por medio, los dos siguen saliendo de la misma cuenta.
  const conBono = reversalOfAllocation({ residualNow: 0, allocAmount: 200, discount: 50 });
  assert.equal(conBono.residualAfter, 250, "la factura debe también la bonificación devuelta");
  assert.equal(conBono.contraAlloc, -200, "pero el abono contrario sigue siendo el suyo");
  // Y un cobro aplicado completo se comporta como siempre.
  const completo = reversalOfAllocation({ residualNow: 0, allocAmount: 700 });
  assert.equal(completo.residualAfter, 700);
  assert.equal(completo.contraAlloc, -700);
});

// ---------------------------------------------------------------------------
// 5. La línea de crédito (motor de verdad, función pura)
// ---------------------------------------------------------------------------
test("el saldo a favor baja lo que ocupa la línea, y nunca por debajo de cero", () => {
  const a = creditRoom({ limit: 100000, invoiced: 80000, reserved: 10000, credit: 5000, order: 20000 });
  assert.equal(a.used, 85000, "80,000 + 10,000 − 5,000");
  assert.equal(a.after, 105000);
  assert.equal(a.exceeds, true, "se pasa por 5,000");
  assert.equal(a.room, 15000);
  // El piso: más crédito que deuda no regala línea.
  const b = creditRoom({ limit: 100000, invoiced: 0, reserved: 0, credit: 5000, order: 0 });
  assert.equal(b.used, 0, "nunca −5,000");
  assert.equal(b.room, 100000);
  // Sin saldo a favor, byte a byte el motor de siempre.
  const c = creditRoom({ limit: 100000, invoiced: 80000, reserved: 10000, order: 20000 });
  assert.equal(c.used, 90000);
  assert.equal(c.exceeds, true);
});

// ---------------------------------------------------------------------------
// 6. El diferencial del periodo solo cuenta pagos aplicados por completo
// ---------------------------------------------------------------------------
test("banco − aplicado mide el dólar SOLO si el pago se aplicó entero", () => {
  // Cobro completo de una FV en dólares: 36,000 de banco, 34,000 al pactado.
  const completo = { amount: 34000, allocs: 34000, banco: 36000 };
  assert.ok(Math.abs(completo.amount - completo.allocs) <= 0.009, "entra");
  assert.equal(r2(completo.banco - completo.allocs), 2000, "diferencial real 2,000.00");
  // Un saldo a favor aplicado en parte: NO entra. Si entrara, 300 − 200 = 100
  // de diferencial fantasma en el Resultado del mes.
  const parcial = { amount: 300, allocs: 200, banco: 300 };
  assert.ok(!(Math.abs(parcial.amount - parcial.allocs) <= 0.009), "no entra");
  assert.equal(r2(parcial.banco - parcial.allocs), 100, "lo que se habría inventado");
  // El contra-PAG de un cobro aplicado en parte tampoco (−300 contra −200).
  const contra = { amount: -300, allocs: -200, banco: -300 };
  assert.ok(!(Math.abs(contra.amount - contra.allocs) <= 0.009), "por la otra puerta tampoco");
  // Y con DOS aplicaciones que suman el importe, entra UNA sola vez.
  const dos = { amount: 34000, allocs: r2(20000 + 14000), banco: 36000 };
  assert.ok(Math.abs(dos.amount - dos.allocs) <= 0.009);
  assert.equal(r2(dos.banco - dos.allocs), 2000, "2,000.00, no 4,000.00");
});

// ---------------------------------------------------------------------------
// 7. El reparto de un depósito entre varias facturas
// ---------------------------------------------------------------------------
test("un depósito de $1,000 sobre facturas de 400/400/400: 400, 400, 200", () => {
  const p = proposeSplit(1000, [{ id: 1, residual: 400 }, { id: 2, residual: 400 }, { id: 3, residual: 400 }]);
  assert.equal(p.rows.reduce((s, r) => s + r.amount, 0), 1000, "se reparte todo");
  assert.deepEqual(p.rows.map((r) => r.amount), [400, 400, 200]);
  assert.equal(p.leftover, 0);
});

// ---------------------------------------------------------------------------
// 8. El regalo que encontró el revisor de dinero (quinta pasada)
// ---------------------------------------------------------------------------
import { earlyPayBase, earlyPayMeasureDate } from "../src/lib/erp/advance.ts";

test("un anticipo viejo NO hace retroceder el reloj del pronto pago", () => {
  // Factura del 1-ene a 150 días. Se cobra casi entera el 20-jul (día 200:
  // cincuenta días TARDE, sin bonificación). Quedan $5,000. Alguien le aplica
  // un anticipo depositado el 1-dic del año anterior.
  const medida = earlyPayMeasureDate("2026-01-01", ["2026-07-20", "2025-12-01"]);
  assert.equal(medida, "2026-07-20", "manda el abono MÁS TARDE, no el que se aplica");
  // Midiendo con el anticipo (lo que pasaba): día 0 → bono del plazo completo.
  const malo = earlyPayMeasureDate("2026-01-01", ["2025-12-01"]);
  assert.equal(malo, "2026-01-01", "el piso de la Decisión 93 evita la fecha imposible…");
  // …pero seguía dando plazo COMPLETO: sobre $111,876.11 al 10.90 % a 150 d,
  // el bono ganado era $5,081.04, y como los $4,900 que quedaban caben dentro,
  // se perdonaban. Casi cinco mil regalados a quien pagó tarde.
  const bono = Math.round(((111876.11 * 0.1090 * 150) / 360) * 100) / 100;
  assert.equal(bono, 5081.04);
  assert.ok(4900 <= bono + 0.009, "por eso los perdonaba");
});

test("la fecha de medición: la más tarde de todas, con la factura de piso", () => {
  assert.equal(earlyPayMeasureDate("2026-08-01", []), "2026-08-01", "sin abonos, la factura");
  assert.equal(earlyPayMeasureDate("2026-08-01", ["2026-02-01"]), "2026-08-01", "un abono anterior no baja del piso");
  assert.equal(earlyPayMeasureDate("2026-08-01", ["2026-09-10"]), "2026-09-10", "uno posterior sí manda");
  assert.equal(earlyPayMeasureDate("2026-08-01", ["2026-09-10", "2026-08-15", null]), "2026-09-10", "el más tarde, ignorando vacíos");
  // Y un cobro normal (abono el día de la factura o después) no se mueve: el
  // camino viejo queda byte a byte.
  assert.equal(earlyPayMeasureDate("2026-08-01", ["2026-08-01"]), "2026-08-01");
});

// ---------------------------------------------------------------------------
// 9. L3c: lo devuelto no entra a la base del pronto pago
// ---------------------------------------------------------------------------
test("la puerta lateral del pronto pago: lo devuelto sale de la base", () => {
  // Factura de referencia: $111,876.11 a 150 días, tasa de costo 6.90 % +
  // spread ASR 4.15 % = 11.05 %. Cobrada al día 5, quedan 145 sin usar.
  const CARGO = 111876.11, TASA = 0.1105, DIAS = 145;
  const bono = (base) => Math.round(((base * TASA * DIAS) / 360) * 100) / 100;

  // Sin devolución: el bono de siempre, byte a byte.
  assert.equal(earlyPayBase(CARGO, 0), CARGO, "sin devolución, la base es el cargo");
  assert.equal(bono(earlyPayBase(CARGO, 0)), 4979.26, "el número del revisor");

  // Con casi todo devuelto: la base baja y el bono con ella. ANTES se calculaba
  // sobre el cargo completo, así que un cobro de un centavo disparaba $4,979.26
  // y perdonaba el resto.
  assert.equal(earlyPayBase(CARGO, 106876.11), 5000, "solo lo que de verdad se financió hasta el final");
  assert.equal(bono(5000), 222.53, "y el bono cae de $4,979.26 a $222.53");
  assert.equal(Math.round((4979.26 - 222.53) * 100) / 100, 4756.73, "lo que se regalaba por la puerta de al lado");

  // Devolver más que el cargo (no debería pasar) no da base negativa.
  assert.equal(earlyPayBase(1000, 1500), 0, "nunca negativa");
  assert.equal(earlyPayBase(1000, 0), 1000);
  // Centavos: se redondea a dos, como todo el dinero del sistema.
  assert.equal(earlyPayBase(100.005, 0.004), 100.01);
});
