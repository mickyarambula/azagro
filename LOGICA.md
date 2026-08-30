# Auditoría de lógica de negocio — Azagro ERP

Fecha: 30 de agosto de 2026. Solo diagnóstico; no se cambió nada de código.
Se siguió el código paso a paso con escenarios concretos, antes de meter datos
reales. Clasificación de cada hallazgo:

- **INCORRECTO** — da un número mal, verificado con ejemplo.
- **INCOMPLETO** — el caso no está contemplado; el sistema no tiene cómo hacerlo.
- **DUDOSO** — funciona, pero la regla de negocio no está decidida y hay que decidirla.

Para los ejemplos uso una tasa redonda: TIIE 7% + 9% = **16% anual**, año de 360 días.

---

## Lo que SÍ está bien (para que no lo busques)

- La fórmula base de interés (cargo × tasa × días exactos / 360, con signo) y el
  3.04% de comisión+FEGA una sola vez **coinciden con el Excel** y tienen pruebas.
- El kardex es inmutable, con candados contra dos operaciones simultáneas, y
  **no deja sacar más de lo que hay** ni quedar en negativo.
- El traslado entre bodegas sale al costo promedio del origen y entra mezclando
  bien el promedio del destino. El promedio móvil en recepciones es correcto.
- Pegar dos veces el mismo CSV de corte no duplica nada.
- Un pago parcial normal (factura del sistema, sin abonos previos de Compaq)
  deja el saldo correcto.

---

## HALLAZGO 1 — Al abonar a una factura importada de Compaq, el abono viejo se borra

**INCORRECTO. El más grave de toda la auditoría. Corregir antes del corte.**

Cuando importas un saldo abierto de Compaq, el sistema guarda el cargo original
y el saldo. Ejemplo real del formato del corte: cargo $150,000, abono previo
$20,000, saldo $130,000.

El problema: cada vez que registras un cobro, el sistema **recalcula el saldo
como "cargo menos pagos registrados aquí"**. Los $20,000 que el cliente ya había
abonado en Compaq no existen como pago dentro del sistema, así que se pierden.

Ejemplo numérico:
- Importas: cargo $150,000, saldo $130,000. ✓ El saldo se ve bien.
- El cliente abona $10,000. El saldo correcto es $120,000.
- **El sistema deja el saldo en $140,000** (150,000 − 10,000). El saldo SUBIÓ
  $10,000 en lugar de bajar.
- Para que el sistema marque la factura como pagada, el cliente tendría que
  pagar $150,000 completos — pagando dos veces los $20,000 que ya pagó.

Esto le pega a TODA factura importada que traiga abonos previos, que en el
corte real serán muchas. Además el interés de mora que se factura usa ese saldo
inflado, así que también la mora saldría mal.

---

## HALLAZGO 2 — La segunda factura de intereses (FI) cobra de menos, siempre

**INCORRECTO.**

El sistema lleva un acumulado de "intereses ya facturados" para no cobrar doble.
El error: en ese acumulado **mezcla la comisión+FEGA con el interés**, pero al
calcular cuánto falta por cobrar compara contra el interés solo. Resultado: a
partir de la segunda FI, el sistema cree que ya cobró más interés del que cobró.

Ejemplo (factura de $100,000, 16% anual):
- **Día 60 de vencida**, facturas la mora: interés $2,667 + FEGA $3,040 = FI-1
  por **$5,707**. ✓ Correcto.
- **Día 120**, vuelves a facturar: el interés adicional correcto es otros
  $2,667. **El sistema factura $0** — compara el interés total ($5,333) contra
  los $5,707 ya facturados y concluye que no hay nada que cobrar.
- **Día 150**: factura solo $960 en lugar de $1,333.

El faltante acumulado es siempre de $3,040 (exactamente el FEGA): al final del
camino se habrán facturado $6,667 cuando lo correcto son $9,707. Azagro regala
el equivalente al FEGA de cada factura que se factura por etapas.

---

## HALLAZGO 3 — Pago parcial + mora posterior: el interés del resto se calcula mal

**INCORRECTO.** (Es primo del hallazgo 2; se corrigen juntos.)

Cuando hay un pago parcial, la mora futura se calcula sobre el saldo restante —
pero recalculando **todo el periodo desde el vencimiento** como si el saldo
chico hubiera estado pendiente desde el principio, y restando lo ya facturado.

