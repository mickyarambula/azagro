# ESTADO.md — Alineación de documentos y código

Fecha: 5 de septiembre de 2026. Sesión de diagnóstico y documentación: **no se
cambió lógica de negocio, ni kardex, ni fórmulas.** Todo lo que aquí se afirma
del código está citado con archivo y línea al estado de `main` de hoy
(`24101eb` + este documento).

Orden de lectura para quien continúe: `CLAUDE.md` → `DISENO_FINANCIAMIENTO.md`
→ este archivo → `DECISIONES.md` → `HANDOFF.md`.

> **Actualizado el 5-sep-2026 (tarde), con tres decisiones del dueño el mismo
> día** (`DECISIONES.md`, mismas fechas): (1) la tabla de tasas lleva dos
> columnas — tasa de costo y tasa de cobro — captura directa, sin colchón
> calculado aparte; sustituye el § 6 de DISENO y cierra E2. (2) La moneda y el
> TC pertenecen a la operación, no al cliente; cierra la parte de modelo de
> L4a. (3) **El circuito de doble facturación (ASR) NO está abandonado**: es
> un circuito elegible, fuera de uso por ahora; el lineal es el nuevo
> predeterminado, no el reemplazo. Esto corrige el veredicto de § 1.1 de esta
> misma versión anterior (decía "Vigente: DISENO, el viejo se abandona") y
> cierra D-A y H8b. Los cambios están marcados en el texto donde aplican.

Lo que dice cada documento, en una línea:

- `DISENO_FINANCIAMIENTO.md` (5-sep, corregido el mismo día): el **nuevo
  predeterminado** de financiamiento: circuito lineal, Azagro factura a Santa
  Rosa con su margen, Santa Rosa agrega el financiamiento y factura al
  cliente. No reemplaza al circuito de doble facturación (ASR), que sigue
  elegible. Borrador; quedan D-B y D-C abiertas (D-A se cerró el 5-sep).
- `HANDOFF.md` (3–4 sep): bitácora de todo lo construido y las decisiones
  confirmadas; describía el circuito **viejo** (doble facturación). Desde hoy lo
  marca como histórico y remite al diseño.
- `CLAUDE.md`: reglas para no romper nada; desde hoy exige leer el diseño y este
  archivo antes de tocar financiamiento, precio o cartera.
- `LOGICA.md` (30-ago): auditoría con 20 hallazgos y 8 preguntas de negocio.
- `EXCEL_VS_SISTEMA.md` (31-ago): el Excel real contra el sistema; resolvió dos
  preguntas de LOGICA y dejó el "colchón" de la TIIE.
- `TRAZABILIDAD.md`, `AUDITORIA.md`, `SEGURIDAD.md`: auditorías cerradas en su
  mayoría; lo que sigue abierto está en su encabezado.

---

## 1. Contradicciones entre documentos

Cada punto: qué dice uno, qué dice otro, y cuál queda vigente. Empieza por el
circuito.

### 1.1 El circuito con Santa Rosa: doble facturación vs lineal

**HANDOFF.md** (§ "El circuito con la empresa hermana (ASR)", líneas 553-567):

> Azagro le factura a la hermana (costo + 1% de comisión), la hermana adelanta
> el dinero, y luego le refactura a Azagro el costo más el interés del plazo
> (TIIE del mes + 4% de spread). […] No se construyó el circuito documental […]
> El dueño está por cambiar ese esquema.

**EXCEL_VS_SISTEMA.md** (§ 9.1) lo describe igual y lo marca "NO EXISTE":
"la factura de Azagro a la hermana (costo + 1%), el pago de la hermana a
Azagro, y la refactura de la hermana a Azagro (costo + TIIE+4% × 150/360)".

**DISENO_FINANCIAMIENTO.md** (§ 1):

> El esquema anterior (circuito con doble facturación) se abandonó porque
> inflaba los ingresos de Azagro y pegaba fiscalmente. El esquema nuevo es
> lineal.

y § 5: "Azagro factura a Santa Rosa 106,951.87 (margen 6,951.87) · Santa Rosa
agrega el costo financiero 6,043.00 · Santa Rosa factura al cliente
112,994.88".

**Corregido el 5-sep-2026 (tarde): no es "vigente uno, se abandona el otro".**
Son **dos circuitos que conviven** (decisión del dueño, `DECISIONES.md`
5-sep-2026): doble facturación sigue siendo el que ha operado todo hasta hoy y
sigue elegible; el lineal es el **nuevo predeterminado** para operaciones
nuevas, no su reemplazo. Los dos parámetros que alimentan el precio hoy
—comisión ASR 1% y spread ASR 4%— (`src/lib/erp/pricing.ts:57-77`,
`src/lib/erp/credit.ts:487-503`) siguen siendo exactamente los del circuito de
doble facturación: dejan de ser globales y pasan a ser **parámetros de ese
circuito** (cierra 1.4 y D-A, ver § 2).

### 1.2 Quién le factura al cliente

**CLAUDE.md** (No romper, punto 3): "**Compaq sigue timbrando.** No inventar
PAC/CFDI ahora." **HANDOFF.md** (§ "Qué es"): "Compaq sigue timbrando".

**DISENO** (§ 3, tabla de circuitos): en "Línea Santa Rosa", quien factura al
cliente es **Santa Rosa**; en "Contado", Azagro. § 9.4: "si Santa Rosa factura,
el cliente legalmente le debe a Santa Rosa. El documento que se le mande al
cliente no puede decir que le debe a Azagro."

**Resuelto por circuito (revisado 5-sep-2026 con el catálogo de cuatro
circuitos).** "Compaq sigue timbrando" es cierto en **tres** de los cuatro:
contado, doble facturación (ASR) y línea propia — en los tres factura Azagro,
porque en doble facturación el financiamiento de Santa Rosa queda escondido
dentro del costo, invisible para el cliente (así se ha operado siempre). Solo
en **línea Santa Rosa (lineal)** factura Santa Rosa directo. El código de hoy
asume una sola razón social emisora en todos los casos: el estado de cuenta se
imprime con la razón social de Ajustes (`src/routes/statements.tsx:152` y
`:225`, respaldo `"AZ INSUMOS AGRICOLAS SA DE CV"` en `:380`), y la FI la
emite Azagro (`src/lib/erp/ops.ts`, `issueMoraInvoice`) — correcto para tres
circuitos de cuatro, hace falta agregar el caso lineal.

### 1.3 Una tasa de costo vs dos tasas

**HANDOFF.md** (Decisiones, línea ~545): "Todo parametrizable desde Ajustes
[…] spread de costo" — **un** spread. **Ajustes** lo etiqueta así:
`src/routes/settings.tsx:341` "Spread ASR (en precio, TIIE +, fracción)". El
código usa ese único número para el precio (`pricing.ts:57-77` vía
`financeCost`, `credit.ts:487`), para el costo en la utilidad
(`src/lib/erp/reports.ts:80`) y para la bonificación de pronto pago
(`src/lib/erp/ops.ts:1673`, `credit.ts:445`).

