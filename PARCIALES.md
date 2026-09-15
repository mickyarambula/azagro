# BLOQUE DE PARCIALES — diagnóstico y plan

**Fecha:** 14-sep-2026 · **Base:** `main` en `e0ed5c2` · **Alcance:** solo diagnóstico y plan; nada construido, ninguna migración, ninguna prueba nueva.
**Gobierna:** el principio de `DECISIONES.md` (*el sistema no borra y no decide solo; deja rastro y le pregunta a la persona*), las Decisiones 26, 28 y 42 (ya escritas para este día) y el patrón A6 de `PATRONES-DISENO.md`, que el dueño decidió meter en este bloque.
**Método:** el mismo de `DESHACER.md`: cada afirmación se verificó con `grep`/`sed` sobre el código de hoy y se cita `archivo:línea`. Lo que no se pudo verificar está en § 10, no repartido por el documento. No se abrió la base de datos.
**Línea base:** `npm test` = **577 casos, 577 en verde, 0 en rojo** (corrida hoy). Es el número contra el que se compara cada bloque de construcción que siga de aquí. Este documento no mueve ninguna prueba. La red de seguridad es la de `METODOLOGIA-TRABAJO.md` § 5: motor de antes congelado y comparado al centavo, y **ninguna prueba existente cambia** — si una tiene que cambiar, es la señal de que se movió comportamiento anterior y ahí se para. **No existe borrado de datos de prueba** (patrón C4, `ESTADO.md` § 4.15); ningún paso del plan lo da por hecho.

El problema, en corto (SESION_D.md § 1.2, el último de los cinco hallazgos graves que sigue abierto): **no hay parciales** — `deliverSale` escribe `qty_delivered = qty` (`azagro.ts:1513`) y `receivePurchase` escribe `qty_received = qty` (`:1301`), todo o nada — y **entregar es facturar en el mismo clic**: la FV nace dentro de `deliverSale` (`:1541-1617`). Pregunta ABIERTA H4d de `ESTADO.md`.

---

## 1. Qué escribe hoy cada camino

### 1.1 Los campos de cantidad que ya existen

| Campo | Dónde nace | Quién lo escribe | Quién lo lee además de los tres caminos |
|---|---|---|---|
| `purchase_lines.qty` | `0002_azagro.sql:102` | `createPurchase`, `applyRfqWinners`, `decideQuote` (`ops.ts:1713-1716`) | pendientes por recibir del tablero (`azagro.ts:921-931`, `pl.qty - pl.qty_received > 0.0001`), `listPurchases` (`:1109`) |
| `purchase_lines.qty_received` | `0002_azagro.sql:103`, `default 0` | `receivePurchase` → `= qty` (`:1301`); `reverseReceipt` → `= 0` (`receipt-reversal.ts:274-277`) | los mismos dos lectores de arriba |
| `sales_lines.qty` | `0002_azagro.sql:123` | `saveOrder`, `decideQuote` (`ops.ts:1668-1672`), `convertCustomerPO` | pendientes por entregar (`azagro.ts:940-951`, solo `s.state = 'confirmed'`), `listSales` (`:1353`), `getOrder` (`orders.ts:237-252`), **el P&L por pedido** (`reports.ts:156`, `sl.qty`), la FV (`azagro.ts:1610-1617`, renglones por `qty`, no por lo entregado) |
| `sales_lines.qty_delivered` | `0002_azagro.sql:124`, `default 0` | `deliverSale` → `= qty` (`:1513`); `reverseDelivery` → `= 0` (`delivery-reversal.ts:286`) | pendientes por entregar (`:943-951`), `listSales` (`:1353`), `getOrder` (`orders.ts:248`), `returnSale` como tope (`:1699`), pantalla del pedido (`sales.$orderId.tsx:665-690`) |
| `sales_lines.qty_returned` | **No hay migración**: nace por `alter table … add column if not exists` en tiempo de ejecución (`azagro.ts:1643`, `orders.ts:179`) | `returnSale` → `+= qty` (`:1736`); `reverseReturn` → `greatest(0, − qty)` (`return-reversal.ts:275`) | `returnSale` tope (`:1699`), `getOrder` (`orders.ts:249`), `chainForDelivery` (`delivery-reversal.ts:110`, bloquea si > 0), pantalla (`sales.$orderId.tsx:665-691`) |

Ningún lector cierra estos cuatro campos en una identidad (DISENO-INVESTIGACION.md A6, `:177-179`). El único cuadre que existe es kardex contra existencia por producto y bodega (`azagro.ts:954-986`).

### 1.2 `receivePurchase` (`azagro.ts:1269-1319`, `withTx`)

Recibe solo `{ poId }`. Bloquea la OC `for update` (`:1276-1280`); rechaza `done`/`cancelled` (`:1281`) y directa/brokeraje (`:1283`). Por partida: `pending = qty − qty_received` (`:1289`), `postStock` `'receipt'` por `pending` al `unit_price` de la OC con `origin` = folio de la OC (`:1291-1300`), y `qty_received = qty` (`:1301`). Luego `purchase_orders.state = 'done'` (`:1303`) y nace la FP con `bornSupplierDebt` (`:1304-1309`). Bitácora `recibir` (`:1310-1317`).

`bornSupplierDebt` (`:1221-1267`): **idempotente por OC** — si ya existe una FP no revertida con `origin = poName`, regresa `null` sin crear nada (`:1229-1235`); se detiene sin plazo del proveedor (`:1246-1255`, Decisión 30); vence a `plazo` días desde la fecha de recepción (`:1257`); **importe = `po.total`, la orden completa** (`:1258`); folio `FP-` contando todas las facturas `kind = 'supplier'` (`:1259-1260`).

### 1.3 `deliverSale` (`azagro.ts:1463-1631`, `withTx`)

Recibe solo `{ soId }`. Bloquea el pedido `for update` (`:1470-1489`); rechaza `done`/`cancelled` (`:1493`) y exige `confirmed` (`:1494`). Por partida: `pending = qty − qty_delivered` (`:1500`); si no es directo, `postStock` `'delivery'` por `pending` con `origin` = folio del pedido (`:1503-1511`); `qty_delivered = qty` (`:1513`). Luego `sales_orders.state = 'done'` (`:1515`); en brokeraje nace la FP de cada OC directa (`:1520-1536`, Decisión 29, misma idempotencia por OC). Y **en el mismo clic nace la FV**: vencimientos copiados del pedido (`invoice_due`/`credit_due`, `:1539-1540`), folio `FV-` contando todas las facturas de cliente (`:1541-1542`), **importe = `so.total`, el pedido completo** (`:1548`), foto de parámetros con `financialDays = so.credit_days` (`:1561`, `:1590`), y **renglones por `sales_lines.qty` completo** (`:1610-1617`). Bitácora `entregar` (`:1619-1627`).