Ejemplo (factura de $100,000 al 16%, vence 1 de marzo):
- 30 de abril (60 días tarde): paga $50,000. Al cobrar, el sistema factura la
  mora al día: interés $2,667 + FEGA $3,040 = $5,707. ✓ Bien.
- 29 de junio (120 días) paga los $50,000 restantes. El interés correcto de
  esos 60 días extra sobre $50,000 es **$1,333**.
- El sistema calcula: $50,000 × 16% × 120/360 = $2,667 en total, ya facturé
  $5,707, **cobro $0**.

El cálculo correcto es por tramos: cada tramo de días con el capital que estaba
vivo en ese tramo. El sistema no guarda tramos; solo un acumulado.

---

## HALLAZGO 4 — La mora arranca en el vencimiento de factura, no en la fecha de mora

**INCORRECTO** (o cuando menos, contradicción interna que hay que resolver).

Los pedidos manejan dos fechas: vencimiento de factura (ej. 120 días) y fecha
de crédito/mora (ej. 150 días — los valores por omisión del sistema son
exactamente 120/150). Las propias pantallas dicen que la segunda es "la mora":
al validar fechas el sistema avisa "la mora no puede ser anterior al
vencimiento de factura".

Pero el motor de intereses **cuenta los días vencidos desde el vencimiento de
factura (día 120), no desde la fecha de mora (día 150)**.

Ejemplo: pedido del 1 de febrero por $100,000, factura vence 1 de junio (120 d),
mora pactada al 1 de julio (150 d). El cliente paga el 1 de julio, puntual
según lo pactado. El sistema le cobra 30 días de interés = **$1,333 que no
debería cobrar** (o sí — ver pregunta de negocio 2).

Síntoma visible: el estado de cuenta ya marca advertencias tipo "con 150 días
exactos debe vencer el …" en cada factura con plazos separados, porque las dos
fechas no cuadran entre sí. Las alertas de vencimiento y la antigüedad de
cartera también usan la fecha de factura, no la de mora.

---

## HALLAZGO 5 — Pagar desde la pantalla de Bancos se salta la mora (y aplica distinto)

**INCORRECTO por inconsistencia: el resultado depende de qué pantalla uses.**

Hay dos caminos para registrar un cobro:
- **Desde Cartera**: aplica el pago, y automáticamente calcula y factura la
  mora al día del pago. ✓
- **Desde Bancos** (movimiento ligado a una factura): aplica el pago **pero no
  factura ninguna mora**. Además, si el importe capturado es mayor al saldo,
  el banco registra el importe completo pero a la factura solo se le aplica el
  saldo — quedan pesos "flotando" en el banco sin dueño.

Mismo cliente, mismo pago, distinto resultado según la pantalla. También noté
que este camino de Bancos no va dentro de una transacción: si algo falla a
media operación (por ejemplo en una transferencia entre cuentas, que son dos
movimientos), puede quedar la mitad registrada.

---

## HALLAZGO 6 — La utilidad por pedido nunca incluye la mora cobrada

**INCORRECTO (es de reporte, no mueve dinero).**

El P&L por pedido tiene un renglón de "mora" que suma las FI ligadas al pedido.
Pero cuando el sistema emite una FI **no la liga al pedido** (no le guarda esa
referencia). Resultado: el renglón de mora del P&L siempre da $0, aunque se
hayan facturado intereses.

---

## HALLAZGO 7 — Pago mayor al saldo: el sobrante desaparece en silencio

**INCOMPLETO.**

Si el cliente deposita $120,000 contra una factura con saldo de $100,000, el
sistema aplica $100,000 y **descarta los $20,000**: no quedan como anticipo, no
quedan como saldo a favor, y el movimiento de banco se registra por $100,000 —
o sea el banco del sistema no va a cuadrar contra el estado de cuenta real del
banco, que recibió $120,000. No existe la figura de anticipo ni de saldo a
favor del cliente.

---

## HALLAZGO 8 — Un pago capturado por error no se puede deshacer

**INCOMPLETO.**

