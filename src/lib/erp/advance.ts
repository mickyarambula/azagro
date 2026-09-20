/**
 * EL SALDO A FAVOR DEL CLIENTE — el anticipo (L5, Decisiones 12 y 13).
 *
 * El defecto que cierra: un cobro mayor al saldo perdía el sobrante **dos
 * veces**. En la cartera, porque `applied = Math.min(importe, saldo)`; y en el
 * banco, porque el movimiento se registraba por lo aplicado y no por lo que de
 * verdad se depositó (`ops.ts`, las cuatro ramas de moneda). Un depósito de
 * $1,000 contra un saldo de $700 dejaba $300 que no estaban en la cartera, no
 * estaban en la caja y no estaban en ningún lado — y la conciliación contra el
 * banco quedaba descuadrada sin que nada lo explicara.
 *
 * **LA FORMA: el anticipo no es un documento nuevo.** Un cobro (PAG) ya es un
 * documento con folio, fecha, banco y bitácora; un sobrepago no es dinero de
 * otra naturaleza, es dinero recibido que todavía no se aplicó a nada. Así que:
 *
 *   saldo a favor de un cobro = `payments.amount` − Σ `payment_allocs.amount`
 *
 * **Derivado, nunca guardado** — el mismo patrón de `creditExposure`,
 * `fx-position.ts` y `fx-cost-query.ts`. No hay columna «anticipo» que se
 * pueda desincronizar del dinero, porque el dinero ES la cuenta.
 *
 * Y de ahí cae sola la Decisión 13 (un depósito que paga varias facturas lo
 * reparte la persona): **un PAG con N aplicaciones**. Las dos mitades de L5
 * resultan ser el mismo mecanismo, no dos.
 *
 * **Por qué el sobrante nace como su PROPIO PAG** y no agrandando el del
 * cobro: `payments.amount` significa hoy «lo aplicado a la factura, en pesos»,
 * y `fx-cost-query.ts` construye el diferencial cambiario del mes sobre esa
 * definición exacta (`banco − aplicado`). Cambiarle el significado a esa
 * columna movería números ya auditados. Un PAG aparte, sin aplicar, no le
 * cambia el significado a nada: lo que entró son dos renglones de banco que
 * suman el depósito real, y el que no está aplicado es el saldo a favor.
 *
 * Sin imports a propósito: la prueba lo carga directo.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Lo que de verdad entró al banco contra lo que se consumió al aplicar.
 *
 * Las dos cifras van en la moneda de la CUENTA, que es donde el dinero está
 * parado. Importa: con una factura en dólares pagada en pesos, lo aplicado a
 * la factura va al TC pactado y lo que salió del banco al TC del pago — son
 * números distintos a propósito, y el sobrante se mide contra el segundo,
 * porque el sobrante son pesos que siguen en la cuenta, no crédito.
 */
export function depositSplit(i: { deposited: number; used: number }) {
  const deposited = r2(Math.max(0, i.deposited));
  const used = r2(Math.max(0, Math.min(i.used, deposited)));
  return { used, leftover: r2(deposited - used) };
}

/**
 * Lo que a un cobro le queda sin aplicar. Cero (nunca negativo) si ya se
 * repartió todo: un PAG no puede tener más aplicado que su importe, y si
 * alguna vez lo tuviera, el número honesto es 0 y el problema se ve en otro
 * lado, no aquí.
 */
export function unappliedOf(amount: number, allocated: number) {
  return r2(Math.max(0, r2(amount) - r2(allocated)));
}

/** ¿Este cobro tiene saldo a favor? El umbral de siempre: un centavo. */
export function hasCredit(amount: number, allocated: number) {
  return unappliedOf(amount, allocated) > 0.009;
}

export type CreditSource = {
  /** Folio del documento que trae el crédito (PAG-000N, o la NC que lo originó). */
  name: string;
  date: string;
  /** Lo que queda sin aplicar. */
  available: number;
  currency: string;
  memo: string;
};