### 1.4 `returnSale` (`azagro.ts:1632-1830`, `withTx`)

Exige pedido `done` (`:1665`). Tope por partida `qty_delivered − qty_returned` (`:1699`). Calcula el folio de la NC antes de mover inventario y lo pone en `origin` del `return` (`:1684-1685`, Decisión 42); entra al costo con el que salió vía `deliveredUnitCost` (`:1710`, Decisión 9/26); `qty_returned += qty` (`:1736`); NC negativa (`:1741-1751`); y el abono virtual se aplica a **la última FV del pedido**: `name like 'FV-%' order by id desc limit 1` (`:1762-1766`), PAG sin banco ligado por `memo = 'Devolución NC-x'` (`:1768-1778`).

### 1.5 Lo que los tres caminos comparten

- Un solo movimiento de kardex por pedido/OC y producto, con `origin` = folio del documento comercial (`stock_moves.origin` es texto, `0002_azagro.sql:78`; no hay id del pedido ni de la entrega). Con dos entregas del mismo pedido, las dos salidas llevan **el mismo `origin`** y solo se distinguen por `id` y fecha.
- Estado de cabecera de un solo salto: `confirmed → done` (`:1303`, `:1515`). No existe un estado "parcialmente entregada/recibida"; el tablero deduce "pendiente" por `state` y cantidad (`:921-951`, `:384-388`).
- Todas las reversas del bloque de deshacer operan **por documento comercial** (OC o pedido), no por movimiento: `chainForReceipt` toma todos los `receipt` vivos de la OC (`receipt-reversal.ts:92-114`), `chainForDelivery` todos los `delivery` vivos del pedido (`delivery-reversal.ts:173-201`).

---

## 2. Qué se rompe con dos entregas donde hoy hay una

Se supone el caso mínimo: un pedido de 50 tambos a crédito que sale en dos viajes (30 + 20) con semanas de diferencia; y una OC de 50 que llega en dos recepciones. Familia por familia:

### 2.1 Folios y contadores (patrón A4)

Los contadores son `count(*) + 1` sobre la tabla entera o casi: `FV-` cuenta todas las facturas de cliente, incluidas FI, ATC y NC (`azagro.ts:1541`); `FP-` todas las de proveedor (`:1259`); `FI-` **todas las facturas de la empresa** (`ops.ts:2803`); `PAG-` todos los pagos, contra-pagos y pronto pagos incluidos (`:1770`, `ops.ts:2106`); los siete tipos de kardex comparten un solo contador (`stock.ts:102-105`). Solo `NC-` cuenta su serie (`:1684`). El índice único por serie (`0015_folios_unicos.sql:6-11`) convierte una colisión en error de transacción, no en duplicado. Con parciales, cada pedido produce **N** FV y **N** `ENT/`, cada OC **N** FP y **N** `REC/`: los huecos y saltos que DISENO-INVESTIGACION.md A4 ya documenta (`:169-171`) se multiplican, y si las FV de un mismo pedido llevan una notación de "entrega 2 de 3" o un folio derivado (patrón A2, `PATRONES-DISENO.md:19-30`), no hay contador por serie del cual derivarla. **Se rompe más, no distinto** — por eso va antes (§ 6).

### 2.2 Cartera del cliente

- **Importe de la FV.** `amount = residual = so.total` (`:1548`) y renglones por `sales_lines.qty` (`:1610-1617`). Con la primera entrega parcial la FV cobraría los 50 tambos habiendo salido 30. Es el primer número que deja de ser verdad.
- **Plazo y vencimientos.** `invoice_due`/`credit_due` se calculan **al nacer el pedido**, desde la fecha del pedido: `decideQuote` llama `computeDues({ date: today, … })` (`ops.ts:1643`; `order-terms.ts:9-40`), y `deliverSale` los **copia** (`:1539-1540`). Una FV emitida tres semanas después llevaría el mismo `credit_due` que la primera: su plazo real sería `credit_days − 21`, pero el precio (§ 3) y la foto (`financialDays = so.credit_days`, `:1561`) dirían `credit_days`. Y `changeOrderTerm` solo opera en borrador (`orders.ts:358-366`): confirmado el pedido, nadie puede recalcular plazos.
- **TIIE congelada.** Cada FV toma el renglón vigente **a su fecha de emisión** (`requireRate(tiieTable, today, …)`, `:1571-1575`). Dos FV del mismo pedido pueden traer dos TIIE distintas; es lo que la Decisión 40 ya declaró correcto para la re-entrega, y aplica igual aquí. No se rompe: cambia de una foto por pedido a una por factura.
- **Comisión y tasas congeladas.** `commission_rate`/`cost_rate`/`collection_rate` viven en la cotización y se copian a la foto de cada FV (`:1567-1600`). Dos FV, misma comisión: no se rompe.
- **Política de cobro.** `policy_code` del pedido a cada FV (`:1595-1608`). No se rompe.
- **Comisión + FEGA "una vez".** Se cobran **una vez por factura**, sobre el cargo de esa factura: `computeMora` cobra `capital × fegaRate` si `!fegaAlreadyCharged` (`credit.ts:166`), `computeStatementLine` `cargo × bundle` (`:223-225`), y `issueMoraInvoice` marca `fega_charged` **por factura** (`ops.ts:2818-2822`). `CLAUDE.md` regla 1 dice "3.04 % una vez". Con dos FV vencidas se cobraría dos veces: sobre 30 y sobre 20, que en suma da lo mismo que sobre 50 **solo si las dos vencen**; si el cliente paga una a tiempo y la otra no, el 3.04 % cae sobre una parte. Es dinero y no está decidido (§ 9, pregunta 8).
- **Mora.** Corre por factura desde `credit_due || due_date` (`ops.ts:2392`, `:2707`) sobre el cargo de **esa** factura (`:2393`); la FI se liga por texto `origin = 'Mora ' + FV` (`:2805-2815`). Dos FV → dos relojes, dos FI. Consistente por construcción, pero hereda el problema del `credit_due` copiado del pedido (arriba).
- **Pronto pago.** `earlyPayBonus` usa `issueDate = inv.date`, `cargo = inv.amount` y `financialDays = inv.credit_days || pol.creditDays` (`ops.ts:2094-2103`; `credit.ts:454-471`). Para la segunda FV, `lived` cuenta desde su propia fecha pero `financialDays` es el plazo completo del pedido: bonificaría días que el cliente ya no tenía por delante (su `credit_due` venía de la fecha del pedido). Deja de cuadrar con el plazo real.
- **Devolución.** El abono virtual va a **la última FV** (`:1762-1766`), sin mirar en cuál factura viajó el producto devuelto; el sobrante queda en la NC. Con dos FV vivas, una devolución de la primera entrega descontaría la segunda factura. Y `returnSale` exige `done` (`:1665`): mientras el pedido tenga pendiente, **no se puede devolver lo que ya se entregó**.
- **Límite de crédito.** `saveOrder` al confirmar compara `credit_limit` contra `sum(residual)` de facturas `open` del cliente (`orders.ts:544-556`). Un pedido confirmado y no facturado consume 0; con parciales, consumiría por factura conforme se entregue. No se rompe; cambia el momento. Pregunta 6.