No hay forma de cancelar ni revertir un cobro o pago: no se puede borrar, no
existe el contra-movimiento, y el ajuste manual de bancos solo acepta importes
positivos (no hay "ajuste de salida" para corregir hacia abajo). Si alguien
captura un cobro de $50,000 al cliente equivocado, la única corrección es
entrar a mano a la base de datos. Para un ERP que va a operar cartera real,
falta el "cobro cancelado" con huella en bitácora.

---

## HALLAZGO 9 — Devoluciones: el costo al que regresa la mercancía

**DUDOSO (decisión de negocio, con efecto en números).**

La devolución regresa la mercancía al kardex **al costo promedio de HOY de la
bodega**, no al costo al que salió cuando se entregó (dato que el kardex sí
tiene guardado).

Ejemplo: entregaste 10 tambos cuando el promedio era $1,000 (salieron valiendo
$10,000). Luego compraste caro y el promedio subió a $1,300. El cliente
devuelve los 10 tambos: entran valiendo $13,000. El inventario "ganó" $3,000
que nadie pagó, y la utilidad del pedido queda distorsionada en sentido
contrario.

**Pregunta de negocio:** ¿la devolución debe regresar (a) al costo al que salió
— lo estándar contablemente — o (b) al promedio actual, como está hoy?

---

## HALLAZGO 10 — Devolución cuando la factura ya se cobró: el saldo a favor queda atrapado

**INCOMPLETO.**

- Si la factura sigue abierta, la nota de crédito (NC) baja el saldo correcto. ✓
- Si la factura **ya se pagó**, la NC queda como documento con saldo negativo
  "abierto"… y ahí se queda para siempre: no se puede aplicar a otra factura
  (el sistema la rechaza como "ya saldada"), no hay reembolso, no hay anticipo.

Ejemplo: cliente pagó $100,000, devuelve producto por $30,000. La NC dice que
le debemos $30,000, pero no existe ninguna operación que use ese saldo a favor.
Peor: si alguien liga esa NC a un movimiento en Bancos, el recálculo de saldo
la deja en $0 y la marca "pagada" — el saldo a favor se esfuma.

**Pregunta de negocio:** ¿ese saldo a favor se aplica a otras facturas del
cliente, se devuelve en efectivo, o ambas? Hoy no hay ninguna de las dos.

---

## HALLAZGO 11 — Devolución e intereses ya devengados

**DUDOSO.**

La devolución no toca la mora: si ya se facturaron intereses (FI) sobre el
capital completo y luego el cliente devuelve la mitad del producto, la FI se
queda como está. Y en el estado de cuenta, el interés informativo se sigue
calculando **sobre el cargo original completo**, como si la devolución no
hubiera existido (la NC es un documento aparte).

**Pregunta de negocio:** cuando hay devolución, ¿los intereses ya facturados se
respetan (el cliente tuvo el producto y el dinero ese tiempo) o se ajustan en
proporción a lo devuelto? ¿Y el interés futuro debe correr sobre el cargo
original o sobre el cargo neto de devoluciones?

---

## HALLAZGO 12 — ¿El interés corre sobre el CARGO o sobre el SALDO? El sistema usa los dos

**DUDOSO (y es la decisión más importante de cartera).**

- El **estado de cuenta** (la pantalla y el papel) calcula el interés sobre el
  **cargo original**, igual que el Excel de Grupo SL. Tras un abono parcial,
  sigue mostrando interés sobre el total.
- La **FI que realmente se factura** calcula sobre el **saldo pendiente**.

Ejemplo: factura de $100,000, abonó $60,000, lleva 90 días vencida.
- Pantalla: interés mostrado = $100,000 × 16% × 90/360 = **$4,000**.
- FI que se facturaría = $40,000 × 16% × 90/360 = **$1,600** (menos lo ya
  facturado).

El cliente ve un número y se le cobra otro. Lo mismo pasa con el FEGA: la regla
dice "3.04% sobre el cargo una sola vez", pero si la primera FI se emite después
de un abono, el FEGA sale sobre el saldo: $40,000 × 3.04% = $1,216 en lugar de
$3,040.

**Pregunta de negocio:** ¿cuál es la regla, cargo (como el Excel) o saldo (más
"justo" con quien abona)? Se decide una y las dos vistas deben usar la misma.

---

## HALLAZGO 13 — Dólares: nadie captura el tipo de cambio del pago