/**
 * Cuánto de un saldo a favor cabe en una factura. Ni más de lo que la factura
 * debe (le sobraría otra vez), ni más de lo que el crédito tiene.
 *
 * Devuelve también el motivo cuando no cabe nada, porque una pantalla que
 * enseña «0.00» sin decir por qué obliga a adivinar.
 */
export function applyableCredit(available: number, residual: number) {
  const a = r2(Math.max(0, available));
  const r = r2(Math.max(0, residual));
  if (a <= 0.009) return { amount: 0, reason: "Este cobro ya no tiene saldo a favor: se aplicó completo." };
  if (r <= 0.009) return { amount: 0, reason: "Esta factura ya no debe nada: no hay a qué aplicarle el saldo a favor." };
  return { amount: r2(Math.min(a, r)), reason: "" };
}

/**
 * LA PROPUESTA DE REPARTO (Decisión 13): de la más vieja a la más nueva, hasta
 * donde alcance. **El sistema propone, la persona confirma o cambia** — porque
 * muchas veces el cliente dice cuál factura está pagando y eso el sistema no
 * lo sabe. Por eso esto devuelve una propuesta editable, nunca la aplica.
 *
 * Las facturas llegan ya ordenadas por quien consulta (el orden es de la
 * consulta, no de aquí): esta función solo reparte respetando ese orden.
 */
export function proposeSplit(amount: number, invoices: Array<{ id: number; residual: number }>) {
  let left = r2(Math.max(0, amount));
  const rows: Array<{ id: number; amount: number }> = [];
  for (const inv of invoices) {
    if (left <= 0.009) break;
    const take = r2(Math.min(left, r2(Math.max(0, inv.residual))));
    if (take <= 0.009) continue;
    rows.push({ id: inv.id, amount: take });
    left = r2(left - take);
  }
  // Lo que no cupo en ninguna factura queda como saldo a favor: no se fuerza
  // dentro de la última ni se descarta (Decisión 12).
  return { rows, leftover: r2(left) };
}

/**
 * LOS DOS NÚMEROS DE UNA REVERSA DE ABONO, de una sola cuenta.
 *
 * La vista previa promete cuánto va a volver a deber la factura y el ejecutor
 * escribe el abono contrario. Hasta el 19-sep-2026 los dos salían de restas
 * distintas y, en cuanto existieron aplicaciones PARCIALES (el saldo a favor),
 * dejaron de coincidir: se prometía devolver $300 y se escribían $200.
 *
 * Aquí salen del mismo lugar, así que no pueden separarse otra vez. Lo que se
 * contraría es **lo que ESA factura recibió** (`allocAmount`), nunca el importe
 * del cobro: un cobro puede estar aplicado en parte, y devolverle a la factura
 * más de lo que recibió le inventaría deuda.
 */
export function reversalOfAllocation(i: { residualNow: number; allocAmount: number; discount?: number }) {
  const alloc = r2(i.allocAmount);
  const discount = r2(i.discount ?? 0);
  return {
    /** Lo que se ESCRIBE como abono contrario. */
    contraAlloc: r2(-alloc),
    /** Lo que se ENSEÑA que la factura volverá a deber. */
    residualAfter: r2(Math.max(0, r2(i.residualNow) + alloc + discount)),
  };
}

/**
 * LA FECHA CON LA QUE SE MIDE EL PRONTO PAGO (Decisión 94, corregida el
 * 19-sep-2026 tras la quinta revisión del revisor de dinero).
 *
 * El pronto pago devuelve el financiamiento que el precio cobró y que no se
 * usó, así que hay que medir **cuándo terminó de entrar el dinero de esa
 * factura** — no cuándo entró el último pedazo que alguien decidió aplicar.
 *
 * El agujero que cierra: midiendo solo con la fecha del crédito que se está
 * aplicando, un anticipo VIEJO hacía retroceder el reloj. Factura de
 * $111,876.11 a 150 días, cobrada casi entera el día 200 —cincuenta días
 * TARDE, sin bonificación—, quedan $5,000; se le aplica un anticipo de $100 y
 * el sistema creía que se había pagado el día cero: bono ganado $5,081.04, y
 * como los $4,900 restantes caben dentro, **los perdonaba**. Casi cinco mil
 * pesos regalados a quien pagó tarde. Y la pantalla propone primero las
 * facturas más viejas, que son justo las más propensas a estar vencidas.
 *
 * La regla: **la más tarde de todas** — cada abono vivo de la factura, y la
 * propia factura como piso (no pudo pagarse antes de existir, Decisión 93).
 * Así las dos puertas miden igual por construcción, que era el punto de la
 * Decisión 94, en vez de por coincidencia.
 */