**DISENO** (§ 6, ahora sustituida) proponía dos spreads sobre una sola tasa:
real TIIE + 4.00% (costo y reparto de mora) y de cálculo TIIE + 4.15% (precio).

**Resuelto por Decisión 1 del dueño (5-sep-2026, `DECISIONES.md`), sustituye el
§ 6 de DISENO.** No son dos spreads sobre una tasa: la tabla lleva **dos
columnas por renglón**, tasa de costo y tasa de cobro, capturadas las dos
directamente (pueden ser iguales); la protección es la diferencia y se
**calcula**, no se captura. Un solo spread de línea, aplicado a la columna que
corresponda: costo de la línea = tasa de costo + spread de línea;
financiamiento en el precio = tasa de cobro + spread de línea; mora al cliente
= tasa de cobro + spread de mora. **Decidido en documento, no construido**;
cierra E2 (ver § 2).

### 1.4 La comisión del 1% en el precio

**HANDOFF.md** (Fórmulas vigentes, líneas ~636-646): "Financiamiento por
unidad: costo × comisión ASR 1% (una sola vez) + costo × **1.01** × (TIIE +
spread ASR) × días / 360. […] **No quitarlo** — se quitó por error el
1-sep-2026 y se regresó el 2-sep con el Excel a la vista." El código lo repite:
`credit.ts:471` "NO QUITAR EL × (1 + comisión)".

**DISENO** (§ 13.A): "La línea que se usa normalmente no cobra comisiones, pero
el sistema mete 1% en cada precio, herencia del circuito viejo con ASR. Son
unos $1,069 por operación cobrados por un costo que no existe."

**Ya no es una contradicción — se disolvió con la Decisión 3 del dueño
(5-sep-2026).** Los dos documentos tenían razón, cada uno en su circuito:
HANDOFF describe la **doble facturación**, donde el 1 % es un costo real y
"no quitarlo" sigue siendo correcto (Santa Rosa le compraba y le revendía a
Azagro, y necesitaba agregar algo); DISENO describe el circuito **lineal**,
donde la línea no cobra comisión de apertura y ese 1 % no aplica. El 1 % pasa
de constante global a **parámetro del circuito de doble facturación**; en el
lineal su valor es 0 (o ausente). Cierra D-A. El código de hoy lo sigue
cobrando siempre y lo reporta como costo (`reports.ts:239-267`, `commission`
dentro de `finance`) — correcto mientras solo exista el circuito de doble
facturación; falta condicionarlo por circuito cuando se construya el lineal.

### 1.5 Sobre qué se calcula el financiamiento

**HANDOFF.md / CLAUDE.md** (punto 8 de "No romper"): "Precio = (costo puesto +
financiamiento) ÷ (1 − margen %)": el financiamiento se calcula **sobre el
costo puesto** y el margen se aplica después (`pricing.ts:57-77`,
`src/lib/erp/margins.ts:128`).

**DISENO** (§ 5): "El costo financiero se calcula **sobre el precio con
margen** (los 106,951.87), no sobre el costo. Es aritméticamente igual a como
el sistema lo calcula hoy, así que el motor de precios no cambia."

**Revisado el 5-sep-2026 por el punto (f) — NO se disuelve del todo por
circuito, y no lo fuerzo.** Es tentador leerlo como "cada circuito tiene su
propia base" (doble facturación: sobre el costo, como hoy; lineal: sobre
costo + margen, como Santa Rosa desembolsa) y en el fondo así es — pero eso no
quita el problema real: **dentro del circuito lineal**, con margen en
porcentaje las dos fórmulas dan el mismo precio (comprobación 3.a); con margen
en **monto fijo** no, y el motor de hoy (que seguiría usándose tal cual para
ese circuito) cobraría de menos. Sigue abierta la pregunta 4.9. El motor de
hoy también congela el margen y el financiamiento en la partida
(`quote_lines.margin_*`, `finance_unit`), así que "igual" no es solo
aritmética: es qué número se guarda.

### 1.6 Capa 2: sobre qué corre y de quién es la mora

**HANDOFF.md** (Fórmulas): "Capa 2 (costo financiero de los días que el cliente
se pasa del plazo) sí se resta de la utilidad." **EXCEL_VS_SISTEMA.md** (§ 2):
"Capa 2 = **capital de la venta** × (TIIE emisión + 4%) × días excedidos / 360".
Código: `credit.ts:502` (`saleCapital` × tasa × días) y `reports.ts:165`
(`saleCapital: sale`), restada entera en `reports.ts:267`; la mora facturada
entra como ingreso de Azagro al 100% (`reports.ts:267`, `mora`).

**DISENO** (§ 5, cifras corregidas el 5-sep-2026 — ver 1.12): "Costo de la línea
esos 30 días 971.48 a TIIE + 4%" — que sale de **106,951.87** (lo que Santa
Rosa desembolsó: costo + margen), no del precio al cliente — y "Utilidad de la
mora 525.70: Azagro 50%, Santa Rosa 50%. El financiamiento ordinario se queda
íntegro en Santa Rosa."

**Se disuelve por circuito (revisado 5-sep-2026, punto f) — este sí, sin
forzarlo.** La fórmula de EXCEL_VS_SISTEMA § 2, que el código de hoy replica
exactamente, describe el Excel del circuito de **doble facturación** (verificado
línea por línea en `EXCEL_VS_SISTEMA.md` § 2, con el mismo circuito que
HANDOFF documenta): ahí Capa 2 corre sobre el capital de la venta y la mora es
100 % ingreso de Azagro, y eso sigue siendo correcto porque es el circuito con
el que se ha operado. La fórmula de DISENO — sobre lo desembolsado, reparto
50/50 — es específica del circuito **lineal**, que no existe todavía. No hay
contradicción: son dos fórmulas correctas, una por circuito. Falta construir
la del lineal cuando llegue su fase (ver comprobación 3.c).

### 1.7 La bonificación por pronto pago: a qué tasa

**HANDOFF.md** (Decisiones): "a la tasa de **costo** (TIIE del mes de emisión
+ spread de costo)". Código: `credit.ts:445-458` y `ops.ts:1673`
(`costSpread: pol.asrSpread`).

**DISENO** (§ 13.B): "Con dos tasas ahora hay que elegir: a la real (4.00%)
conserva el colchón; a la de cálculo (4.15%) devuelve lo que se cobró."

**Sigue abierta — reformulada con el vocabulario de la Decisión 1
(5-sep-2026).** Ya no hay "tasa real" ni "tasa de cálculo": hay tasa de costo
y tasa de cobro, dos columnas capturadas. La pregunta D-B sigue en pie con las
palabras nuevas: ¿la bonificación usa la tasa de costo o la tasa de cobro? El
dueño no la contestó en esta sesión (anotado también en `DISENO_FINANCIAMIENTO.md`
§ 13.B).