### 2.3 Cartera del proveedor

- **Una FP por OC, no por recepción.** `bornSupplierDebt` regresa `null` si la OC ya tiene FP (`:1229-1235`): la **segunda recepción no crearía deuda** — exactamente lo contrario de la Decisión 28. Y la primera nacería por `po.total` completo (`:1258`), no por lo que llegó: el mismo defecto que la Decisión 14 corrigió, "nomás en chiquito" (palabras de la 28).
- **La prueba fija la idempotencia por OC**: `scripts/erp-fp-al-recibir.test.mjs:56-59` exige `origin = ${opts.poName}` y `if (already[0]) return null;`. Una FP por recepción necesita otra llave de idempotencia (la recepción, no la OC). La prueba verifica que esas cadenas existan; agregar una ruta nueva sin quitar ésa no la rompe, pero **el comportamiento "recibir no duplica deuda"** pasa de "por OC" a "por recepción" y hay que decirlo así en la prueba nueva, no tocar la vieja.
- **La marca "FP de OC sin recibir"** (Decisión 23) se deriva por estado: FP viva cuya OC está `not in ('done','cancelled')` (`azagro.ts:423-431`). Una OC con recepción parcial se queda `confirmed` **con** FP legítima, y esta marca la contaría como FP vieja del defecto. Lector que hay que cambiar.
- **Brokeraje.** En directo la FP nace al entregar (`:1520-1536`, Decisión 29) con la misma idempotencia por OC: una entrega parcial de brokeraje deja la segunda parte sin deuda con el proveedor.

### 2.4 Kardex y costo

- Dos salidas `'delivery'` con el mismo `origin` (`:1503-1511`) y dos entradas `'receipt'` con el mismo `origin` (`:1292-1300`). El kardex las registra bien: `postStock` es por movimiento, verifica existencia por movimiento (`stock.ts:253-258`) y promedia solo entradas. **No se rompe.**
- `deliveredUnitCost` amarra por `origin` + `move_type = 'delivery'` y devuelve el **ponderado de todas** las salidas del pedido y producto (`stock.ts:131-141` → `weightedCost` `:33-46`). Es la Decisión 26 tal cual: con dos salidas a costos distintos, la devolución entra al ponderado por cantidad. **No se rompe; está escrito para esto** (`scripts/erp-devolucion-costo.test.mjs:161`).
- Lo que **no** distingue: cuál de las dos salidas se está revirtiendo (§ 4.4).

### 2.5 Expediente y trazabilidad

`getDealTrail` junta las facturas por `order_id` (`deal.ts:193-205`) y las de la OC por `origin` (`:224-229`): con dos FV y dos FP las lista todas. **No se rompe.** Lo que se pierde es la liga movimiento → entrega: `stock_moves` no guarda id de pedido ni de entrega (`0002:72-84`), y la bitácora `entregar` guarda solo el folio de la FV (`:1619-1627`). Dentro de un año, "¿qué salió en el segundo viaje?" solo se contesta cruzando fechas.

### 2.6 P&L y utilidad por pedido

`computeDealPnl` toma **una sola FV**: `name like 'FV-%' … order by id desc limit 1` (`reports.ts:58-76`). De ahí salen `financialDays` (`:112`), `daysExceeded`, pronto pago (`:345-357`), `fvAmount`/`paidRatio`/`fullyPaid` (`:371-374`). Las partidas usan `sl.qty` completo (`:156`, `:194-195`): venta y costo de 50 aunque hayan salido 30. Con dos FV: la utilidad "en caja" y "proporcional" miran solo la última; la primera, aunque cobrada, no cuenta. La lista por pedido (`:464`) y el Panorama (`:659`) heredan. El P&L de empresa lee facturas directo (`:539-551`) y sí sumaría las dos. **Y la consulta de la FV única está fijada en una prueba**: `scripts/erp-revertir-entrega.test.mjs:159` exige el texto `… name like 'FV-%' … order by id desc limit 1`. Cambiar `computeDealPnl` para sumar N facturas mueve esa prueba: bajo la regla de la red de seguridad, es la señal de parar y hacerlo como función nueva que el motor viejo no toca — se anota en el paso 5 del plan.

### 2.7 Tablero, listas y pantalla

- Pendientes por entregar/recibir ya son por cantidad (`:921-951`): con parciales seguirían mostrando el resto. **No se rompe.**
- El botón "Entregar y facturar" aparece solo con `state === "confirmed"` (`sales.$orderId.tsx:261-264`); revertir entrega, marcar recibido en destino y devolver solo con `done` (`:276-284`, `:665`; `orders.ts:870`). Con un pedido "a medias" ninguna de las cuatro acciones tendría dónde vivir sin decidir el estado intermedio.
- "Recibir" en compras aparece mientras la OC no esté `done` (`purchases.tsx:422-429`); revertir recepción solo con `done` (`:399-400`) — aunque `chainForReceipt` en sí no exige `done` (§ 4.2).

---

## 3. El precio

Cómo se congela hoy, en orden, con lo que cada eslabón supone:

1. **Cotización.** `quotes.credit_days`, `tiie`, `spread`, `commission_rate`, `cost_rate`, `collection_rate` se guardan al crearla (`ops.ts:945-951`). Por partida: `finance_unit` = comisión + Capa 1 a **`plazo` días** (`:976-986`; `pricing.ts:229-241` → `credit.ts:496-512`: `costo × comisión + costo × (1 + comisión) × (TIIE + spread) × días / 360`), y `disbursed_unit` = lo que el financiador desembolsa por unidad (`:983`, ASR: costo × (1 + comisión); lineal: costo + margen, `pricing.ts:144`). **Supone:** una sola salida, financiada `credit_days` completos, desembolsada en un solo momento.
2. **Pedido.** Hereda `credit_days` de la cotización (`ops.ts:1640`) y fija `invoice_due`/`credit_due` desde **la fecha del pedido** (`:1643`; `order-terms.ts:9-40`). El comentario del código lo dice: "el precio a crédito se armó con esos días y por eso quedan como plazo financiero / mora" (`:1633-1639`). **Supone:** que la entrega es el mismo día o cerca.
3. **FV.** Importe `so.total` (`:1548`), vencimientos copiados (`:1539-1540`), `financialDays = credit_days` en la foto (`:1561`, `:1590`). **Supone:** una FV = un pedido = una salida.
4. **P&L.** Reconstruye el costo financiero con `financialDays` de esa foto (`reports.ts:112`, `:208-218`) sobre `landed` de **todas** las partidas (`:194-195`), y `CLAUDE.md` regla 8 exige que ese número coincida con el `finance_unit` que se cobró — hoy coincide por construcción y hay prueba (`scripts/erp-formulas.test.mjs`, `erp-circuito-lineal.test.mjs`).

Con el pedido partido en dos entregas a 21 días de distancia, **estos números dejan de cuadrar, y dónde:**

| Número | Dónde vive | Qué supone | Qué pasa con la segunda entrega |
|---|---|---|---|
| Financiamiento cobrado en el precio, por unidad | `quote_lines.finance_unit` (`ops.ts:993`) | `credit_days` desde el desembolso | Los 20 tambos del segundo viaje se cobraron a `credit_days`; si su `credit_due` viene del pedido, el cliente los tuvo `credit_days − 21` días. Se cobró de más 21 días de Capa 1 sobre 20 tambos. Si en cambio la FV2 corre `credit_days` desde su fecha, se cobró bien pero la mora arranca 21 días después que en la FV1. |
| Base desembolsada | `quote_lines.disbursed_unit` (`:983`) | Un desembolso | Santa Rosa (lineal) desembolsa lo del primer viaje al facturarlo y lo del segundo 21 días después; el `disbursed` congelado no dice cuándo. `computeDealPnl` multiplica `disbursed_unit × sl.qty` completo (`reports.ts:225-236`). |
| Costo financiero real (P&L) | `reports.ts:208-218` (`financeCost` con `financialDays` de la última FV) | Una FV, un plazo | Con dos FV, toma `financialDays` de la última para las 50 unidades. Coincidiría con lo cobrado solo por casualidad. |
| Pronto pago | `ops.ts:2094-2103` (`financialDays: inv.credit_days`) | El plazo de la factura = plazo del pedido | Bonifica sobre `credit_days` desde la fecha de la FV2, más días de los que el `credit_due` copiado permite. |
| Comisión (ASR, 1 % "una vez") | `finance_unit` la incluye una vez por unidad (`credit.ts:508`) | Una operación | Por unidad no cambia. Pero la de cobro (3.04 %, § 2.2) es por factura. |
| `changeOrderTerm` | `orders.ts:358-366`, solo `draft` | Nadie recalcula después de confirmar | No hay camino para rehacer el precio de la parte que sale después. |

No se propone respuesta: es decisión del dueño y la va a ver con números aparte (§ 9, pregunta 1). Lo que este documento fija es **qué** deja de cuadrar y **dónde** está cada número.

---

## 4. Qué candados del bloque de deshacer se abren por atrás

Todos los candados de los pasos 4-8 se escribieron con un movimiento por pedido/OC. Revisados uno por uno:

### 4.1 `cancelChainPreview` / `cancel.ts` — **candado sin salida**

`chainForSale` bloquea si hay **cualquier** movimiento `'delivery'` con `origin` = pedido, cualquier FV viva, o `state = 'done'` (`cancel.ts:211-221`): "Eso no se cancela, se revierte". La reversa de entrega, a su vez, exige `state === "done"` (`delivery-reversal.ts:100`): "no se ha entregado: no hay entrega que revertir". Un pedido con 30 entregados y 20 pendientes queda `confirmed` con un `delivery` vivo: **cancelar dice "revierte", revertir dice "no hay entrega"**. No hay camino para cerrarlo ni para deshacerlo. Es exactamente el patrón B3 de `PATRONES-DISENO.md`, citado literal:

> Para cada acción bloqueada tiene que existir un camino legítimo, y el mensaje tiene que nombrarlo. **Un candado sin salida es peor que el bug que tapa**, porque el bug es silencioso y el candado deja al usuario parado.

Mismo cuadro para la OC: `chainForPurchase` bloquea con cualquier `'receipt'` (`cancel.ts:108-118`); aquí sí hay salida porque `chainForReceipt` **no** exige `done` (solo `cancelled` o "sin entradas", `receipt-reversal.ts:116-118`) — pero la salida es revertir la recepción **completa** (§ 4.3), no cerrar la OC con lo recibido.

Aparte, hallazgo: los mensajes de `cancel.ts:117`, `:148`, `:220` siguen diciendo "todavía no está construido" para revertir recepción, pago y entrega — los tres existen desde los pasos 5, 6 y 7. Igual `delivery-reversal.ts:113` ("revertir esa devolución… no está construido", es el paso 8) y `reversal.ts:136`. Patrón B2: el mensaje debe nombrar el camino, y hoy nombra uno que ya existe como inexistente. No es de este bloque; se anota para el paso 0.

### 4.2 Decisión 33 (solo el último abono / la última devolución viva) — **sigue bien**

`chainForPayment` trabaja **por factura**: un PAG aplica a una sola factura (`reversal.ts:144-150`) y "posterior" se mide entre los abonos vivos de **esa** factura (`:176-193`). Dos FV del mismo pedido tienen abonos independientes: el candado no cruza. `chainForReturn` es LIFO **por pedido** (`return-reversal.ts:110-116`), y el abono virtual se busca por `memo` (`:126-134`): con dos FV sigue determinista porque el abono fue a una sola (`azagro.ts:1762-1766`). Lo que cambia no es el candado sino a qué FV le pegó la devolución (pregunta 7).

### 4.3 Decisión 35 (no se revierte una recepción con salida posterior) — **se vuelve difícil de satisfacer, y la reversa es por OC**

