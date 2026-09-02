# Excel real vs. sistema — qué falta

Fecha: 31 de agosto de 2026. Solo diagnóstico; no se cambió código.
Se estudiaron completos los dos Excel de operación (utilidad/escenario de pago
real, y ventas 2025 con la hoja RUTA) y se comparó fórmula por fórmula contra
el código del sistema. **Este documento no contiene datos de clientes: los
ejemplos usan números inventados.**

Parámetros del negocio confirmados en el Excel (los cito porque son la regla,
no datos de clientes): spread de COBRO 9%, spread de COSTO ASR→Azagro 4%,
comisión Azagro→ASR 1% sobre costo de proveedor, FEGA 3.04% una vez, plazo de
factura 120 días, plazo de gracia/mora 150 días, año de 360.

---

## 1. Tabla de TIIE por mes y las DOS TIIE por factura

**EXISTE PERO DIFERENTE.**

**Excel:** una tabla mensual de TIIE (Banxico + 0.30 puntos de "protección"),
y cada factura usa **dos** TIIE distintas:
- Para **cobrar** al cliente: la TIIE del mes en que la factura cumple
  **150 días** (su vencimiento de mora).
- Para el **costo** de Azagro: la TIIE del mes de **emisión** de la factura.

**Sistema:** la tabla de TIIE por fecha sí existe (sirve para valores
mensuales) y el cobro sí toma "la TIIE vigente al vencimiento". Pero difiere
en dos cosas:

1. El "vencimiento" del sistema es el de **factura (120 días)**, no el de mora
   (150). Ejemplo: factura del 26 de marzo. Excel: 26-mar + 150 = agosto →
   TIIE de agosto. Sistema: 26-mar + 120 = julio → TIIE de julio. Con una
   TIIE bajando 0.25 puntos por mes, en $1,000,000 y 90 días de mora eso son
   ~$625 de diferencia por factura — y siempre en contra de lo que dice el
   Excel.
2. La **TIIE de emisión para el costo no existe en ningún lado**: el costo
   financiero del sistema usa una sola "TIIE por omisión" de Ajustes (la
   actual), igual para todas las facturas, viejas o nuevas. En el Excel cada
   factura carga el costo con la TIIE de su propio mes de emisión.

---

## 2. Costo financiero propio de Azagro (comisión + Capa 1 + Capa 2)

**EXISTE PERO DIFERENTE (y le faltan piezas centrales).**

**Excel** (viene del circuito con la empresa hermana, hoja RUTA: Azagro paga
al proveedor → factura el costo+1% a la hermana → la hermana le adelanta el
dinero → la hermana le refactura costo + interés):
- **Comisión 1%** sobre el costo de proveedor.
- **Capa 1** = costo × 1.01 × (TIIE emisión + 4%) × **150/360**, siempre
  (es el financiamiento del plazo completo).
- **Capa 2** = capital de la venta × (TIIE emisión + 4%) × **días excedidos
  de 150** / 360 (cuando el cliente se pasa del plazo, el fondeo sigue
  corriendo).

**Sistema (actualizado 1 de septiembre de 2026):** ya calcula las tres
piezas con los parámetros de Ajustes (comisión ASR 1%, spread ASR 4%), y el
financiamiento va **dentro del precio** al cliente:

- **Comisión 1%** sobre el costo de proveedor, una sola vez, sin días.
- **Capa 1** = costo × (TIIE vigente al cotizar + 4%) × **días de crédito del
  pedido** / 360. Dos diferencias deliberadas con el Excel: (a) los días son
  los del pedido, no 150 fijos; (b) va sobre el costo **solo**, no sobre
  costo × 1.01. El × 1.01 venía de que la hermana adelantaba costo +
  comisión; con ASR la comisión no se capitaliza (decisión del dueño,
  1-sep-2026). Si ASR sí cobra interés sobre la comisión, es una línea en
  `financeCost` (`src/lib/erp/credit.ts`).
- **Capa 2** = capital de la venta × (TIIE + 4%) × días excedidos / 360, en
  la utilidad por pedido (`src/lib/erp/reports.ts`). No va en el precio.
- Al contado (0 días) el financiamiento es $0, comisión incluida.
- El "spread de línea 4.5%" que había en Ajustes **se eliminó**: era un
  legado del primer commit (una sola capa sin comisión), no un 1%
  amortizado. Hoy nada lo usa.