### 1.8 Qué se congela en el documento

**HANDOFF.md** (punto 18): "cada documento trae la política con la que nació y
de ahí salen sus dos interruptores". **DISENO** (§ 2 y § 11): "Una factura no
dice 'usa la política Grupo SL', dice 'mora TIIE+9%, comisión sí, FEGA sí'.
Guardado adentro, para siempre."

**Código:** la factura guarda el **nombre** de la política (`policy_code`,
`src/lib/azagro.ts:121`) y una foto de tasas y plazos (`params_snap`,
`azagro.ts:1450-1462`), pero los interruptores de comisión/FEGA se leen **en
vivo** de `credit_policies` cada vez (`ops.ts:1853` y `:1985` en el estado de
cuenta; `creditPolicyMap` en `issueMoraInvoice`). Cambiar un interruptor en
Ajustes hoy sí mueve facturas ya emitidas.

**Vigente: DISENO, con un detalle nuevo desde la Decisión 1 (5-sep-2026).** No
es solo congelar la política: con la tabla de dos columnas, el documento tiene
que congelar **las dos tasas** (costo y cobro) al confirmar, no una. HANDOFF
describía una referencia, no un congelamiento. Es la Fase 0/1 del § 14 del
diseño; no está construida.

### 1.9 "Circuito" no es lo mismo que "ruta"

**DISENO** (§ 2 y § 3): "El circuito es un dato de la operación. Cada pedido
declara por dónde corre": Contado / Línea Santa Rosa / Línea propia.

**Código:** el pedido tiene `route_kind` = `own` / `supplier` / `asr`
(`src/lib/erp/orders.ts:63`), que decide si la mercancía pasa por bodega o va
directa (`azagro.ts:1407` y `:1544`: `direct = route_kind === "supplier" ||
route_kind === "asr"`), y `asr_partner_id` exige "la contraparte (Santa Rosa /
ASR)" (`orders.ts:509`). **EXCEL_VS_SISTEMA.md** (§ 9.1) ya lo decía: "El sistema
solo marca el pedido como 'ruta ASR' y se salta la bodega".

**Vigente: DISENO.** La "ruta ASR" de hoy es logística (no entra a bodega),
no el circuito de financiamiento. Son dos datos distintos que hoy comparten
nombre; al construir hay que separarlos.

Nota de continuidad (5-sep-2026, sin forzar nada): con el catálogo de **cuatro**
circuitos de financiamiento confirmado hoy, el `route_kind = "asr"` que ya
existe en código (`orders.ts:63`) queda como un punto de partida natural para
el selector de circuito — hoy solo decide bodega sí/no, pero ya es un campo
del pedido con ese nombre. No es una decisión, solo una observación para quien
construya el selector.

### 1.10 Plazo fijo de 150 vs días del pedido

**EXCEL_VS_SISTEMA.md** (§ 2): "Capa 1 = costo × 1.01 × (TIIE + 4%) ×
**150/360**, siempre". **HANDOFF.md / CLAUDE.md**: "con los días de crédito de
ESE pedido — no un plazo fijo" (`pricing.ts:58-70`, `days`).

**Vigente: HANDOFF (código).** El ejemplo del diseño usa 150 porque ese es el
plazo pactado del ejemplo, no un fijo.

### 1.11 Desde qué día corre la mora (histórico, cerrado)

**LOGICA.md** (hallazgo 4): "El motor de intereses cuenta los días vencidos
desde el vencimiento de factura (día 120)". **EXCEL_VS_SISTEMA.md** (§ 9.5) y
**HANDOFF.md** (Decisiones): desde el día 150. Código: `ops.ts:1954`
(`moraDue = credit_due || due_date`), `credit.ts:403`. **DISENO** (§ 11): "Plazo:
días de factura y días de interés". Todos alineados; se deja anotado porque
LOGICA sigue diciendo lo viejo.

### 1.12 Inconsistencia interna del diseño (corregida el 5-sep-2026)

**DISENO** (§ 5): el precio al cliente sale con la tasa de cálculo (TIIE +
4.15%): 106,951.87 + 6,043.00 = **112,994.88** (verificado en 3.a). Pero la
"Mora que cobra Santa Rosa 1,496.29 a TIIE + 9%" solo cuadraba sobre
**112,927.36** (el precio a TIIE + 4.00%): 112,927.36 × 15.9% × 30 / 360 =
1,496.29; sobre 112,994.88 da 1,497.18. Diferencia de $0.89: el ejemplo
mezclaba los dos precios.

**Corregido en `DISENO_FINANCIAMIENTO.md` § 5 el 5-sep-2026** (punto g de la
sesión): mora **1,497.18** (sobre 112,994.88, el precio real al cliente),
utilidad de la mora **525.70**, reparto **262.85 / 262.85**. El costo de la
línea (971.48, sobre 106,951.87 a tasa de costo 4.00%) ya estaba bien y no
cambió.

### 1.13 DISENO § 12 "Qué NO cambia: el cálculo de mora"

Es cierto para la **fórmula** (cargo × (TIIE + 9%) × días / 360, desde el día
150), que no se toca — y, con la corrección del 5-sep-2026 (punto f, junto con
1.6), ahora se puede decir con precisión **para cuál circuito**: es cierto
**dentro de doble facturación** (la fórmula, quién la cobra y de quién es la
utilidad se quedan exactamente como hoy: Azagro, 100 %). Cambia **al entrar al
circuito lineal**: la cobra Santa Rosa y la utilidad se reparte 50/50 (§ 5 y
§ 9.3). No es una contradicción entre documentos — es que "no cambia" describía
un solo circuito y hacía falta decir cuál. `issueMoraInvoice` y
`computeDealPnl` no se tocan para doble facturación; sí hace falta construir
el camino lineal cuando llegue su fase (3.c).

### 1.14 Revisión pedida por el dueño (punto f, 5-sep-2026): ¿qué más se disuelve por ser parámetro de circuito?

Se repasaron las 13 contradicciones contra la idea de que cada circuito trae
sus propios parámetros. **Se disuelven, sin forzarlas:**

- **1.2** (quién factura al cliente): en tres circuitos de cuatro factura
  Azagro; solo en lineal factura Santa Rosa. No era una contradicción, faltaba
  decir "por circuito".
- **1.6** (Capa 2 y de quién es la mora): la fórmula de EXCEL_VS_SISTEMA / el
  código actual es la del circuito de doble facturación, verificada contra su
  Excel; la del diseño es la del lineal. Dos fórmulas correctas, una por
  circuito.
- **1.13** (mismo tema que 1.6, sobre "qué no cambia").
- **1.4** (comisión del 1 %): tratada en 1.4 directamente — HANDOFF describe
  doble facturación (comisión sí), DISENO describe lineal (comisión no).