**INCOMPLETO.**

La "utilidad cambiaria" (columna clave del Excel: importe USD × (TC pactado −
TC pagado)) está programada… pero **ninguna pantalla guarda el tipo de cambio
al que se pagó**. Al cobrar no se pregunta el TC. Resultado: la utilidad
cambiaria siempre va a salir $0 en todo lo que se opere dentro del sistema.

Además el importador de corte no trae columnas de TC pactado ni importe USD,
así que las facturas en dólares importadas tampoco podrán calcularla.

---

## HALLAZGO 14 — Dólares: no está definido en qué moneda se capturan los precios

**DUDOSO (aclararlo antes de la primera venta en USD).**

En un pedido en USD, el sistema guarda el total tal cual se capturó y **deriva
el importe en dólares dividiendo entre el tipo de cambio**. Eso solo cuadra si
los precios se capturan EN PESOS. Si el vendedor captura 500 (dólares) por
tambo, la factura queda como $500 pesos y 27.7 dólares — todo mal por un factor
de 18.

Nada en la pantalla lo valida ni lo aclara. **Pregunta de negocio:** ¿los
precios de cotizaciones y pedidos en USD se capturan en dólares o en pesos? Lo
natural para el vendedor es en dólares; el sistema hoy asume pesos.

---

## HALLAZGO 15 — Cancelaciones: no existe ninguna

**INCOMPLETO (en parte es decisión sana, pero faltan piezas).**

Revisé pedido entregado, OC recibida y factura cobrada:

- **No hay "cancelar" para nada**: ni pedidos, ni OC, ni facturas, ni pagos.
  La filosofía de "lo hecho, hecho está, se corrige con contra-movimiento" es
  correcta para un ERP… pero los contra-movimientos no existen todos:
- **Devolución a proveedor: no existe.** Si recibiste una OC equivocada, puedes
  sacar la mercancía con un ajuste manual (que sale al costo promedio, no al de
  la OC), pero la factura por pagar al proveedor **se queda viva** y no hay NC
  de proveedor. CxP queda inflada sin remedio.
- **Una OC capturada por error genera deuda inmediata** (ver hallazgo 16) y no
  hay forma de matarla: se queda "confirmada" por siempre con su factura por
  pagar abierta.
- **Pagos: sin reversa** (hallazgo 8).
- Lo único que se borra de verdad es una solicitud sin cotización (con
  confirmación y bitácora). Eso está bien.

---

## HALLAZGO 16 — La deuda con el proveedor nace al capturar la OC, no al recibir

**DUDOSO.**

Al crear una orden de compra, el sistema genera **en ese momento** la factura
por pagar (FP), con plazo contado desde hoy — aunque la mercancía llegue en un
mes o no llegue nunca. Consecuencias:

- CxP muestra deuda por mercancía que no ha llegado.
- El plazo del proveedor corre desde la captura, no desde la recepción o la
  fecha de su factura real.
- Si la OC se capturó por error, la deuda fantasma no se puede borrar (h. 15).

**Pregunta de negocio:** ¿la FP debe nacer (a) al recibir la mercancía, (b) al
capturar la factura real del proveedor, o (c) al crear la OC como está hoy?
(Para brokeraje/directo, donde no hay recepción en bodega, la respuesta puede
ser distinta.)

---

## HALLAZGO 17 — Recepciones: siempre completas y siempre al precio de la OC

**INCOMPLETO.**

- **No hay recepción parcial**: "Recibir" recibe todo lo pendiente de la OC de
  un golpe. Si el proveedor manda 20 de 50 tambos, no se puede registrar.
- **No se puede recibir a un costo distinto al de la OC**: si el precio real
  cambió (flete, descuento, factura del proveedor diferente), el kardex entra
  al precio de la OC y no hay dónde corregirlo.
- Lo mismo con la entrega a cliente: **no hay entrega parcial**; se entrega
  todo el pedido o nada.

Puede que operar así sea aceptable al arranque (todo o nada), pero con
fertilizante a granel y embarques parciales va a doler pronto.

---

## HALLAZGO 18 — Ajuste de inventario de entrada: no se puede indicar el costo

**DUDOSO (menor).**