Lo que sigue pendiente de este punto: la TIIE es la vigente al cotizar, no la
del mes de emisión de la factura (ver punto 1).

Ejemplo con costo de proveedor $100,000, TIIE 10%, 150 días de crédito,
cliente que paga 90 días tarde sobre una venta de $115,000:
- Excel: comisión $1,000 + Capa 1 = $101,000 × 14% × 150/360 = $5,891.67 +
  Capa 2 = $115,000 × 14% × 90/360 = $4,025. **Total: $10,916.67.**
- Sistema: comisión $1,000 + Capa 1 = $100,000 × 14% × 150/360 = $5,833.33
  (en el precio) + Capa 2 $4,025 (en la utilidad). **Total: $10,858.33.**
La única diferencia son los $58.34 de interés sobre la comisión.

---

## 3. Utilidad por operación

**EXISTE PERO DIFERENTE.**

**Excel:** utilidad final = venta + mora cobrable + diferencial cambiario
(cuando la política del lote lo deja como utilidad) − costo proveedor −
comisión 1% − Capa 1 − Capa 2 − descuento por pronto pago.

**Sistema:** utilidad por pedido = venta − costo (de la OC ligada, o de la
cotización, o del catálogo) − flete − otros − gastos ligados; el financiero
(una capa) se muestra aparte. Le faltan, contra el Excel:
- La **mora** como ingreso (además, por un defecto ya anotado en LOGICA.md,
  el renglón de mora del P&L siempre da $0).
- El **diferencial cambiario**.
- La **comisión 1%** y la **Capa 2** como costo.
- El **descuento por pronto pago** como costo.

Con el ejemplo del punto 2, el Excel reporta una utilidad y el sistema otra,
$6,000–$10,000 más alta por operación mediana. Antes de meter datos reales
hay que alinear esta fórmula, porque es el número con el que van a evaluar el
negocio.

---

## 4. Tipo de cambio pactado y ajuste al pagar

**EXISTE PERO DIFERENTE (guardado sí; detección y ajuste no).**

**Excel:** cada factura USD guarda su TC pactado. Al pagar, se captura cuántos
pesos entraron; el Excel calcula el TC real de pago y el diferencial contra el
pactado, y lo clasifica **por lote de pago según la negociación**: un lote se
dejó como utilidad/pérdida de Azagro, y los lotes posteriores se ajustan al
pactado — si pagaron de menos genera "POR COBRAR", si pagaron de más "POR
DEVOLVER".

**Sistema:** las facturas sí guardan TC pactado e importe USD, y la fórmula
del diferencial está programada. Pero:
- **Nadie captura el TC (ni los pesos) del pago** — el cobro no lo pregunta.
  Resultado: el diferencial siempre sale $0 (ya estaba anotado en LOGICA.md,
  hallazgo 13).
- No existen los documentos de ajuste ("por cobrar" / "por devolver").
- No existe la decisión por lote (dejarlo como utilidad vs. ajustar al
  pactado). En el Excel esa decisión se toma pago por pago; el sistema
  necesitaría preguntarla al registrar el cobro.

Ejemplo: factura de 10,000 USD a TC pactado 19.00 ($190,000). El cliente
deposita $186,000 (TC real 18.60). Excel: quedan **$4,000 POR COBRAR** (o se
asumen como pérdida, según el lote). Sistema: registra $186,000 y no se
entera de nada.

---

## 5. Bonificación por pronto pago

**EXISTE PERO DIFERENTE (regla distinta, y además solo informativa).**

**Excel:** solo aplica si el cliente paga **antes del día 120** contado desde
la fecha de factura. Se bonifican los días entre el pago y el **día 150**, a
la tasa de **COSTO** (TIIE de emisión + 4%), sobre el capital. La lógica: si
el cliente paga antes, Azagro se ahorra ese fondeo con la hermana y se lo
comparte.

**Sistema:** ni el umbral de 120, ni los días contra 150, ni la tasa de
costo. Lo que hace es mostrar "interés a favor" con la tasa de **cobro**
(TIIE + 9%) por los días entre el pago y el vencimiento de factura — y solo
como texto: nunca genera descuento real. (Hay una función de descuento por
días no usados escrita en el código, pero ninguna pantalla la llama.)

Ejemplo: capital $100,000, factura 1 de enero, paga el día 100.
- Excel: pagó antes de 120 ✓; días bonificados = 150 − 100 = 50; descuento =
  $100,000 × 14% × 50/360 = **$1,944** menos a pagar.