**No se disuelve, y se reporta tal cual — punto f pide no forzar:**

- **1.5** (sobre qué base se calcula el financiamiento): la fórmula sí puede
  leerse "una por circuito" en el fondo, pero eso no resuelve el problema real:
  **dentro del circuito lineal**, con margen en monto fijo, la fórmula de hoy
  (que seguiría siendo la base del cálculo) da un precio distinto al que el
  diseño exige. Es una discrepancia técnica real que sigue pendiente de
  decisión (4.9), no una contradicción entre documentos que un circuito
  distinto explique.
- **1.3** (una tasa vs dos): no se disolvió por circuito — la resolvió
  directamente la Decisión 1 del dueño (tabla de dos columnas), independiente
  de cuál circuito se use.
- **1.7 / D-B** (tasa del pronto pago): sigue sin contestar; solo cambió el
  vocabulario (costo/cobro en vez de real/cálculo).
- **1.8, 1.9, 1.10, 1.11, 1.12**: no tratan de qué circuito aplica una
  fórmula, sino de mecanismos (congelar, nombrar un dato, fechas, un error de
  aritmética); no hay nada que disolver ahí por esta vía.

---

## 2. Las preguntas abiertas, todas en una sola lista

Clasificación:
- **RESUELTA EN CÓDIGO** — el sistema ya lo hace de una forma y se cita.
- **RESUELTA EN DOCUMENTO** — alguien lo decidió por escrito, pero no está
  construido.
- **ABIERTA** — nadie la ha contestado. Redactada para el dueño.

Origen: **L** = las 8 preguntas de LOGICA.md · **H** = "Qué falta" de HANDOFF.md
· **D** = decisiones A/B/C de DISENO · **E** = lo que dejó EXCEL_VS_SISTEMA.md.

### L1. ¿El interés de mora se calcula sobre el cargo original o sobre el saldo? (LOGICA h.12)
**RESUELTA EN CÓDIGO.** Sobre el cargo original, en las dos vistas.
`credit.ts:402` "El interés corre SIEMPRE sobre el cargo original, no sobre el
saldo"; `credit.ts:191` (estado de cuenta); `issueMoraInvoice` factura con
`cargo: Number(inv[0].amount)`. Comisión + FEGA también sobre el cargo
(`credit.ts:157` y `:216`). Decisión en HANDOFF (Decisiones, 2.º punto).

### L2. ¿Desde qué fecha corre la mora cuando factura y plazo son distintos (120/150)? (LOGICA h.4)
**RESUELTA EN CÓDIGO.** Desde el plazo financiero (día 150): `ops.ts:1954`,
`credit.ts:403`; el papel imprime las dos fechas, "Vence" e "Interés desde"
(`src/lib/erp/doc-text.ts`, `statementPaperRow`). Decisión en HANDOFF.

### L3a. Devoluciones: ¿la mercancía regresa al costo al que salió o al promedio de hoy? (LOGICA h.9)
**ABIERTA.** Hoy regresa al promedio actual de la bodega: `returnSale` llama a
`postStock` sin costo (`azagro.ts:1556-1565`) y `postStock` toma el promedio
del destino cuando no recibe uno (`src/lib/erp/stock.ts:184-186`). Nadie lo
decidió. *Para el dueño: cuando un cliente devuelve producto, ¿lo contamos al
precio que nos costó cuando se lo vendimos, o al precio promedio que tiene hoy
el almacén?*

### L3b. ¿La mora ya facturada se ajusta si el cliente devuelve parte del producto? (LOGICA h.11)
**ABIERTA.** La devolución no toca las FI ni el cargo sobre el que corre el
interés (la NC es un documento aparte). *Para el dueño: si un cliente ya debe
intereses y luego devuelve la mitad de la mercancía, ¿los intereses se quedan
como están o se reducen en proporción?*

### L3c. ¿Qué se hace con el saldo a favor de una nota de crédito sobre una factura ya pagada? (LOGICA h.10)
**ABIERTA.** HANDOFF "Qué falta" lo lista entre los INCOMPLETOS "sin tocar".
*Para el dueño: si un cliente ya pagó y devuelve producto, ¿ese dinero se le
descuenta de su siguiente factura, se le regresa, o las dos cosas según el
caso?*

### L4a. En un pedido en dólares, ¿el precio se captura en dólares o en pesos? (LOGICA h.14)
**La parte de MODELO quedó RESUELTA por la Decisión 2 del dueño (5-sep-2026,
`DECISIONES.md`): la moneda y el tipo de cambio pertenecen a la OPERACIÓN, no
al cliente.** Un mismo cliente puede tener un pedido en pesos y otro en
dólares al mismo tiempo, con TC pactado por operación. Esto confirma lo que ya
hace el esquema (`sales_orders.currency`, `quotes.currency`,
`invoices.currency` son campos por registro, no por `partners`) como regla
deliberada, no como coincidencia.

**Lo que sigue ABIERTO — el código se contradice a sí mismo en la
captura.** Al emitir la factura, el total del pedido se toma como **pesos** y
los dólares se derivan dividiendo entre el TC: `azagro.ts:1435` `const mxn =
Number(so[0].total)` y `azagro.ts:1470` `mxn / fx`; el cobro también trabaja
"en pesos al TC pactado" (`ops.ts:1518`). Pero los papeles imprimen ese mismo
número con signo de **dólares**: el pedido (`src/routes/sales.$orderId.tsx:283`,
`moneyIn(ln.unitPrice, form.currency)`), la cotización (`src/routes/quotes.tsx:342`)
y el estado de cuenta (`doc-text.ts:212`, `money(r.cargo)` con la moneda USD).
Ninguna pantalla dice en qué moneda escribir el precio (la única etiqueta USD
es "Dólar pactado", `quotes.tsx:390`). El dueño lo dejó anotado explícitamente:
*el campo de captura del precio debe indicar la moneda del pedido (USD o MXN),
nunca un "$" ambiguo, porque hoy la pantalla muestra "$" mientras el código
guarda pesos.* Falta construirlo.