El candado mira, por movimiento de entrada, si salió algo de ese producto desde esa bodega con `id >` (`receipt-reversal.ts:124-136`). Con dos recepciones de la misma OC (REC/10 y REC/12) y una venta entre ellas (ENT/11): revertir REC/12 pasaría; revertir REC/10 se bloquea nombrando ENT/11 — correcto. Pero `chainForReceipt` **no permite elegir**: toma todos los `receipt` vivos de la OC (`:92-114`), y si uno solo se bloquea, `reverseReceipt` rechaza todo (`:249-252`). Además al aplicar pone `qty_received = 0` por producto (`:274-277`), regresa la OC a `confirmed` (`:279`) y revierte **una** FP: el bucle deja `invoiceId` en la última sin abonos (`:189-198`). Con la Decisión 28 (una FP por recepción) se revertirían dos entradas y una sola deuda. **Se abre por atrás.** Salida nombrada ("revierte primero esa salida") existe, pero obliga a deshacer una entrega a cliente para deshacer una recepción de proveedor.

### 4.4 `deliveredUnitCost` con dos salidas — **para la devolución no distingue y no debe; para la reversa sí hace falta**

`deliveredUnitCost` devuelve el ponderado de todas las salidas del pedido y producto (`stock.ts:131-141`): es la Decisión 26 y para la devolución es lo correcto. La reversa de entrega no lo usa: toma los movimientos uno por uno (`delivery-reversal.ts:173-201`) y los revierte **todos** en el mismo clic; luego `qty_delivered = 0` (`:286`) y `confirmed` (`:287`); y la FV a revertir es **la primera** que encuentre con `origin` = pedido (`:128`, `docs.find` sobre una lista `order by i.id`). Con dos FV: se revierten las dos salidas y **una** factura (la primera), la segunda queda viva, el pedido queda `confirmed` con `qty_delivered = 0` y una FV abierta. **Se abre por atrás.** No hay forma de decir "revierte solo el segundo viaje": ni el kardex ni la FV llevan un id de entrega.

### 4.5 `delivery-reversal.ts` completo

- Bloqueo por devolución previa (`:104-115`): correcto, y con dos entregas manda al paso 8 igual.
- Bloqueo por abonos (`:136`): por FV; con dos FV solo mira la que encontró (`:128`) — la segunda podría tener abonos y nadie lo vería.
- FI y ATC por `origin = 'Mora ' + fv.name` (`:140-151`): solo de esa FV.
- FP de brokeraje (`:154-172`): por OC, con la idempotencia de § 2.3.
- Resumen: el módulo entero es "un pedido = una entrega = una FV". Para parciales hace falta la reversa **por entrega** (llave: la FV de esa entrega o un id de entrega), no una adaptación.

### 4.6 `receipt-reversal.ts` completo

Ya cubierto en § 4.3. Mismo diagnóstico: reversa **por recepción**, con su FP (Decisión 28), y `qty_received −= qty` en vez de `= 0`.

### 4.7 `return-reversal.ts` — **sigue bien, con dos notas**

LIFO por pedido (`:110-116`) y bloqueo por salida posterior (`:185-197`) se sostienen. Notas: (a) el contra-abono va a la FV que recibió el abono virtual (`:126-134`), que con dos FV puede no ser la que contenía el producto (pregunta 7); (b) el amarre viejo por producto + cantidad + fecha (`:168-179`) con dos devoluciones de la misma cantidad y fecha sigue siendo el candado sin salida de H4f — no empeora, no mejora.

Cuadro:

| Candado | Con parciales | Salida |
|---|---|---|
| `cancel.ts` pedido con `delivery` (`:211-221`) + `delivery-reversal.ts:100` | **Sin salida** (B3) | Ninguna: cancelar manda a revertir, revertir dice que no hay entrega |
| `cancel.ts` OC con `receipt` (`:108-118`) | Difícil | Revertir la recepción completa (§ 4.3) |
| Decisión 33, pagos (`reversal.ts:144-193`) | Bien | — |
| Decisión 33, devoluciones (`return-reversal.ts:110-116`) | Bien | — |
| Decisión 35 (`receipt-reversal.ts:124-136`) | Se abre por atrás: reversa por OC, una sola FP (`:189-198`, `:274-279`) | "Revierte primero esa salida" (existe, cara) |
| `deliveredUnitCost` (`stock.ts:131-141`) | Bien para devolver (Decisión 26); no sirve para revertir una sola entrega | — |
| `delivery-reversal.ts` (`:128`, `:173-201`, `:286-287`) | Se abre por atrás: revierte todas las salidas y una sola FV | Ninguna hasta que exista reversa por entrega |

---

## 5. El cuadre (patrón A6)

`PATRONES-DISENO.md` A6, literal:

> Si el sistema recibe cien unidades, tiene que poder decir dónde quedaron las cien. Cada unidad cae en exactamente una casilla, y el documento imprime el cuadre […] Y hay un candado: **si quedan unidades sin clasificar, no se emite el documento.**

Hoy la identidad se cumple sola porque todo es `= qty` (§ 1). En cuanto exista una cantidad parcial, es lo único que atrapa un error de cantidad (decisión del dueño: va en este bloque). La identidad exacta, por partida y en cantidades, con lo que ya existe en la base:

**Pedido de venta (`sales_lines`)**

```
qty = entregada_viva + pendiente
entregada_viva = Σ stock_moves 'delivery' (origin = pedido, producto) − Σ 'reversal' que las liga (reverses_id)
entregada_viva = qty_delivered                                   ← hoy: = qty o 0
devuelta = Σ stock_moves 'return' (origin = NC del pedido) − Σ 'reversal' que las liga
devuelta = qty_returned
facturada_viva = Σ invoice_lines.qty de FV vivas del pedido (state ≠ 'reversed', reverses_id nulo)
facturada_viva = entregada_viva                                    ← hoy: = qty, aunque no haya salido nada (§ 2.2)
```

Y la casilla que hoy no existe: **`cerrada_corta`** — cantidad que ya nunca va a salir (pregunta 5). Sin esa casilla, `pendiente` nunca llega a cero en una entrega corta y el pedido no puede cerrarse; con ella, `qty = entregada_viva + pendiente + cerrada_corta`.

**Orden de compra (`purchase_lines`)**

```
qty = recibida_viva + pendiente (+ cerrada_corta, pregunta 4)
recibida_viva = Σ stock_moves 'receipt' (origin = OC, producto) − Σ 'reversal' ligadas
recibida_viva = qty_received
Σ FP vivas de la OC (importe) = Σ recibida_viva × unit_price      ← Decisión 28; hoy: po.total al primer recibo (§ 2.3)
```