- Sistema: muestra "$889 a favor" (20 días × 16%) y cobra completo.

---

## 6. Interés sobre cargo original vs. saldo

**EXISTE PERO DIFERENTE — y el Excel responde la pregunta pendiente.**

**Excel (archivo nuevo, el vigente):** el interés se calcula **siempre sobre
el monto original facturado** (en USD, convertido al TC pactado), con TIIE del
mes de vencimiento + 9%, por los días excedidos de 150. El FEGA 3.04% también
sobre el monto original, una sola vez.

**Sistema, pantalla por pantalla:**
- Estado de cuenta (pantalla y papel): sobre el **cargo original** ✓ coincide.
- La FI que realmente se factura: sobre el **saldo pendiente** ✗ no coincide.

Esto ya estaba como pregunta abierta en LOGICA.md (hallazgo 12); **el Excel la
resuelve: la regla es CARGO original.** Hay que alinear la FI.

Nota: el archivo de ventas (hojas de cartera más viejas) usaba otra regla:
tasa fija 18% y el interés calculado sobre **capital + comisión FEGA** (el
interés corría también sobre el 3.04%). El archivo nuevo ya no lo hace (TIIE
+ 9%, sobre capital solo). Asumo que la regla vigente es la del archivo
nuevo — confírmalo, porque en $1,000,000 con 90 días la diferencia entre las
dos reglas es de ~$6,000.

---

## 7. Agrupación de clientes (grupo de sociedades)

**YA EXISTE (la base), falta el reporte consolidado de utilidad.**

**Sistema:** cada cliente tiene "grupo", y el estado de cuenta vivo se puede
filtrar por grupo — eso da la cartera consolidada de las sociedades. ✓

**Lo que el Excel tiene y el sistema no:**
- **Estado de resultados por razón social** (venta, mora, costo, comisión,
  Capa 1, Capa 2, descuento y utilidad **por cada sociedad**, lado a lado, y
  el total del grupo).
- El **PANORAMA** consolidado: resultado del negocio + cobranza de capital +
  cobranza de intereses + gran total por cobrar, todo en una vista.
El P&L del sistema es global de la empresa o por pedido individual; no hay
corte por cliente/sociedad ni por grupo.

---

## 8. Utilidad devengada vs. realizada vs. en caja

**NO EXISTE.**

El Excel maneja cuatro visiones y el sistema solo una:

| Visión | Excel | Sistema |
|---|---|---|
| **Devengada** (todo, cobrado o no) | ✓ | ✓ (P&L por pedido/global) |
| **Realizada** (devengada − mora aún no cobrada) | ✓ | ✗ |
| **En caja** (solo facturas 100% cobradas, con su mora) | ✓ | ✗ |
| **Proporcional** (utilidad × % pagado de cada factura) | ✓ | ✗ |

Ejemplo: una operación con utilidad devengada de $100,000 de la cual el
cliente ha pagado 60%: el Excel reporta devengada $100,000, proporcional
$60,000, y en caja $0 (la factura no está liquidada). El sistema solo sabe
decir "$100,000". Para un negocio cuya cartera cobra a 150 días, la
diferencia entre "utilidad en papel" y "utilidad en caja" es justo lo que el
dueño necesita ver.

---

## 9. Otras cosas del Excel que el sistema no contempla

1. **El circuito documental con la empresa hermana (RUTA) — NO EXISTE.** El
   Excel registra, por cada operación: la factura de Azagro a la hermana
   (costo + 1%), el pago de la hermana a Azagro (así se fondea la operación),
   y la refactura de la hermana a Azagro (costo + TIIE+4% × 150/360), con
   folios reales por renglón de producto. El sistema solo marca el pedido
   como "ruta ASR" y se salta la bodega: **no genera ninguna de esas
   facturas, ni sus cuentas por cobrar/pagar, ni su costo**. Todo el punto 2
   nace de aquí: sin este circuito, el costo financiero real no tiene de
   dónde salir. (Los parámetros — comisión 1% y spread 4% — ya están en
   Ajustes; hoy son decorativos.)

2. **Saldos por vencer proyectados por mes futuro — NO EXISTE.** El estado de
   cuenta del Excel trae "por vencer en diciembre, enero, febrero…" (a qué
   mes se le vence cada saldo a 150 días), que es la base de la propuesta de
   pago al cliente. El sistema solo tiene antigüedad de lo YA vencido
   (1-30 / 31-60 / 61+).