### L4b. Al cobrar una factura en dólares, ¿se pregunta el tipo de cambio del pago? (LOGICA h.13)
**RESUELTA EN CÓDIGO.** Sí. La pantalla de cobro captura **"Importe (pesos
depositados)"** (`src/routes/credit.tsx:440`) y, si la factura es en dólares,
**"TC del pago (obligatorio: factura en dólares)"** (`credit.tsx:453`) más la
decisión "Dejarlo como utilidad/pérdida" o "Ajustar al pactado (por cobrar /
devolver)" (`credit.tsx:464-484`). El servidor rechaza sin TC (`ops.ts:1529`)
y reparte con `fxPaymentSplit` (`credit.ts:380`). Decisión en HANDOFF ("El
tipo de cambio pactado manda").

### L5. ¿Qué pasa con un pago mayor al saldo, y quién decide a qué facturas se aplica un depósito? (LOGICA h.7)
**ABIERTA.** Hoy el sobrante se descarta: `ops.ts:1542` `applied =
Math.min(opts.amount, residual)` y el banco registra solo lo aplicado
(`:1543`); no hay anticipo ni saldo a favor. La aplicación es factura por
factura, a mano. *Para el dueño: si un cliente deposita más de lo que debe en
una factura, ¿lo guardamos como saldo a su favor, lo aplicamos a su siguiente
factura, o no lo aceptamos? Y con un solo depósito para varias facturas, ¿lo
reparte la persona o el sistema empezando por la más vieja?*

### L6. ¿Cuándo nace la deuda con el proveedor: al capturar la OC, al recibir, o con su factura real? (LOGICA h.16)
**ABIERTA.** Hoy nace al capturar la OC: `createPurchase` inserta la FP en el
mismo momento (`azagro.ts:1144-1148`). Nadie lo decidió. *Para el dueño: ¿le
debemos al proveedor desde que le pedimos, desde que nos entrega, o desde que
nos manda su factura?*

### L7. ¿El pronto pago se bonifica de verdad o solo se informa? (LOGICA h.19)
**RESUELTA EN CÓDIGO.** Se aplica de verdad como descuento al cobrar:
`ops.ts:1642` "Descuento REAL por pronto pago: si pagó antes del umbral […] ese
resto se perdona y la factura se cierra", con `earlyPayBonus`
(`credit.ts:445`). En el estado de cuenta solo se muestra en pantalla
(decisión 4-sep). **La tasa** vuelve a estar en duda: ver D-B.

### L8a. ¿El ajuste de inventario de entrada debe pedir costo? (LOGICA h.18)
**ABIERTA.** `adjustStock` no acepta costo (`azagro.ts:975-981`: producto,
bodega y cantidad); entra al promedio actual. *Para el dueño: cuando en un
conteo aparecen tambos de más, ¿hay que decir cuánto costaron o basta con
contarlos?*

### L8b. ¿El flete se mete al costo del producto o se queda como gasto? (LOGICA h.18)
**RESUELTA EN CÓDIGO** (decisión 3-sep, HANDOFF punto 18): el flete se
prorratea al costo del producto y ese "costo puesto" es la base del margen,
del financiamiento y del costo financiero (`pricing.ts:57`, `reports.ts`
`landed = cogs + freight + other`). **No** entra al kardex (el promedio móvil
no lo lleva). Lo que el diseño nuevo no dice es si ese flete va en la factura
de Azagro a Santa Rosa: ver 4.1.

### H1. Valores por omisión de negocio (HANDOFF "Qué falta")
**RESUELTA EN CÓDIGO.** Ningún número de negocio vive en el código; sin
renglón de Ajustes, `policy()` se detiene (`ops.ts:180-186`) y lo vigila
`scripts/erp-sin-numeros.test.mjs`. Pendiente **operativo**, no de decisión:
capturar `fega_commission` y `early_pay_days` en una base que ya existía.

### H2. Columnas sin uso (`credit_policies.spread`, `fega_rate`, `customer_pos.fx_rate`)
**RESUELTA EN DOCUMENTO pero no construida.** HANDOFF: "Quitarlas cuando toque
una limpieza de esquema". No requiere decisión del dueño.

### H3. La "Sesión D": barrido de uso real, simplificación de pantallas y huecos operativos
**ABIERTA.** HANDOFF la deja "pendiente, no se ha hecho todavía"; DISENO § 14
no la programa. *Para el dueño: ¿se hace ese barrido antes de pegar el corte
de Compaq, o después?*

### H4a. Revertir un pago capturado por error (LOGICA h.8)
**ABIERTA.** No existe; HANDOFF lo lista "sin tocar". *Para el dueño: ¿cómo se
corrige un cobro que se capturó mal — se borra con rastro, o se registra el
movimiento contrario?*

### H4b. Cancelaciones (pedido entregado, OC recibida, factura cobrada) (LOGICA h.15)
**ABIERTA.** No existen. *Para el dueño: ¿qué documentos se pueden cancelar,
quién puede, y qué pasa con la mercancía y el dinero que ya se movieron?*

### H4c. Devolución a proveedor y nota de crédito de proveedor (LOGICA h.15)
**ABIERTA.** No existen; la FP se queda viva. *Para el dueño: si nos llega
mercancía equivocada, ¿cómo se regresa y cómo se baja la deuda con el
proveedor?*

### H4d. Recepciones y entregas parciales (LOGICA h.17)
**ABIERTA.** Siempre completas. *Para el dueño: si el proveedor manda 20 de 50
tambos, o si al cliente se le entrega en dos viajes, ¿se registra por partes?*

### H5. Lotes y caducidad
**ABIERTA.** CLAUDE.md los pone "después"; nadie ha dicho cuándo ni cómo.
*Para el dueño: ¿el sistema tiene que saber de qué lote es cada tambo y cuándo
caduca, y desde cuándo?*

### H6. Unidades de medida (kg ↔ tambo ↔ litro)
**ABIERTA.** Un solo UOM por producto. *Para el dueño: ¿se compra en una
unidad y se vende en otra, y en qué productos?*

### H7. Flete prorrateado entre productos de un mismo viaje
**RESUELTA EN DOCUMENTO pero no construida.** DISENO § 14: "En paralelo,
cuando toque: […] prorrateo de flete". La regla de reparto (por peso, por
importe, por tambo) no está escrita en ningún lado.

### H8a. Pegar el CSV de saldos abiertos y existencias del corte de Compaq
**RESUELTA EN CÓDIGO (pendiente operativo).** El importador existe, es
idempotente y exige elegir la política de cobro (`src/lib/erp/cutover.ts:152`).
Falta el archivo.

### H8b. ¿Con qué circuito entran los saldos del corte?
**RESUELTA EN DOCUMENTO (Decisión 3.d del dueño, 5-sep-2026).** Los saldos del
corte de Compaq entran con el circuito de **doble facturación (ASR)**, porque
así se operaron: son deudas reales que ya corrieron por ese circuito, no un
caso nuevo. Con el catálogo corregido de cuatro circuitos (DISENO § 3), sí
caben — ya no hacía falta un quinto caso. Ver 4.6, misma respuesta. Falta
construir el selector de circuito y que el importador (`cutover.ts:152`) lo
capture además de la política de cobro.

### D-A. La comisión del 1% en el precio (DISENO § 13.A)
**RESUELTA EN DOCUMENTO (Decisión 3 del dueño, 5-sep-2026), no construida.**
Es la salida 1 del diseño: **la comisión es un parámetro de la línea/circuito**.
En doble facturación (ASR) se cobra —es un costo real, la línea la cobra, así
se ha operado siempre—; en el circuito lineal no se cobra (la línea no la
cobra). Deja de ser una constante global. El código de hoy la cobra siempre y
la reporta como costo (`pricing.ts:57-77`, `credit.ts:471` "NO QUITAR",
Ajustes `settings.tsx:340`) — correcto mientras solo exista doble facturación;
falta condicionarla por circuito cuando se construya el lineal.

