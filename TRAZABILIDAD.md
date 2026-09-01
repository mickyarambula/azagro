# Auditoría de trazabilidad y bitácora — Azagro ERP

> **Estado (1 de septiembre de 2026):** corregidos los 2 CRÍTICOS y los
> IMPORTANTES 2, 3, 5, 7, 8, 9, 10 y 14: toda edición de pedido (incluidos los
> confirmados) queda con anterior → nuevo; cada FI guarda su cálculo completo
> (TIIE, spread, días, capital, FEGA) con autor y desglose; la FV congela sus
> parámetros al emitirse y el P&L usa esa foto; la bitácora tiene filtros por
> folio/texto, tipo, usuario y fechas, con paginación; el ciclo comercial
> completo deja huella (solicitud, margen, proveedor ganador, cotización y su
> renegociación con precios anteriores, pedido, OC); límite de crédito,
> costo/precio de producto y saldo inicial de banco quedan con anterior →
> nuevo; los rechazos (permiso, límite de crédito, importaciones fallidas) se
> registran; el estado de cuenta a fecha pasada reconstruye el estado real de
> ese día; y todas las facturas llevan autor. También cerrados los MENORES 12
> (el borrado de solicitudes escribe el contenido completo en bitácora), 13
> (folios con candado de unicidad, migración 0015) y 15 (recordatorios de
> cobro registrados). Decisión de negocio aplicada: tras confirmar un pedido,
> cliente y moneda quedan fijos; precios y fechas editables con rastro.
> Pruebas en `scripts/erp-trazabilidad.test.mjs`. Quedan los MENORES 11 (la
> TIIE sobreescribible — mitigado: cada FI ya guarda la suya) y 16
> (movimientos de banco sueltos fuera de la vista de bitácora), y el hallazgo
> 5 queda mitigado (la utilidad de facturas emitidas ya no cambia con
> Ajustes; solo el costo de catálogo sigue vivo cuando no hay OC ligada).

Fecha: 31 de agosto de 2026. Solo diagnóstico; no se cambió nada de código.
La prueba aplicada: **¿puedo pararme en cualquier folio dentro de dos años y
reconstruir su historia completa sin adivinar?**

Clasificación: **CRÍTICO** = no puedo defender un número · **IMPORTANTE** = se
reconstruye pero con trabajo manual · **MENOR** = incomodidad, no riesgo.

Respuesta corta: **los documentos y los pagos aguantan bien la prueba; los
cálculos de interés y las ediciones previas a la entrega, no.** El kardex, los
pagos y los movimientos de banco son inmutables y firmados. Pero una FI de
intereses no guarda con qué TIIE ni cuántos días se calculó, y un pedido se
puede editar ya confirmado sin dejar rastro — esos dos son los agujeros que un
auditor encontraría primero.

---

## 1. Rastro por folio: el ciclo completo de un pedido

Seguí el ciclo SOL → COT → PV → entrega → FV → cobro. Lo que queda y lo que no:

| Paso | ¿Quién y cuándo? | ¿Valores? | Veredicto |
|---|---|---|---|
| Crear solicitud (SOL) | ✗ nada | ✗ | Sin rastro |
| Poner margen, elegir proveedor ganador en la SOL | ✗ nada | ✗ | **Sin rastro** |
| Crear cotización (COT) | ✗ (guarda "owner" pero no bitácora) | ✗ | Sin rastro |
| **Renegociar cotización** | ✗ | **Los precios anteriores se SOBREESCRIBEN**; solo sube un contador de revisión | **Se pierde la historia** |
| Decidir cotización (aceptar/rechazar) | ✓ bitácora | ✓ decisión y pedido generado | Bien |
| Crear / **editar pedido (PV)** | ✗ nada | ✗ — y un pedido **ya confirmado se puede volver a editar** (precios, cliente, fechas) sin que quede nada | **El peor del ciclo** |
| Autorizar exceder límite de crédito | ✓ | ✓ límite, saldo y monto a la vista | Bien |
| Crear orden de compra (OC) | ✗ nada — y además **nace la factura por pagar FP en silencio** | ✗ | Sin rastro |
| Recibir OC | ✓ bitácora + kardex inmutable con autor, cantidad y costo | ✓ | Muy bien |
| Entregar pedido | ✓ bitácora con el folio de la FV generada | ✓ | Muy bien |
| Devolución | ✓ bitácora con NC y movimientos de kardex | ✓ | Muy bien |
| Cobro / pago | ✓ bitácora + fila de pago inmutable (autor, fecha, banco) | ✓ importe y banco | Bien |
| Pronto pago aplicado | ✓ bitácora | ✓ **fórmula completa** (día, tasa, días bonificados, monto) | Excelente |
| Diferencial de TC (utilidad o ajuste) | ✓ bitácora | ✓ cálculo completo (USD × TCs) y decisión | Excelente |
| FI de mora emitida **al cobrar** | ✗ la FI aparece sin entrada propia en bitácora | ✗ insumos no guardados | Ver punto 2 |