Un ajuste positivo (encontraste 5 tambos en el conteo) entra al costo promedio
actual de la bodega; no hay campo de costo. Es neutro para el promedio, pero si
el promedio está mal o la bodega está en ceros, el costo que toma puede no ser
el real. **Pregunta:** ¿el ajuste de entrada debe pedir costo (opcional)?
Relacionado: ¿el flete debe capitalizarse al costo promedio del producto? Hoy el
flete vive en la cotización y en gastos, nunca en el kardex.

---

## HALLAZGO 19 — Cartera, casos de tiempo

Verifiqué los escenarios que pediste:

- **Pago después de vencida**: interés por los días exactos vencimiento→pago. ✓
- **Pago antes de vencer**: el estado de cuenta muestra el interés negativo
  (pronto pago) como el Excel. ✓ Pero es **solo informativo**: nunca se
  convierte en descuento real ni NC. **DUDOSO — pregunta de negocio:** ¿el
  pronto pago se bonifica de verdad (NC o descuento al cobrar) o solo se
  informa? Hoy solo se informa.
- **Cambio de TIIE a mitad del periodo**: la regla es "TIIE vigente en la fecha
  de vencimiento", congelada para toda la vida de la factura. Una TIIE nueva a
  mitad del periodo de mora NO parte el cálculo en dos tramos. Así es el Excel,
  así está el código: **consistente**. ✓ Solo ten claro que si capturas una
  tasa con fecha anterior al vencimiento de una factura viva, el interés de esa
  factura cambia retroactivamente en pantalla; y si ya se facturó mora de más,
  no hay FI negativa que la corrija (**INCOMPLETO menor** — igual que un pago
  con fecha retroactiva tras una FI ya emitida: el exceso no se devuelve solo).

---

## HALLAZGO 20 — Otros casos raros que encontré (punto 6)

1. **Si la mora falla al cobrar, se pierde en silencio.** Al registrar un cobro,
   la FI automática va envuelta en un "si falla, ignóralo": el cobro pasa y la
   mora no se factura, sin aviso a nadie. INCOMPLETO menor.
2. **Pedido con el mismo producto en dos renglones**: la devolución solo
   encuentra el primer renglón; el tope de "no devolver más de lo entregado" se
   revisa contra ese renglón nada más. INCOMPLETO menor (hoy la captura normal
   no duplica productos, pero nada lo impide).
3. **Folios con huecos**: los folios se generan contando documentos (FV cuenta
   también NC y FI), así que la serie FV va a saltar números (FV-0007 y luego
   FV-0010). No se pierde nada, pero si esperan folios corridos para auditoría,
   sorprenderá. Y dos capturas en el mismo instante podrían repetir folio (no
   hay candado de unicidad del nombre). COSMÉTICO/menor.
4. **La devolución se disfraza de cobro**: para bajar el saldo de la factura,
   la NC se aplica generando un "pago" PAG-xxxx (sin banco). En el estado de
   cuenta aparece en la lista de pagos como si hubiera entrado dinero. No
   descuadra el banco, pero al conciliar contra estados de cuenta bancarios
   puede confundir. DUDOSO/cosmético.
5. **El P&L por pedido ignora las devoluciones**: la utilidad se calcula con
   las cantidades originales del pedido, devuelto o no. Tras una devolución
   grande el margen mostrado es ficticio. INCOMPLETO.
6. **La primera pantalla de inventario "repara" diferencias sola**: si las
   existencias y el kardex no cuadran, al abrir Inventario se generan
   movimientos de saldo inicial automáticos a nombre de quien abrió la
   pantalla. Con datos limpios no pasa nada; solo saber que existe. Menor.
7. **El banco no valida moneda**: puedes cobrar una factura en USD a un banco
   en pesos y viceversa; el importe se registra igual, sin conversión. Ligado a
   los hallazgos 13/14. INCOMPLETO.

---

## Resumen ejecutivo