### D-B. ¿A qué tasa se bonifica el pronto pago, de costo o de cobro? (DISENO § 13.B)
**ABIERTA — reformulada el 5-sep-2026.** Ya no es "real (4.00) vs cálculo
(4.15)": con la Decisión 1, la tabla tiene tasa de costo y tasa de cobro
capturadas directamente. Hoy el código usa una sola tasa para todo
(`ops.ts:1673`, `credit.ts:445`). *Para el dueño: cuando un cliente paga
antes, ¿le regresamos exactamente lo que le cobramos (tasa de cobro), o solo
lo que a nosotros nos costó (tasa de costo), quedándonos la diferencia?*

### D-C. ¿Cuánto tarda Santa Rosa en pagarle a Azagro, y cuánto hay expuesto en ese tramo? (DISENO § 13.C)
**ABIERTA.** No hay nada en código: no existe la cuenta "Santa Rosa por
facturas" (DISENO § 9.2). *Para el dueño: ¿hay un plazo pactado con Santa Rosa
para pagarle a Azagro, o se paga cuando hay dinero? Y ¿quieres ver en pantalla
cuánto nos deben en cada momento?*

### E1. ¿La regla vigente es TIIE + 9% sobre el capital solo, o el 18% sobre capital + FEGA del archivo viejo? (EXCEL § 6)
**RESUELTA EN CÓDIGO.** TIIE + 9% sobre el cargo, sin FEGA en la base
(`credit.ts:156-157`, HANDOFF Decisiones "Tasa de cobro TIIE + 9%").

### E2. ¿La tabla de TIIE se captura con el colchón de +0.30 sobre Banxico? (EXCEL § 1 y § 9.6)
**RESUELTA EN DOCUMENTO (Decisión 1 del dueño, 5-sep-2026), no construida.**
Deja de existir la pregunta tal como estaba planteada: ya no hay una sola
tasa con un colchón escondido adentro. La tabla lleva **dos columnas
capturadas directamente** —tasa de costo y tasa de cobro—, ninguna se llama
"TIIE" (un número con protección adentro no es la TIIE que publica Banxico), y
la protección se calcula como la diferencia entre las dos. El riesgo de los
dos colchones encimados (comprobación 3.b) desaparece porque ya no hay un
colchón "agregado en código" sobre una tasa que quizá ya traía uno: los dos
números que importan se capturan tal cual. Falta construir la tabla de dos
columnas (hoy es de una sola, `tiie_rates`) y decidir con qué se siembra la
columna de costo para las tasas ya capturadas.

### E3. La TIIE del precio (al cotizar) y la del costo (al emitir la factura) son distintas (EXCEL § 1 y § 2)
**RESUELTA EN CÓDIGO.** El precio usa el renglón vigente al cotizar
(`ops.ts`, `createQuote`); la factura congela el renglón vigente a su emisión
(`azagro.ts:1450-1462`, `tiieIssue`) y la utilidad usa esa foto
(`reports.ts:80`). EXCEL § 2 todavía lo marca "pendiente": está desactualizado.

**ABIERTAS en esta lista: 16** (eran 19; el 5-sep-2026 se cerraron D-A, H8b y
E2, las tres en documento, ninguna construida) — L3a, L3b, L3c, L4a
(solo la parte de captura; el modelo ya se cerró), L5, L6, L8a, H3, H4a, H4b,
H4c, H4d, H5, H6, D-B, D-C. (H2 y H7 están decididas en documento; D-A, E2 y
H8b se movieron a "resuelta en documento" hoy; el resto está en código.)

---

## 3. Tres comprobaciones numéricas (contra el código real, sin cambiarlo)

Se corrieron con Node sobre copias exactas de `financeCost` (`credit.ts:487`)
y `marginUnit` (`margins.ts:128`), con los números del ejemplo del diseño:
costo 100,000, margen 6.5%, 150 días, TIIE 6.9%, comisión 1%.

### 3.a "El motor de precios no cambia" — cierto con margen en %, falso con margen en $

| | Motor de hoy (financiamiento sobre el costo, margen después) | Diseño (margen primero, financiamiento sobre el precio con margen) | Diferencia |
|---|---|---|---|
| Margen **6.5 %**, spread 4.00 | precio **112,927.36** | 106,951.87 + 5,975.49 = **112,927.36** | 0.00 |
| Margen **6.5 %**, spread 4.15 | precio **112,994.88** | 106,951.87 + 6,043.00 = **112,994.87** | 0.01 (redondeo) |
| Margen **$6,951.87 fijo**, spread 4.00 | 100,000 + 5,587.08 + 6,951.87 = **112,538.95** | 106,951.87 + 5,975.49 = **112,927.36** | **388.41** |
| Margen **$6,951.87 fijo**, spread 4.15 | **112,602.08** | **112,994.87** | **392.79** |

Con margen en porcentaje son la misma fórmula: (costo + costo·k) ÷ (1 − m) =
costo ÷ (1 − m) + (costo ÷ (1 − m))·k. Con margen en monto fijo no: el motor
financia solo el costo (`pricing.ts:58-70` y `:77`: `priceUnit = landedUnit +
financeUnit + marginUnit`), el diseño financia costo + margen (lo que Santa
Rosa desembolsa). La diferencia es exactamente **margen × k**, con k = 5.587 %
(comisión 1 % + 1.01 × 10.9 % × 150 / 360): $388 por cada $100,000 de costo en
este ejemplo, y crece con el margen y con los días.

Dónde se usa cada modo:
- **%**: el modo con el que nace una partida en la solicitud
  (`src/routes/solicitudes.$solicitudId.tsx:68`, `modoVacio = "pct"`); es el
  caso normal.
- **$ fijo**: (1) el selector de la solicitud lo permite por partida
  (`solicitudes.$solicitudId.tsx:96`, opción "$ / unidad"); (2) **toda
  cotización capturada directa, sin solicitud**, guarda sus dos márgenes en
  monto fijo (`ops.ts:878-879`, `mode: "nominal"`), porque ahí el precio a
  crédito se arma como contado + financiamiento sobre el costo
  (`pricing.ts:157`, `creditFromCash`); (3) los márgenes migrados por la 0018
  conservan el modo que tenían.

Consecuencia: en el circuito nuevo, una cotización con margen en $ fijo le
cobraría al cliente **menos** de lo que Santa Rosa va a desembolsar más su
financiamiento. O el motor cambia para el modo $ (financiar costo + margen), o
el modo $ deja de usarse en el circuito Santa Rosa. Es una decisión, no un
detalle; queda anotada en 4.9.

### 3.b El colchón de la TIIE: hoy no está escrito en ningún lado, y con el diseño quedarían dos encimados — riesgo resuelto por la Decisión 1