**Hallazgo 1 (CRÍTICO): un pedido confirmado se puede editar sin rastro.**
Ejemplo: PV-0012 se confirma con precio $6,800/tambo; antes de entregar,
alguien lo cambia a $6,200 y entrega. La FV sale por el precio nuevo y no
existe registro de que hubo otro precio ni de quién lo cambió. En dos años es
imposible saber si la diferencia fue negociación o error o algo peor.

**Hallazgo 2 (IMPORTANTE): la mitad "comercial" del ciclo (solicitud, margen,
cotización, creación del pedido y de la OC) no deja huella.** La mitad
"física y de dinero" (kardex, entregas, cobros) sí, y bien.

**Hallazgo 3 (IMPORTANTE): renegociar una cotización borra los precios
anteriores.** El Excel guardaba cada versión; aquí solo queda el número de
revisión, no lo que decía la revisión 1.

---

## 2. Cálculos de dinero: ¿se guardan los insumos o solo el resultado?

Cada documento nuevo (FV) sí guarda su "foto" de condiciones: plazos, TC
pactado, política. Eso está bien. El problema son los cálculos posteriores:

**Hallazgo 4 (CRÍTICO): la FI de intereses solo guarda el resultado.**
Una FI dice "FI-0009, $5,706.67, Mora FV-0003" — pero NO guarda la TIIE usada,
los días contados, la tasa ni el capital base. Esa fórmula se muestra en
pantalla al momento y se pierde. Consecuencias concretas:
- La tabla de TIIE es editable: si mañana corriges la TIIE de un mes (el
  sistema deja sobreescribir la tasa de una fecha ya capturada), el interés
  que HOY recalcules para explicar la FI vieja **ya no cuadra con lo
  facturado**, y la única pista del valor anterior es una línea de bitácora
  ("tiie 2026-05-01: 0.086 → 0.0855").
- Si cambias el spread de 9% a 8.5% en Ajustes, las FI viejas siguen bien
  (ya están emitidas), pero explicar cómo salieron exige reconstruir a mano
  qué parámetro regía ese día caminando la bitácora de "parametros".
En contraste, el pronto pago y los ajustes de TC **sí** guardan la fórmula
completa en bitácora — ese es el estándar que le falta a la FI.

**Hallazgo 5 (IMPORTANTE): la utilidad (comisión, Capa 1, Capa 2) se calcula
en vivo cada vez y nunca se congela.** El P&L de un pedido usa la TIIE de la
tabla, los parámetros de Ajustes y el costo de la OC **de hoy**. Si algo de
eso cambia, la utilidad del pedido viejo cambia retroactivamente en pantalla.
Es un reporte, no un documento — pero si con ese número se toman decisiones o
se reparte algo, no es defendible en el tiempo. El Excel congelaba esto por
naturaleza (cada archivo era una foto).