En directo/brokeraje no hay kardex: `entregada_viva = qty_delivered` sin la línea del kardex, y la FP nace con la entrega (Decisión 29).

**Los dos candados que faltan:** (a) **no se emite una FV** cuyos renglones no sean exactamente lo entregado y no facturado (`Σ invoice_lines.qty` de la nueva = `entregada_viva − facturada_viva` por producto); (b) **no se cierra** un pedido ni una OC con `pendiente ≠ 0` salvo por la casilla `cerrada_corta`, capturada a mano con motivo (patrón A5: motivo obligatorio, sin default). Para la FP el candado es la Decisión 28 misma: importe = lo recibido en **esa** recepción.

**Dónde entra en el plan:** la identidad como función pura, su prueba sobre datos de hoy (todo-o-nada: debe dar cero en cada partida) y su panel al lado del cuadre kardex-vs-existencia que ya existe (`azagro.ts:954-986`, `inventory.tsx:137-142`) van en el **paso 0**, sin cambiar comportamiento. Los dos candados van **donde nace cada documento**: el (a) en el paso 3 (FV), la Decisión 28 en el paso 1 (FP), el (b) en el paso 7 (cierre corto). Así, el día que se construya la primera recepción parcial, el cuadre ya está vigilando.

---

## 6. Qué hay que hacer antes: A4 y C4

El dueño decidió que el patrón A4 (contador por serie) y el C4 (borrado de datos de prueba) se arreglan **antes**. Contra el código:

**A4 — confirmado, con este matiz.** Nada en el código de parciales *depende* de un contador por serie: los folios se seguirían generando con `count(*) + 1` (§ 2.1) y el índice único (`0015:6-11`) seguiría convirtiendo la colisión en error. Pero el orden es el correcto por tres razones verificables: (1) este bloque **multiplica documentos en las series compartidas** — N FV por pedido (`:1541`), N FP por OC (`:1259`), N `ENT/`/`REC/` en el contador único del kardex (`stock.ts:103`) —, así que cada hueco que hoy salta uno saltará N; (2) si las FV parciales van a decir "entrega 2 de 3" o a derivar folio del pedido (A2 no aplica tal cual: no son correcciones, son hermanas), esa notación necesita un contador **de la serie**, no de la tabla; (3) `FI-` cuenta **todas** las facturas (`ops.ts:2803`), y con el doble de FV y FP la serie de intereses salta el doble. Arreglar el contador antes de multiplicar lo que cuenta es más barato que después. **Orden correcto.**

**C4 — confirmado como prerrequisito operativo, no de código.** Dos hechos: (1) las pruebas automáticas **no tocan producción**: `scripts/migrations-apply.test.mjs` levanta PGlite en memoria (`:12`, `:18`, `:78`, …) y ningún `erp-*.test.mjs` lee `DATABASE_URL` (solo `with-app-env.test.mjs`). Lo que llega a la base real es la **prueba en el navegador de Miguel** (`METODOLOGIA-TRABAJO.md` § 3 paso 5). (2) Probar parciales en producción deja, por cada caso, un pedido con dos FV, una OC con N FP, N movimientos de kardex y sus reversas — y no hay cómo borrarlos (`ESTADO.md` § 4.15; DISENO-INVESTIGACION.md `:230`); el precedente son PV-0003 y PV-0004, que siguen en la base desde el 5-sep (`ESTADO.md` § H4b, nota). Este bloque es el que más documentos por caso de prueba genera de todos los construidos. **Orden correcto**, por esa razón y no por las pruebas automáticas. Nota aparte: `METODOLOGIA-TRABAJO.md` § 3 paso 6 dice que Claude Code "corre sus pruebas contra la misma base de producción"; los scripts de hoy no lo hacen. Se reporta, no se corrige aquí (§ 10).

---

## 7. Los casos raros

1. **Pedido a medias y luego "ya no va a salir el resto".** Sin la casilla `cerrada_corta` (§ 5) el pedido no cierra nunca: `state` no llega a `done`, el tablero lo cuenta pendiente (`:386-387`), la devolución no se puede registrar (`:1665`) y cancelar/revertir se bloquean entre sí (§ 4.1). Es el caso que convierte el candado en definitivo.
2. **Segunda entrega con TIIE distinta.** Cada FV toma la tasa de su fecha (`:1571-1575`). Correcto por Decisión 40; hay que decirlo en pantalla cuando dos facturas del mismo pedido traigan tasas distintas, igual que ahí.
3. **Devolución de la primera entrega cuando ya existe la segunda FV.** El abono virtual cae en la última FV (`:1762-1766`). Si esa FV es de otra mercancía, el estado de cuenta muestra descontada la factura equivocada. Pregunta 7.
4. **Brokeraje parcial.** Sin kardex; la FP nace al entregar por OC (`:1520-1536`) con idempotencia por OC (`:1229-1235`): la segunda parte no genera deuda. Decisiones 28 + 29 lo resuelven juntas (una FP por entrega parcial), pero hay que escribirlo.
5. **Recepción parcial de una OC que vino de cotización con pedido confirmado.** `cancelChainPreview` del pedido baja a las OC hijas (`cancel.ts:240-249`); una OC con `receipt` vivo bloquea la cadena entera del pedido aunque el pedido no se haya entregado (`:108-118`). Con parciales, un pedido confirmado cuya OC recibió la mitad no se puede cancelar sin revertir esa mitad.
6. **Cobro de la FV1 y después reversa de la entrega 1.** Primero el paso 5 (`delivery-reversal.ts:136`): sigue siendo el orden correcto; solo que hoy el bloqueo mira una FV (§ 4.5).
7. **Dos devoluciones de la misma cantidad y fecha sobre dos entregas** con `return` viejo: el amarre por producto + cantidad + fecha (`return-reversal.ts:168-182`) se bloquea (H4f). No empeora con parciales porque desde la Decisión 42 el `return` lleva el folio de la NC.
8. **Concurrencia.** `deliverSale` y `receivePurchase` bloquean la cabecera `for update` (`:1470-1489`, `:1276-1280`); dos entregas parciales simultáneas del mismo pedido se serializan. No se rompe.
9. **Corte de Compaq.** Las facturas importadas tienen `cutover_key` y ningún pedido (`cutover.ts`); no las toca nada de esto.

---

## 8. Plan por pasos