> **El riesgo que describe esta comprobación quedó resuelto el 5-sep-2026 por
> la Decisión 1 del dueño** (tabla de dos columnas, tasa de costo y tasa de
> cobro, capturadas directamente; ver 1.3 y E2). El análisis de abajo se
> conserva porque explica **por qué** hacía falta esa decisión: con una sola
> tasa y un spread calculado aparte, dos colchones podían encimarse sin que
> nadie lo notara. Con dos columnas capturadas no hay cómo encimar nada: lo
> que se ve es lo que hay.

- **Código y Ajustes:** ninguna mención. Búsqueda de "colchón", "Banxico",
  "0.30" y "protección" en `src/` y `migrations/`: cero resultados. El único
  texto de la tabla TIIE en Ajustes es "Solo un administrador puede cambiar la
  TIIE." (`settings.tsx:572`). La tabla es un número capturado a mano; nada
  dice si es Banxico puro o Banxico + 0.30.
- **EXCEL_VS_SISTEMA.md** (§ 1): "una tabla mensual de TIIE (Banxico + 0.30
  puntos de 'protección')"; § 9.6: "basta capturarla ya con el colchón — pero
  conviene escribir la regla en Ajustes para que quien capture lo sepa". No se
  escribió.
- **DISENO** (§ 6): otro colchón, +0.15 (4.15 vs 4.00), "protección contra
  movimientos del banco".

**Si la tabla se captura con +0.30 y además se usa la tasa de cálculo 4.15, se
enciman dos colchones (+0.45 sobre Banxico en el precio).** Peor: la "tasa
real" TIIE + 4.00 del diseño tampoco sería real, porque la TIIE de la tabla ya
trae 0.30 escondidos, y **la mora al cliente** (TIIE + 9 %) también los
cargaría. En el ejemplo del diseño (base 106,951.87 × 1.01, 150 días):
+0.15 = $67.51 por operación (el "$67" del diseño), +0.30 = $135.03, los dos
juntos = $202.54; y sobre la mora de 30 días, +0.30 = $28.25 más. **No se
corrige aquí; es la pregunta E2.** Lo mínimo, decida lo que decida el dueño: un
texto en Ajustes junto a la tabla que diga qué número se captura.

### 3.c Capa 2 y reparto de mora: qué tendría que cambiar

**Hoy:**
- `credit.ts:487-503` `financeCost`: Capa 2 = `saleCapital` × (TIIE emisión +
  spread ASR) × días excedidos / 360, con `saleCapital` = **precio al cliente**
  (`reports.ts:165`, `saleCapital: sale`).
- `reports.ts:239-267` `computeDealPnl`: la Capa 2 entra completa a
  `finance` y se resta de `netProfit`; la mora facturada (`mora`, FI ligadas
  al pedido) entra **completa** como ingreso de Azagro.
- `reports.ts:276` visiones realizada/caja/proporcional parten de ese
  `netProfit`; `getPanorama` (`reports.ts:517` en adelante) suma `capa2` y
  `mora` por razón social; `listDealPnl` los totaliza.
- La FI la emite Azagro (`ops.ts`, `issueMoraInvoice`) al cliente, y la
  explica en su papel como cobro de Azagro (`doc-text.ts`,
  `interestInvoiceClientCalc`).

**Con el diseño (§ 5, § 9.3):**
- El costo de la línea durante la mora corre sobre **lo que Santa Rosa
  desembolsó** (costo + margen = la factura de Azagro a Santa Rosa,
  106,951.87), a la **tasa real** (TIIE + 4.00), no sobre el precio al cliente
  ni a la tasa de cálculo. Con 30 días: 971.48 (verificado) contra 1,026.37 si
  se calculara como hoy sobre 112,994.88.
- La mora la cobra Santa Rosa; la **utilidad** de la mora (mora − costo de
  línea) se reparte 50/50; a Azagro le entra su mitad por la cuenta "Santa
  Rosa por reparto de mora" (§ 9.3).