**Hallazgo 6 (MENOR): la FI emitida automáticamente al cobrar no tiene
entrada propia en bitácora.** El cobro sí se registra ("Cobro FV-0003,
$100,000, BBVA") y la FI existe como documento ligado al pedido, pero la
emisión de la FI en sí (quién, con qué cálculo) hay que inferirla por la hora
del cobro. Las FI emitidas con el botón de mora sí quedan en bitácora, aunque
solo con el monto ("Cargo 5706.67"), sin fórmula.

---

## 3. Decisiones humanas

Las decisiones **nuevas de esta semana quedaron bien cubiertas** — cada una
registra quién, qué eligió y con qué números:
- Autorizar exceder límite: ✓ límite, saldo y pedido a la vista.
- Diferencial de TC: ✓ decisión (utilidad vs. ajuste) + cálculo + documento.
- Pronto pago: ✓ fórmula completa y monto perdonado.
- Cambios de parámetros y de permisos de usuarios: ✓ anterior → nuevo.
- Ajuste de inventario: ✓ bitácora + movimiento de kardex con cantidad, costo
  y autor (aunque la nota del "por qué" es opcional — se puede dejar vacía).

**Hallazgo 7 (IMPORTANTE): faltan tres decisiones sensibles sin rastro:**
- **Cambiar el límite de crédito o la tasa de un cliente** (guardar cliente no
  deja bitácora). Alguien puede subirle el límite a un cliente, venderle, y
  regresarlo — sin huella.
- **Cambiar costo o precio de lista de un producto** a mano.
- **Cambiar el saldo inicial de un banco** (se sobreescribe sin registro).
Las tres mueven dinero o crédito y hoy son invisibles.

---

## 4. Lo que NO pasó (intentos y rechazos)

**Hallazgo 8 (IMPORTANTE): no se registra ningún intento fallido.** Verifiqué
los tres casos del enunciado:
- Alguien sin permiso intenta cobrar → el sistema lo rechaza correctamente,
  pero el rechazo no queda en ningún lado. Si un empleado prueba la puerta
  50 veces, nadie se entera.
- Un pedido rebota por límite de crédito → sin registro (solo queda huella si
  un admin lo AUTORIZA; el rechazo no).
- Una importación de corte que truena a la mitad → se revierte completa (eso
  está bien) pero no queda constancia de que se intentó y falló.
La bitácora registra hechos consumados, nunca intentos. Para seguridad
(detectar a alguien probando permisos) esto es una ceguera real.

---

## 5. La bitácora como herramienta de investigación

**Hallazgo 9 (IMPORTANTE): es una lista, no una herramienta.** Hoy la
pantalla muestra las **últimas 200 filas** y ya:
- No se puede filtrar por folio, ni por usuario, ni por fecha, ni por tipo.
- No hay búsqueda ni exportación.
- Con la operación real, 200 filas serán una semana o menos: lo anterior
  sigue guardado en la base pero **es inalcanzable desde la pantalla**.
- El diccionario de acciones de la pantalla está incompleto: los eventos
  nuevos (pronto-pago, ajuste-tc, parametros, autorizar-credito, tiie…) se
  muestran con su clave interna en vez de un nombre legible.
Para "reconstruir la historia del folio FV-0003" hoy tendrías que pedirle a
alguien técnico que consulte la base directamente.

---

## 6. Integridad: ¿se puede borrar o alterar el rastro?

Lo bueno — y es bastante:
- **No existe ninguna función para editar o borrar la bitácora.** Solo se
  escribe y se lee.
- **Kardex inmutable de verdad**: los movimientos de inventario no tienen
  función de edición ni borrado; se corrigen con contra-movimientos. Igual
  los pagos, sus aplicaciones y los movimientos de banco.
- Todo movimiento de kardex, pago, gasto y movimiento de banco lleva autor.

Lo mejorable:
- **Hallazgo 10 (IMPORTANTE): las facturas no llevan autor.** La fila de la
  factura (FV, FP, NC, FI, ATC) no guarda quién la generó; se infiere por la
  bitácora del evento que la creó — y en los casos del punto 1 donde ese
  evento no se registra (FP nacida de una OC), no hay de dónde inferir.
- **Hallazgo 11 (MENOR): la tabla de TIIE se sobreescribe.** Capturar de
  nuevo la tasa de una fecha reemplaza la anterior; el valor viejo solo
  sobrevive en la línea de bitácora. Combinado con el hallazgo 4 es lo que
  vuelve indefendible una FI vieja.
- **Hallazgo 12 (MENOR): el único borrado duro** (solicitudes sin cotización)
  queda en bitácora solo con el folio; el contenido borrado (productos,
  cantidades, márgenes) desaparece por completo.
- **Hallazgo 13 (MENOR): los folios se generan contando documentos**, sin
  candado de unicidad en el nombre: dos capturas en el mismo instante podrían
  producir dos "FV-0007". Improbable, pero un folio duplicado es veneno puro
  para una auditoría.

---

## 7. Reconstrucción a una fecha pasada

**Hallazgo 14 (IMPORTANTE): el estado de cuenta "a una fecha" es mitad
verdad.** El estado de cuenta vivo acepta una fecha de corte y con ella
recalcula bien los días y el interés **a esa fecha**. Pero los saldos y
abonos que muestra son **los de hoy**: si pides "el estado de cuenta al 31 de
marzo" y el cliente pagó en abril, la pantalla muestra la factura ya saldada
con interés calculado a marzo — un híbrido que no existió nunca.
- Sí es reconstruible a mano: cada pago tiene fecha, así que se puede filtrar
  qué había pasado al 31 de marzo — pero es trabajo manual, no un botón.
- Atenuante: la pantalla de estados de cuenta permite **guardar el documento
  generado** (foto del papel enviado al cliente). Si se usa con disciplina
  cada corte, esas fotos son la defensa real. Hoy depende de que alguien se
  acuerde de guardarlo.

---

## 8. Otros huecos detectados

- **Hallazgo 15 (MENOR): los recordatorios de pago por correo no quedan en
  bitácora.** El correo libre sí se registra (a quién y asunto); los
  recordatorios de factura y los envíos masivos a clientes, no. Si un cliente
  dice "nunca me cobraron", no puedes probar que se le mandaron 5 recordatorios.
- **Hallazgo 16 (MENOR): los movimientos de banco "sueltos" (ajustes,
  transferencias) no pasan por bitácora** — la fila del movimiento lleva
  autor y fecha (suficiente como registro), pero no aparecen en la vista de
  bitácora junto con todo lo demás, así que la película del día queda
  repartida en dos pantallas.
- Lo que **sí** amarra bien: FV↔pedido (order_id), FI↔pedido y FI↔factura
  origen ("Mora FV-x"), ATC↔factura origen ("Ajuste TC FV-x"), NC↔pedido,
  pago↔factura↔movimiento de banco (ligas por id), y las facturas importadas
  con su llave de corte y su abono previo. El expediente por folio existe y
  navega bien la cadena documental.

---

## Resumen ejecutivo

| # | Hallazgo | Clase |
|---|---|---|
| 1 | Pedido confirmado editable (precios, cliente) sin ningún rastro | **CRÍTICO** |
| 4 | La FI de intereses no guarda TIIE, días, tasa ni capital del cálculo | **CRÍTICO** |
| 2 | Ciclo comercial (SOL, margen, COT, crear PV, crear OC) sin bitácora | IMPORTANTE |
| 3 | Renegociar cotización sobreescribe los precios anteriores | IMPORTANTE |
| 5 | La utilidad se recalcula en vivo; cambia retroactivamente | IMPORTANTE |
| 7 | Límite de crédito, costo/precio de producto y saldo inicial de banco cambian sin rastro | IMPORTANTE |
| 8 | Ningún intento fallido ni rechazo queda registrado | IMPORTANTE |
| 9 | Bitácora sin filtros, sin búsqueda, tope de 200 filas | IMPORTANTE |
| 10 | Las facturas no llevan autor | IMPORTANTE |
| 14 | Estado de cuenta a fecha pasada mezcla saldos de hoy con intereses de ayer | IMPORTANTE |
| 6 | FI automática al cobrar sin entrada propia en bitácora | MENOR |
| 11 | TIIE sobreescribible (el valor viejo solo vive en bitácora) | MENOR |
| 12 | Borrado duro de solicitudes pierde el contenido | MENOR |
| 13 | Folios por conteo, sin candado de unicidad | MENOR |
| 15 | Recordatorios de cobro sin registro | MENOR |
| 16 | Movimientos de banco sueltos fuera de la vista de bitácora | MENOR |

**El orden que sugeriría** (cuando decidas corregir; hoy no toqué nada):
1. Los dos CRÍTICOS: congelar el pedido al confirmar (o registrar cada
   edición con antes → después) y hacer que cada FI guarde su fórmula
   completa (TIIE, días, tasa, capital) como ya lo hacen el pronto pago y los
   ajustes de TC.
2. Bitácora útil: filtros por folio/usuario/fecha/acción y quitar el tope.
3. Completar los eventos faltantes (crear/editar documentos, límites de
   crédito, saldos iniciales, rechazos e intentos fallidos).
4. El estado de cuenta histórico fiel (filtrar pagos a la fecha de corte) —
   con eso el punto 7 pasa de "trabajo manual" a "un botón".