export function earlyPayMeasureDate(invoiceDate: string, abonoDates: Array<string | null | undefined>) {
  let d = String(invoiceDate).slice(0, 10);
  for (const raw of abonoDates) {
    if (!raw) continue;
    const x = String(raw).slice(0, 10);
    if (x > d) d = x;
  }
  return d;
}

/**
 * LA BASE SOBRE LA QUE SE CALCULA EL PRONTO PAGO (L3c, 19-sep-2026).
 *
 * El bono devuelve el financiamiento que el precio cobró y que no se usó **por
 * haber pagado antes**. Lo que el cliente DEVOLVIÓ no se pagó antes: se
 * deshizo, y por eso sale de la base.
 *
 * El agujero que cierra: se le negaba el bono a quien aplicaba el crédito de
 * una devolución, pero un cobro posterior de cualquier tamaño —hasta un
 * centavo— lo disparaba sobre el cargo COMPLETO y perdonaba el resto. Sobre
 * una factura de $111,876.11 al 11.05 % con 145 días sin usar, $4,979.26 por
 * la puerta de al lado. Una puerta cerrada y la de junto abierta no cierra
 * nada — es la lección que costó cinco revisiones en el bloque L5.
 */
export function earlyPayBase(cargo: number, devuelto: number) {
  return Math.max(0, r2(r2(cargo) - r2(Math.max(0, devuelto))));
}

/** El memo con el que nace el crédito que deja una devolución (L3c). */
export const RETURN_CREDIT_MEMO = "Saldo a favor (devolución ";

/**
 * ¿Este cobro es el crédito que dejó una devolución? Un solo lugar, porque de
 * él cuelgan DOS reglas distintas —la fecha con la que se mide la mora
 * (Decisión 97) y que no gane pronto pago (Decisión 96)— y tenerlo escrito dos
 * veces es cómo empiezan a divergir: un día alguien cambia una cadena y no la
 * otra, y el mismo cobro es devolución para una cosa y no para la otra.
 */
export function isReturnCredit(memo: string | null | undefined) {
  return String(memo ?? "").startsWith(RETURN_CREDIT_MEMO);
}

/**
 * LA BASE SOBRE LA QUE CORRE LA MORA (L3b, Decisión 10, 20-sep-2026).
 *
 * El interés corre sobre el CARGO ORIGINAL, no sobre el saldo: un abono
 * parcial no lo congela ni reduce la base (regla del Excel, `CLAUDE.md` § 1).
 * **Y eso sigue siendo verdad.** Una DEVOLUCIÓN no es un abono: un abono es
 * dinero que paga la deuda, una devolución es mercancía que regresó, o sea que
 * el cargo original resultó ser otro. Sobre la parte devuelta nunca hubo venta
 * que financiar, así que nunca hubo interés que cobrar.
 *
 * El propio sistema ya escribió esa distinción tres veces antes de llegar aquí:
 * `returnedOfInvoices` la separa por documento (la nota de crédito, no el
 * abono), la Decisión 96 saca lo devuelto de la base del pronto pago con esta
 * misma resta, y la Decisión 97 lo dice con todas sus letras — «mercancía
 * devuelta nunca fue dinero disponible».
 *
 * `ajusta = false` es la salida caso por caso de la Decisión 10: quien tenga
 * permiso puede decidir que esta devolución NO baje la mora (no es lo mismo un
 * error de Azagro que un sobrante del cliente), y eso queda en bitácora.
 */
export function moraBase(cargo: number, devuelto: number, ajusta = true) {
  const c = Math.max(0, r2(cargo));
  return ajusta ? Math.max(0, r2(c - Math.max(0, r2(devuelto)))) : c;
}