**Archivos y reportes que tendrían que cambiar** (ninguno se tocó hoy):
1. `src/lib/erp/credit.ts` — `financeCost`: la base de la Capa 2 deja de ser
   el capital de la venta; hace falta un parámetro nuevo ("desembolsado por la
   línea") y la tasa real separada de la de cálculo.
2. `src/lib/erp/reports.ts` — `computeDealPnl`: Capa 2 sobre lo desembolsado
   y a tasa real; `mora` deja de ser 100 % ingreso y pasa a ser la mitad de
   (mora − costo de línea) en el circuito Santa Rosa (y 100 % en contado y
   saldos del corte); `netProfit`, `utilidadRealizada`, `utilidadCaja` y
   `utilidadProporcional` heredan el cambio; `financeBase` tiene que decir
   sobre qué base corrió cada capa.
3. `src/lib/erp/reports.ts` — `getPanorama` y `listDealPnl`: columnas
   `capa2` y `mora` por razón social pasan a "capa 2 (sobre desembolso)" y
   "mora (parte de Azagro)"; falta una columna "mora cobrada por Santa Rosa".
4. `src/lib/erp/ops.ts` — `issueMoraInvoice`: en el circuito Santa Rosa Azagro
   **no** emite FI al cliente; lo que emite (o registra) es el reparto. La FI
   actual solo aplica a contado y saldos del corte.
5. `src/lib/erp/doc-text.ts` — `interestInvoiceClientCalc` y el papel de la
   FI: quién cobra y a nombre de quién.
6. `src/routes/sales.$orderId.tsx` — tarjeta "Costo financiero" (usa
   `financeBase`, `layer2`, `mora` de `computeDealPnl`); `src/routes/reportes.tsx`
   / Panorama.
7. Pruebas: `scripts/erp-utilidad.test.mjs` (Capa 2, `financeBase`),
   `scripts/erp-fx-visiones.test.mjs` (visiones), `scripts/erp-cartera.test.mjs`
   y `scripts/erp-formulas.test.mjs` (copias de `financeCost`),
   `scripts/erp-documento-limpio.test.mjs` (papel de la FI).
8. Esquema: no existe dónde guardar "desembolsado por la línea" ni la mitad
   de mora que le toca a Azagro: es la Fase 2/3 del diseño (líneas,
   disposiciones, reparto).

---

## 4. Lo que el documento nuevo no contesta (y va a hacer falta al construir)

### 4.1 El flete
Hoy el flete se prorratea al costo y es base del margen y del financiamiento
(`pricing.ts:57`, `reports.ts` `landed`). El ejemplo del diseño (§ 5) parte de
"Azagro paga al proveedor 100,000" sin flete. **No dice** si la factura de
Azagro a Santa Rosa lleva el flete adentro (y entonces Santa Rosa lo financia),
si va aparte, o si lo absorbe Azagro. *Para el dueño: el flete, ¿se lo
facturamos a Santa Rosa junto con la mercancía, o lo cobramos aparte?*

### 4.2 Comisión + FEGA de la mora
Hoy se cobran una sola vez sobre el cargo, al vencer, según los dos
interruptores de la política (`credit.ts:100-105`, `ops.ts:1985-1990`), en la FI
de Azagro. El diseño reparte solo "la utilidad de la mora" (interés − costo de
línea) y **no menciona** el 3.04 %. *Para el dueño: la comisión y el FEGA de
una factura vencida, ¿los cobra Santa Rosa o Azagro, y se reparten o son de
uno solo?*

### 4.3 Dólares y tipo de cambio pactado
Hoy el TC pactado se fija en la cotización/pedido (`ops.ts`, `createQuote`;
`orders.ts:493-495`), la FV guarda importe USD y TC (`azagro.ts:1470`), y el
cobro pregunta TC del pago y decide utilidad o ajuste (`credit.tsx:440-484`,
`ops.ts:1518-1545`). Si Santa Rosa factura al cliente, **no está dicho** en qué
moneda le factura Azagro a Santa Rosa, quién fija el TC pactado con el
cliente, quién se queda el diferencial (hoy el ATC "por cobrar / por
devolver" es documento de Azagro) ni cómo se reporta a Azagro un cobro en
dólares. Y antes de todo eso, la pregunta L4a (pesos o dólares en la captura)
sigue abierta. *Para el dueño: en el circuito Santa Rosa, ¿quién corre el
riesgo del tipo de cambio?*

### 4.4 El límite de crédito
Hoy el pedido a crédito se compara contra el límite del cliente y **su saldo
abierto con Azagro** (`orders.ts:512-535`: `credit_limit` contra las facturas
de cliente abiertas), y un administrador puede autorizar el exceso. Si Santa
Rosa factura, la deuda del cliente ya no está en las facturas de Azagro, y el
diseño solo define "límite autorizado / disponible" **por línea** (§ 7), no por
cliente. *Para el dueño: al aceptar un pedido, ¿qué lo detiene — el límite que
le pusimos al cliente, el disponible de la línea de Santa Rosa, o los dos? ¿Y
quién puede autorizar pasarse?*

### 4.5 Quién absorbe la bonificación por pronto pago
Hoy es un descuento real al cobrar (`ops.ts:1642`) que sale de la factura de
Azagro y se resta de su utilidad (`reports.ts:267`, `discount`). En el diseño
"el financiamiento ordinario se queda íntegro en Santa Rosa" (§ 5), pero la
bonificación es devolver parte de ese financiamiento. § 13.B decide la
**tasa**, no **quién** la paga. *Para el dueño: si el cliente paga antes y se
le devuelve parte del financiamiento, ¿lo pone Santa Rosa, Azagro, o a
medias?*

### 4.6 Con qué circuito entran los saldos del corte de Compaq — RESUELTO el 5-sep-2026
**Cerrado (Decisión 3.d, `DECISIONES.md`).** Entran con el circuito de
**doble facturación (ASR)**: son deudas reales que Azagro operó con ese
método, y el catálogo corregido de cuatro circuitos (DISENO § 3) ya tiene
dónde ponerlas, sin inventar un quinto caso. Mismo criterio para cualquier
venta a crédito que Azagro haga sin pasar por la línea de Santa Rosa mientras
no tenga línea propia: doble facturación. Falta construir: que el importador
(`cutover.ts:152`) capture el circuito además de la política de cobro, y el
selector de circuito en el pedido.

### 4.7 El estado de cuenta que sale al cliente, y Santa Rosa como tercera audiencia
Hoy los papeles tienen dos audiencias, `"cliente" | "proveedor"`
(`doc-text.ts:34`), cada una con las series de folio que puede ver
(`doc-text.ts:40-41`: cliente SOL/COT/PV/FV, proveedor SC/OC), y el estado de
cuenta sale con la razón social de Azagro (`statements.tsx:152`). Con el
diseño hacen falta, y **no están definidos**: (a) el papel al cliente que dice
que le debe a Santa Rosa (§ 9.4), con qué folios (¿la "factura espejo"?);
(b) una audiencia **Santa Rosa** para la factura de Azagro a Santa Rosa y la
"instrucción de facturación" (§ 4, pasos 7-8) — qué folios y qué costos puede
ver Santa Rosa (¿el proveedor? ¿la SC?); (c) la pared de privacidad de
`rules.ts` ("El cliente no ve al proveedor. El proveedor no ve al cliente") con
tres partes. *Para el dueño: ¿Santa Rosa puede ver a qué proveedor le
compramos y a cuánto? ¿El cliente puede ver que Santa Rosa está en medio?*

### 4.8 Quién emite la factura de intereses y cómo se entera Azagro
Hoy la FI la emite Azagro con el botón "Mora" de Cartera
(`src/routes/credit.tsx`, `invoiceLiveMora`) o al cobrar. En el diseño "Santa
Rosa cobra" la mora (§ 4 paso 13) y Azagro solo registra "cobros reportados"
(§ 10). **No está definido** el documento del reparto, quién lo captura, ni
si el botón "Mora" desaparece en el circuito Santa Rosa. *Para el dueño: la
factura de intereses al cliente, ¿la hace Santa Rosa en su sistema y nosotros
solo anotamos lo que nos toca?*

### 4.9 El margen en monto fijo (sale de la comprobación 3.a)
Con margen en $ fijo el motor de hoy da un precio menor al del diseño. *Para
el dueño: ¿se sigue permitiendo capturar margen en pesos por unidad en el
circuito Santa Rosa? Si sí, el precio tiene que financiar también el margen.*

### 4.10 La "instrucción de facturación" (§ 4, paso 8)
El diseño la nombra y no dice qué lleva: ¿precio final por partida, plazo,
política congelada, TC pactado, datos fiscales del cliente? Es el documento
del que sale la factura de Santa Rosa al cliente; sin su contenido no se puede
construir el paso 10 ("espejo").

---

## 5. Qué hacer con esto

- Las **16 ABIERTAS** del punto 2 y las **9 preguntas sin contestar** del
  punto 4 (de 10; 4.6 se cerró hoy) se contestan en `DECISIONES.md` conforme
  el dueño decida, un renglón por decisión, con fecha.
- El 5-sep-2026 (tarde) el dueño cerró tres de las cuatro preguntas que
  gateaban la Fase 2: **D-A** (comisión, parámetro del circuito), **E2**
  (colchón, tabla de dos columnas) y **H8b / 4.6** (saldos del corte, circuito
  de doble facturación) — las tres decididas en documento, ninguna construida
  todavía. **Sigue pendiente una sola: 4.9 (margen en $ fijo)** — sin
  contestarla, el motor de precios del circuito lineal no financia lo mismo
  que el diseño exige cuando el margen es en pesos.
- Este archivo se actualiza cada vez que una pregunta cambie de columna.