El dueño recuerda el plan anterior como **siete** pasos, con 0, 1 y 2 posibles con las Decisiones 26, 28 y 42 y del 3 en adelante esperando respuestas. Contra el código salen **ocho** (0 a 7): coinciden en que 0, 1 y 2 se pueden hacer ya y en que del 3 en adelante todo espera al dueño; la diferencia es que el **cierre corto** (pedido u OC con cantidad que ya nunca va a salir) sale como paso propio, porque lo gatean dos preguntas distintas (4 y 5), es el único que agrega una casilla nueva a la identidad de § 5, y es el que destraba el candado sin salida de § 4.1. Cada paso deja el sistema funcionando y las 577 en verde.

| Paso | Qué | Toca | Tamaño | Puede hacerse con |
|---|---|---|---|---|
| **0** | **Cimientos sin cambiar comportamiento.** (a) El cuadre de § 5 como función pura + prueba sobre datos de hoy (cero en cada partida) + panel junto al cuadre kardex-vs-existencia. (b) Migración aditiva: `qty_returned` **en migración** (hoy solo por `alter` en tiempo de ejecución, `azagro.ts:1643`), y la liga que hoy no existe: qué movimiento de kardex y qué FV pertenecen a **cuál** entrega/recepción (columna nullable en `stock_moves` e `invoices`, sin tocar lo existente — hoy todo es "la única"). (c) Los cinco mensajes "todavía no está construido" (`cancel.ts:117,148,220`; `delivery-reversal.ts:113`; `reversal.ts:136`) pasan a nombrar el paso que ya existe (B2). | Nada (lectura + columnas nulas) | Mediano | Lo ya decidido |
| **1** | **Recepción parcial y una FP por recepción (Decisión 28).** `receivePurchase` acepta cantidad por partida; `qty_received += qty`; la OC queda `confirmed` con pendiente y pasa a `done` solo al completar; `postStock` por lo recibido con la liga del paso 0; `bornSupplierDebt` deja de ser idempotente por OC y pasa a serlo **por recepción** (llave: la recepción, patrón de la Decisión 42), importe = lo recibido × precio, plazo desde esa fecha; la marca "FP de OC sin recibir" (`:423-431`) deja de mirar `po.state` y mira si la FP tiene su recepción. Brokeraje parcial: Decisiones 28 + 29. Prueba nueva; `erp-fp-al-recibir.test.mjs` no se toca. | Inventario + cartera de proveedor | Mediano | Decisiones 28, 29, 30, 42 |
| **2** | **Reversa de recepción por recepción.** `chainForReceipt` recibe la recepción (no la OC): sus movimientos, su FP; Decisión 35 por movimiento; `qty_received −= qty`; la OC vuelve a `confirmed` si quedó algo, no siempre. `receipt-reversal.ts` de hoy se queda para las OC de una sola recepción (misma salida al centavo, prueba de identidad). | Inventario + cartera de proveedor | Mediano | Decisiones 20, 28, 35, 36 |
| **3** | **Entrega parcial con su FV.** `deliverSale` acepta cantidad por partida; `qty_delivered += qty`; pedido `confirmed` con pendiente; FV por lo entregado (importe y renglones = esa entrega, candado (a) de § 5), con las fechas y el plazo que diga la **pregunta 1** y en el momento que diga la **pregunta 2**; foto con los días reales; quién puede entregar y quién facturar según la **pregunta 3**. Directo/brokeraje: FP por entrega (paso 1). | Inventario + cartera de cliente | Grande | **Espera preguntas 1, 2, 3** |
| **4** | **Reversa de entrega por entrega.** `chainForDelivery` recibe la entrega (su FV, sus salidas, su FI/ATC); `qty_delivered −= qty`; el pedido vuelve a `confirmed` siempre (ya lo estaba si había pendiente); y `cancel.ts` deja de bloquear por "cualquier `delivery`": un pedido con pendiente se cancela **por el pendiente** (paso 7) o se revierten sus entregas una por una. Cierra el candado de § 4.1. | Inventario + cartera de cliente | Grande | Paso 3 + **pregunta 5** (qué pasa con el pendiente al cancelar) |
| **5** | **Devolución y P&L con N facturas.** `returnSale` deja de exigir `done` (basta `qty_delivered > 0`) y aplica el abono a la FV que diga la **pregunta 7**; `computeDealPnl` suma las FV vivas del pedido y usa lo entregado, no `sl.qty` — como **función nueva**: la consulta de una sola FV está fijada en `erp-revertir-entrega.test.mjs:159` y esa prueba no se toca; el motor viejo sigue dando lo mismo para pedidos de una entrega (identidad al centavo, +1,000 casos). Comisión + FEGA por factura o por pedido según la **pregunta 8**. | Cartera + reportes | Mediano | Paso 3 + **preguntas 7, 8** |
| **6** | **Límite de crédito por partes.** Según la **pregunta 6**: seguir consumiendo por factura (hoy, `orders.ts:544-556`) o consumir el pedido confirmado y liberar conforme factura. Permisos H4e si la pregunta 3 separa entregar de facturar (uno de los dos caminos ya escritos en `ESTADO.md` H4e). | Cartera + permisos | Chico–mediano | **Preguntas 3, 6** |
| **7** | **Cierre corto.** La casilla `cerrada_corta` de § 5 en pedido y OC, con motivo obligatorio (A5) y bitácora; el pedido/OC pasa a `done` cuando `pendiente = 0` contando lo cerrado; el candado (b) de § 5. Destraba definitivamente § 4.1 y el caso raro 1. | Nada de dinero: estados y cantidades | Chico | **Preguntas 4 y 5** |

**Dependencias duras:** 0 → todo; 1 → 2; 3 → 4 y 5; 1 y 3 → 7; **A4 antes de 1 y 3** (son los que multiplican folios); **C4 antes de la prueba en producción de cualquiera** (§ 6). Los pasos 0, 1 y 2 se pueden construir ya. Del 3 al 7, cada uno nombra la pregunta que lo gatea.

**Fuera de este bloque, pero lo tocan:** el anticipo (Decisión 12) cambia qué hace un cobro de más sobre una FV parcial; la mora proporcional en devolución (Decisión 10) vive en `returnSale` y con N FV tendrá que decir de cuál FI; la Fase 3 del financiamiento (reparto de mora, `ESTADO.md` 1.6) no se toca aquí.

---

## 9. Las preguntas para el dueño

El dueño recuerda seis, una de dinero. Contra el código son **ocho**: las seis se confirman (ninguna está contestada en `DECISIONES.md`; la 28 contesta solo la mitad de proveedor de la 4, y la 29 la extiende a brokeraje), y salen dos más, una de ellas también de dinero. Redactadas en lenguaje simple:

1. **(Dinero) Cuando un pedido a crédito sale en dos viajes con semanas de diferencia, ¿el precio se queda como se cotizó, o se recalcula la parte que sale después?** Hoy el precio incluye el costo de financiar todo el pedido por todos los días del plazo, contados desde el día del pedido. La mercancía del segundo viaje la tiene el cliente menos días de los que pagó. Va junto: **¿el plazo de cada factura corre desde el día de su entrega, o todas corren desde el día del pedido?** (§ 3; los números se ven aparte.)
   **CONTESTADA (Decisión 54, 9-sep-2026):** el plazo de cada factura arranca el mismo día que el costo con Santa Rosa — no desde el día del pedido. Queda **pendiente el dato de negocio** que aterriza la regla (si Santa Rosa desembolsa por pedido o por entrega): `ESTADO.md` § 4.16.
2. **¿Una factura por cada entrega, o una sola factura cuando se complete el pedido?** Y las dos mitades: **¿se puede entregar sin facturar? ¿se puede facturar sin entregar?** Hoy entregar y facturar son un solo clic (§ 1.3).
   **CONTESTADA (Decisiones 46 y 47, 9-sep-2026):** una factura por cada entrega; se puede entregar sin facturar, no se puede facturar sin entregar.
3. **¿Quién entrega y quién factura?** Hoy almacén puede hacer las dos cosas y además editar el pedido entero, porque su permiso de ventas es completo (`acl.ts:152-158`; `ESTADO.md` H4e, abierta). Si entregar y facturar se separan, hay que elegir uno de los dos caminos que H4e ya tiene escritos: un nivel de permiso nuevo "solo entregar", o una bandera aparte.
   **CONTESTADA (Decisión 48, 9-sep-2026):** camino (a) de H4e — permiso nuevo "solo entregar" para almacén; facturar y editar el pedido quedan fuera.
4. **Recepción parcial: cuando el proveedor manda 20 de 50, ¿la orden queda abierta hasta que llegue el resto, o se puede cerrar con lo que llegó y dar el resto por perdido?** La deuda con el proveedor ya está decidida: crece con cada recepción (Decisión 28). Lo que falta es qué pasa con la orden.
   **CONTESTADA (Decisión 49, 9-sep-2026):** se puede cerrar con lo recibido, a mano y con motivo obligatorio; no se cierra sola.
5. **Entrega corta: ¿se puede cerrar un pedido con cantidad pendiente que ya nunca va a salir?** Y si sí, ¿qué pasa con lo que ya se entregó y facturó — se queda tal cual? Sin esto, un pedido a medias no se puede ni cerrar ni cancelar (§ 4.1).
   **CONTESTADA (Decisión 50, 9-sep-2026):** se puede cerrar con motivo obligatorio; lo ya entregado y facturado queda intacto.
6. **Límite de crédito: hoy un pedido confirmado no consume línea hasta que se factura. Con entregas por partes, ¿el límite se consume por partes, conforme se factura cada una, o se aparta completo al confirmar el pedido?**
   **CONTESTADA (Decisión 51, 9-sep-2026):** se aparta completo al confirmar el pedido y se convierte en deuda real conforme se factura.
7. **(Nueva) Si un pedido tiene dos facturas y el cliente devuelve mercancía, ¿a cuál factura se le descuenta?** Hoy se descuenta siempre a la última (`azagro.ts:1762-1766`), sin mirar en cuál viajó el producto. Opciones reales: la factura donde viajó el producto; la que la persona elija (el sistema propone, como en la Decisión 13); la última, como hoy.
   **CONTESTADA (Decisión 52, 9-sep-2026):** el sistema propone la factura donde viajó el producto y la persona confirma o cambia; si viajó en más de una, pregunta.
8. **(Nueva, dinero) La comisión y el FEGA (3.04 %) se cobran "una vez" cuando una factura vence. Con dos facturas del mismo pedido, ¿se cobran una vez por pedido o una vez por factura?** Hoy es por factura (`credit.ts:166`, `:223-225`; `ops.ts:2818-2822`): si vencen las dos, suma lo mismo que una vez sobre el total; si vence solo una, se cobra sobre una parte.
   **CONTESTADA (Decisión 53, 9-sep-2026):** por factura, sin cambio — medido contra el libro 2025, cobrarlo por pedido completo daría ~$74,600 más al año (9.7 % de la utilidad), y el dueño lo declinó a propósito.

**Las ocho, contestadas el 9-sep-2026** (Decisiones 46 a 54 en `DECISIONES.md`; la 54 amarra la 1 y deja abierta `ESTADO.md` § 4.16). H4d y H4e (`ESTADO.md`) se cerraron con ellas. Ninguna está construida — el plan sigue siendo § 8.

---

## 10. Lo que no se pudo verificar, y hallazgos fuera de alcance

**No verificado (no se abrió la base, no se abrió el navegador):**
- Si en la base hay algún pedido u OC en estado intermedio. Por construcción no puede haberlo (§ 1.5); no se comprobó con datos.
- Cómo se ven hoy en pantalla las condiciones citadas de `sales.$orderId.tsx` y `purchases.tsx`: se leyeron del código, no se renderizaron.
- Si Santa Rosa, en la operación real, desembolsa por entrega o por pedido. Es dato del negocio, no del código; entra en la pregunta 1.
- Los modos `date` y `harvest` de `computeDues` (`order-terms.ts:21-33`) se leyeron pero no se siguieron con un caso: la conclusión de § 2.2 sobre vencimientos copiados del pedido aplica a `credit_days`, que es el que usa `decideQuote`.

**Hallazgos aparte, no de este bloque, no corregidos:**
- `sales_lines.qty_returned` no existe en ninguna migración; nace por `alter table` en dos funciones (`azagro.ts:1643`, `orders.ts:179`). Va al paso 0.
- Cinco mensajes de bloqueo nombran como "todavía no construido" algo que ya existe (`cancel.ts:117,148,220`, `delivery-reversal.ts:113`, `reversal.ts:136`). Patrón B2. Va al paso 0.
- `METODOLOGIA-TRABAJO.md` § 3 paso 6 afirma que las pruebas corren contra la base de producción; los scripts de hoy usan PGlite en memoria (`scripts/migrations-apply.test.mjs:12,18`). El aviso del deploy sigue siendo válido por la prueba en navegador, no por las pruebas automáticas. Se reporta para corregir el documento del método en su momento.