| # | Hallazgo | Clase | ¿Urge antes de datos reales? |
|---|---|---|---|
| 1 | Abono a factura importada borra el abono previo de Compaq | INCORRECTO | **Sí — bloquea el corte** |
| 2 | Segunda FI cobra de menos (FEGA contamina el acumulado) | INCORRECTO | Sí |
| 3 | Pago parcial + FI posterior: interés del resto mal (sin tramos) | INCORRECTO | Sí |
| 4 | Mora corre desde vencimiento de factura, no desde fecha de mora | INCORRECTO | Sí |
| 5 | Cobrar desde Bancos se salta la mora y aplica distinto | INCORRECTO | Sí |
| 6 | P&L por pedido: renglón de mora siempre $0 | INCORRECTO | No (reporte) |
| 7 | Pago mayor al saldo: sobrante desaparece; no hay anticipos | INCOMPLETO | Sí |
| 8 | No hay forma de revertir un pago erróneo | INCOMPLETO | Sí |
| 9 | Devolución regresa al promedio de hoy, no al costo que salió | DUDOSO | Decidir |
| 10 | NC de factura pagada: saldo a favor atrapado | INCOMPLETO | Decidir + hacer |
| 11 | Devolución no ajusta mora ya facturada ni el capital del interés | DUDOSO | Decidir |
| 12 | Interés sobre cargo (pantalla) vs sobre saldo (FI): dos reglas | DUDOSO | **Decidir ya** |
| 13 | Nadie captura TC del pago: ut. cambiaria siempre $0 | INCOMPLETO | Sí (si operan USD) |
| 14 | Moneda de captura de precios USD sin definir ni validar | DUDOSO | **Decidir ya** |
| 15 | Sin cancelaciones ni devolución a proveedor / NC de proveedor | INCOMPLETO | Sí |
| 16 | FP nace al capturar la OC, no al recibir | DUDOSO | Decidir |
| 17 | Sin recepciones ni entregas parciales; sin costo real en recepción | INCOMPLETO | Pronto |
| 18 | Ajuste de entrada sin costo; flete nunca al kardex | DUDOSO | Decidir |
| 19 | Pronto pago solo informativo; FI sin corrección retroactiva | DUDOSO/menor | Decidir |
| 20 | Varios menores (FI silenciosa, folios con huecos, P&L vs devoluciones…) | mixto | Después |

---

## Las preguntas de negocio que hay que decidir (los DUDOSOS, en corto)

1. **¿El interés de mora se calcula sobre el cargo original (como tu Excel) o
   sobre el saldo pendiente?** Hoy la pantalla dice una cosa y la factura FI
   hace otra. Esta decisión arrastra también al FEGA (¿3.04% sobre cargo aunque
   haya abonos?). *(Hallazgo 12)*
2. **¿Desde qué fecha corre la mora cuando factura y mora tienen plazos
   distintos (120/150)?** ¿Desde el vencimiento de factura o desde la fecha de
   crédito/mora pactada? *(Hallazgo 4 — según la respuesta es bug o es regla.)*
3. **Devoluciones:** ¿regresan al costo al que salieron o al promedio actual?
   ¿La mora ya facturada se ajusta? ¿El saldo a favor de una NC se aplica a
   otras facturas, se reembolsa, o ambas? *(Hallazgos 9, 10, 11)*
4. **Dólares:** ¿los precios en pedidos USD se capturan en dólares o en pesos?
   ¿Al cobrar una factura USD se pregunta el tipo de cambio del pago para la
   utilidad cambiaria? *(Hallazgos 13, 14)*
5. **¿Qué pasa con un pago mayor al saldo?** ¿Anticipo/saldo a favor del
   cliente, aplicar a su factura más vieja, o rechazarlo? Y cuando un cliente
   manda un solo depósito para varias facturas, ¿el orden lo decide la persona
   (como hoy, factura por factura) o el sistema (la más vieja primero)?
   *(Hallazgo 7)*
6. **¿Cuándo nace la deuda con el proveedor?** ¿Al capturar la OC (hoy), al
   recibir, o al capturar la factura real del proveedor? *(Hallazgo 16)*
7. **¿El pronto pago se bonifica de verdad o solo se informa?** *(Hallazgo 19)*
8. **¿El ajuste de inventario de entrada debe pedir costo? ¿El flete se mete al
   costo promedio o se queda como gasto?** *(Hallazgo 18)*

Con las respuestas a 1–4 se pueden corregir los INCORRECTOS 1–5 de una sola
pasada y sin retrabajos. El hallazgo 1 (abonos de Compaq) no depende de ninguna
decisión: es corrección directa y conviene hacerla antes de importar el corte.