3. **Estado de cuenta bimoneda al TC pactado — PARCIAL.** El Excel presenta
   el bloque USD y aparte "USD traducido a pesos al TC pactado de cada
   factura", y suma ambos. El sistema mezcla todo en pesos y el desglose por
   moneda del estado de cuenta usa el importe en pesos, no la vista "en USD +
   su equivalente al pactado".

4. **Cobro de intereses en dólares — NO EXISTE.** En el Excel hubo cobros de
   mora hechos en USD, convertidos al TC del día del cobro. Las FI del
   sistema son siempre en pesos y el cobro no pregunta moneda ni TC.

5. **La mora corre desde el día 150 contado desde la FECHA DE FACTURA.** Las
   dos versiones del Excel coinciden ("vencimiento a 150 días" = fecha de
   factura + 150; días excedidos = los que pasen de ahí). Esto **resuelve el
   hallazgo 4 de LOGICA.md**: el sistema hoy cuenta la mora desde el
   vencimiento de factura (120) — 30 días de más. La regla del negocio es:
   factura vence a 120 (para gestión de cobro), la mora empieza al día 150.

6. **TIIE con colchón de +0.30 puntos.** La tabla del Excel no es la TIIE
   Banxico pura: le suman 0.30 de protección. Como en el sistema la tabla se
   captura a mano, basta capturarla ya con el colchón — pero conviene
   escribir la regla en Ajustes para que quien capture lo sepa.

7. **Parámetro "18%" fósil.** El Excel nuevo muestra todavía una "tasa de
   cobro 18%" en un rincón, pero ninguna fórmula la usa (todas usan
   TIIE + 9%). Solo para que no te sorprenda si lo ves; la regla viva es
   TIIE + 9%.

8. **Lo que sí cuadra y no hay que tocar:** la liga renglón de venta ↔ OC ↔
   factura de proveedor ↔ punto de entrega del REPORTE ya la cubre el
   expediente del sistema; el FEGA 3.04% una vez, los días calendario
   exactos y el /360 coinciden; y la tabla TIIE del sistema puede alojar la
   mensual del Excel tal cual.

---

## Resumen — los diez faltantes, en orden de dolor

| # | Qué falta | Veredicto | Dónde pega |
|---|---|---|---|
| 1 | Mora desde el día 150 (hoy 120) — regla confirmada por el Excel | DIFERENTE | Cobra 30 días de más al cliente |
| 2 | FI sobre cargo original (hoy sobre saldo) — regla confirmada | DIFERENTE | Factura mora distinta a la pactada |
| 3 | TIIE de emisión + Capa 1 + Capa 2 + comisión 1% (costo propio) | DIFERENTE / NO EXISTE | Utilidad inflada ~$6–11 mil por operación mediana |
| 4 | Circuito documental con la hermana (facturas ida y vuelta) | NO EXISTE | CxC/CxP y costo real del fondeo |
| 5 | TC del pago + ajuste por cobrar/devolver + decisión por lote | NO EXISTE (guardado sí) | Diferencial cambiario siempre $0 |
| 6 | Pronto pago real: umbral 120, bonificar contra 150 a tasa de costo | DIFERENTE | Se muestra un número y no se descuenta nada |
| 7 | Utilidad devengada / realizada / caja / proporcional | NO EXISTE | La visión del dueño sobre el negocio |
| 8 | P&L por razón social y consolidado del grupo (PANORAMA) | NO EXISTE | Reporte mensual que hoy hace el Excel |
| 9 | Saldos por vencer por mes futuro (propuesta de pago) | NO EXISTE | Gestión de cobranza |
| 10 | Mora del P&L por pedido en $0 + parámetros ASR sin usar | DEFECTO ya anotado | LOGICA.md h.6 |

Los puntos 1 y 2 son además la respuesta a dos preguntas de negocio que
LOGICA.md dejó abiertas (hallazgos 4 y 12): el Excel ya decidió — mora desde
el día 150 y siempre sobre el cargo original. Con tu confirmación, esos dos se
corrigen de inmediato junto con los INCORRECTOS de LOGICA.md, y el resto se
puede ir armando por bloques (costo propio y circuito hermana primero, que es
de donde sale la utilidad real).
