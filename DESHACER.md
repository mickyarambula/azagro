# BLOQUE DE DESHACER — diagnóstico y plan

**Fecha:** 7-sep-2026 · **Base:** `main` en `3a84976` · **Alcance:** solo diagnóstico y plan, nada construido.
**Gobierna:** Decisiones 15 y 16 (`DECISIONES.md`) y el principio que las une: *el sistema no borra y no decide solo; deja rastro y le pregunta a la persona.* Las Decisiones 9 y 14 entran como requisitos de este bloque (abajo se explica por qué); 10 a 13 son otro bloque y solo se mencionan donde chocan con éste.
**Método:** cada afirmación se verificó con `grep`/`sed` sobre el código de hoy; se cita `archivo:línea`. Lo que no se pudo verificar no está.

---

## 1. Qué mueve cada documento cuando se emite

Tres cosas pueden moverse: **inventario** (`stock_moves` → proyección `stock_quants` y `products.cost`), **cartera** (un renglón en `invoices`, o un `payments`/`payment_allocs` que cambia un saldo) y **banco** (`bank_moves`). Todo lo demás es captura que no mueve nada.

| Documento | Función | Inventario | Cartera | Banco | Qué escribe exactamente |
|---|---|---|---|---|---|
| **Solicitud** | `createRequest` `requests.ts:420,427` | — | — | — | `customer_requests` + `customer_request_lines`. Sus pasos internos solo tocan la misma solicitud: proveedor y RFQ (`sendVendorRfq` `:597-618`, `pickVendor` `:655`, `applyCheapest` `:792`, `saveLineMargin` `:736-743`, `saveLineFreight` `:821`, `saveRequestTerms` `:379`). **Único borrado duro del sistema:** `deleteRequest` `:548-550` borra la solicitud y su RFQ de verdad (con bitácora). |
| **Cotización** | `createQuote` `ops.ts:943,985` · `quoteFromRequest` `requests.ts:1041,1050` (+ `customer_requests.quote_id`/`state='quoted'` `:1062`) · `duplicateQuote` `ops.ts:1187,1196` | — | — | — | `quotes` + `quote_lines`. Ojo: **`reviseQuote` escribe dentro de un pedido en borrador** — precio de `sales_lines` `ops.ts:1503`, partidas nuevas `:1509`, `sales_orders.total` `:1519`. Rechazar solo cambia `quotes.state` `:1584`. |
| **Pedido** | `decideQuote` (aceptar) `ops.ts:1650,1666` → `state='draft'`; `saveOrder` `orders.ts:697,718` (directo) y confirmar `:580,690`; `convertCustomerPO` `cpo.ts:199,215` | — | **Sí, si vino de solicitud**: al aceptar nacen `purchase_orders` `ops.ts:1704` ya `'confirmed'`, `purchase_lines` `:1711` **y la FP** `:1727` (cartera de proveedor). | — | El pedido en sí no mueve nada. Confirmar solo **lee** cartera para el límite de crédito (`orders.ts:545-551`, `sum(residual)` de `invoices` `state='open'`). |
| **Orden de compra** | `createPurchase` `azagro.ts:1135,1143` · `applyRfqWinners` `rfq.ts:284,293` · (auto desde `decideQuote`, arriba) | — | **Sí: la FP nace con la OC** — `azagro.ts:1159`, `rfq.ts:311`, `ops.ts:1727` | — | Éste es el defecto que la Decisión 14 corrige: la deuda existe antes de tener la mercancía. `createPurchase`, `decideQuote` y `applyRfqWinners` **no van en `withTx`**. |
| **Recepción** | `receivePurchase` `azagro.ts:1174-1240` (`withTx`) | **Sí**: `postStock` `'receipt'` `:1196` al precio de la OC → `stock_moves` `stock.ts:200-207`, `stock_quants` `:210-222` (promedio móvil `:218-221`), `products.cost` `:115` | Solo si **no existía** FP (`:1211-1231`) — hoy casi nunca, porque ya nació con la OC | — | `purchase_lines.qty_received = qty` `:1206`, `purchase_orders.state='done'` `:1208`. Todo o nada. OC directa/brokeraje no se recibe (`:1188`). |
| **Entrega + Factura de cliente** | `deliverSale` `azagro.ts:1386-1530` (`withTx`) | **Sí**: `postStock` `'delivery'` `:1425` — **salvo** `route_kind` `supplier`/`asr` (directo), que no mueve nada `:1420` | **Sí**: nace la **FV** `:1496` con `invoice_lines` `:1515`, `params_snap`, `order_id` | — | `sales_lines.qty_delivered = qty` `:1435`, `sales_orders.state='done'` `:1437`. **Entregar y facturar son un solo acto**: no hay FV sin entrega ni entrega sin FV. Exige pedido `'confirmed'` `:1416`. |
| **Factura de cliente — las otras** | FI: `issueMoraInvoice` `ops.ts:2738-2748` · ATC: `applyInvoicePayment` `:1985` · NC: `returnSale` (abajo) · Corte: `applyOpenInvoices` `cutover.ts:202` | — | **Sí** | — | La FI además **escribe sobre la FV origen**: `interest_invoiced += …`, `fega_charged` `ops.ts:2751-2755`. Se liga a su FV por **texto**: `origin = "Mora " + nombre` `:2744` (y así se lee, `:2375`) más `order_id`. ATC igual: `origin = "Ajuste TC " + nombre` `:1988` y `fx_invoiced` en la FV `:1997`. |
| **Factura de proveedor (FP)** | `createPurchase` `azagro.ts:1159` · `decideQuote` `ops.ts:1727` · `applyRfqWinners` `rfq.ts:311` · respaldo en `receivePurchase` `azagro.ts:1228` | — | **Sí** | — | Se liga a su OC por texto: `origin = nombre de la OC`. |
| **Nota de crédito (devolución)** | `returnSale` `azagro.ts:1532-1662` (`withTx`) | **Sí**: `postStock` `'return'` `:1590` **sin `unitCost`** → entra al promedio de hoy (`stock.ts:192-195`) — lo que la Decisión 9 cambia | **Sí, y dos veces**: la NC en negativo `:1611,1625` **y un PAG virtual** `:1641` con `payment_allocs` contra la FV `:1645` + `refreshInvoiceResidual` `:1646` | **No** — ese PAG no tiene `bank_move` | `sales_lines.qty_returned +=` `:1602`; NC `residual`/`state` `:1650,1652`. Solo con pedido `'done'` `:1565`. |
| **Pago / cobro** | `applyInvoicePayment` `ops.ts:~1870-2080`, llamado por `registerPayment` `azagro.ts:1836` (`withTx`) y `addBankMove` `ops.ts:2128` (`withTx`) | — | **Sí**: `payments` `:1948`, `payment_allocs` `:1953`, saldo `:1956`; puede crear **hasta tres documentos más en el mismo clic**: FI `:1936`, PAG de pronto pago `:2050-2055`, ATC `:1985` (o `fx_result` `:1993`), y escribe `fx_paid/fx_treatment/fx_invoiced` `:1997` y `paid_date` `:2070` | **Sí**: `bank_moves` `:1964`, ligado por `invoice_id` y `payment_id` | Un cobro es el documento que más cosas mueve de un solo golpe. |

**También mueven, y no estaban en tu lista:** gasto en efectivo (`createExpense` `expenses.ts:168` + `bank_moves` `:177`, sin `withTx`), ajuste y traslado de inventario (`adjustStock` `azagro.ts:1002`, `transferStock` `:966`, ambos `withTx`), movimiento de banco suelto (`addBankMove` `ops.ts:2154,2161`), conciliación (`reconcileMove` `:2177` alterna `reconciled`), y el corte (`applyStockSnap` `cutover.ts:311`).

**Cómo se ligan entre sí (esto decide hasta dónde llega una reversa):** FV→pedido por `invoices.order_id`; FI→FV y ATC→FV **por texto** (`origin`) + `order_id`; NC→pedido por `order_id` + `origin`; PAG→factura por `payment_allocs`; banco→PAG por `bank_moves.payment_id` y →factura por `invoice_id`; FP→OC **por texto** (`origin`); movimientos de inventario→pedido/OC **por texto** (`stock_moves.origin`), sin id; OC→pedido por `purchase_orders.so_id`; pedido→cotización por `quote_id`; cotización→solicitud por `request_id` / `customer_requests.quote_id`. El expediente (`deal.ts:26-44`) rellena estas ligas por nombre cuando faltan. **Tres ligas son texto, no llave**: FI, ATC y FP. Una reversa que las siga tiene que buscar por nombre.

---

## 2. Qué tan lejos llega cada reversa

La regla de Decisión 15: lo que no movió nada se **cancela** (se marca, se conserva); lo que movió inventario o cartera se **revierte** (movimiento contrario, quedan los dos). La regla de Decisión 16: nunca se borra un movimiento de dinero.

### 2.1 Revertir un PAGO (Decisión 16)
Contrario: un PAG con signo contrario + `payment_allocs` contrario + `bank_moves` contrario. `refreshInvoiceResidual` ya sabe reabrir la factura sola: recalcula el saldo como `amount − opening_paid − sum(allocs)` y regresa `state='open'` (`stock.ts:256-281`). **Cadena:**
- Si ese cobro **bonificó pronto pago** (`ops.ts:2050-2055`, segundo PAG condicionado a este): se revierte también. Se corta ahí.
- Si ese cobro generó **ATC** (`:1985`) o sumó a `fx_result` (`:1993`): se revierte el ATC (contra-ATC) o se resta el `fx_result`, y se limpian `fx_paid/fx_treatment/fx_invoiced` (`:1997`).
- Si ese cobro **facturó mora** en el mismo clic (`:1936`): **la FI se queda** — el interés hasta esa fecha era real y `interest_invoiced` ya lo acumuló (`:2751`); el siguiente cobro factura el interés de ahí en adelante. Es donde se corta la cadena. (Pregunta 5 al dueño, abajo.)
- **Hueco confirmado:** al reabrir, `refreshInvoiceResidual` **no limpia `paid_date`** (`stock.ts:279` solo toca `residual` y `state`). `paid_date` la leen la mora (`ops.ts` estado de cuenta) y el P&L (`reports.ts:25,129,134,345`) como fin de los días vencidos: un pago revertido dejaría una factura "abierta" pero con fecha de pago, y el interés dejaría de correr. La reversa tiene que ponerla en nulo.
- Si el movimiento de banco ya estaba **conciliado** (`reconciled`, `ops.ts:2177`): el contrario nace sin conciliar; el estado de cuenta del banco queda con un conciliado y un no conciliado (pregunta 6).

### 2.2 Revertir una ENTREGA (y con ella la FV — son un solo acto)
Contrario: movimiento de inventario de entrada por la cantidad entregada **al `unit_cost` del movimiento original** (`stock_moves.unit_cost` guarda el costo de cada salida, `stock.ts:203`, así que Decisión 9 ya tiene de dónde leerlo); `sales_lines.qty_delivered` de regreso; `sales_orders` de `'done'` a `'confirmed'`; factura contraria a la FV. **Cadena, en este orden:**
1. **Si la FV tiene pagos** (`payment_allocs`): primero 2.1 por cada uno, o se rechaza con mensaje. No se revierte una factura cobrada por encima de sus cobros.
2. **Si la FV tiene FI** (mora facturada, `origin = "Mora " + FV`): contra-FI por el total — si la entrega no existió, la mora tampoco. Decisión 10 (proporcional) es para devoluciones parciales, no para esto.
3. **Si la FV tiene ATC**: contra-ATC.
4. **Si el pedido ya tuvo una devolución parcial** (NC + PAG virtual `azagro.ts:1641-1646`): la mercancía devuelta ya está en bodega; la reversa solo reingresa `qty_delivered − qty_returned`. En cartera hay que contrariar la NC **y** su PAG virtual, o la FV revertida se queda con un abono colgado. Son seis documentos en cadena. Se puede, pero es el caso más enredado — ver § 4.
5. Si el pedido es **directo / brokeraje** (`route_kind` `supplier`/`asr`): no hubo movimiento de inventario (`:1421`), la reversa es solo de cartera.
6. El pedido regresa a `'confirmed'`, **no** a borrador: sus OC ya existen.

### 2.3 Revertir una RECEPCIÓN
Contrario: movimiento de **salida** de la bodega por lo recibido, al `unit_cost` de la entrada; `purchase_lines.qty_received` de regreso; `purchase_orders` de `'done'` a `'confirmed'`. **Cadena:**
- **Si la mercancía ya salió** (se entregó o se trasladó): `postStock` lo **bloquea** — `have + 0.0001 < qty` → "Stock insuficiente" (`stock.ts:182-189`). No hay salida limpia y no debe inventarse: se rechaza con mensaje, y la única forma es revertir primero lo que la sacó. Es el corte correcto.
- **Promedio móvil**: una salida **no** recompone el promedio (`stock.ts:212-214`: la salida conserva `prev.avg`; solo las entradas promedian `:218-221`; `products.cost` se rehace con lo que queda `:102-117`). Ejemplo: 10 TM a $9,000 en bodega, entran 25 TM a $9,500 → promedio $9,357. Se revierte la entrada: quedan 10 TM **a $9,357**, no a $9,000. La contaminación se queda. Si se quiere que quede "como si nunca hubiera entrado", el promedio hay que **recalcularlo reproduciendo el kardex** sin el par original/reversa — es deterministic, pero es la pieza más grande de este bloque (pregunta 4).
- **FP**: hoy la FP nació con la OC, no con la recepción, así que revertir la recepción **no la toca** (la deuda sigue viva aunque la mercancía no esté — el mismo defecto de L6 visto de regreso). Cuando se construya Decisión 14 (FP al recibir), la reversa de la recepción arrastra la FP: contra-FP si está sin pagar; si ya se pagó, primero 2.1.

### 2.4 Revertir una FP sola (proveedor)
Contra-FP. Si tiene pagos (`outbound` + `bank_moves`), primero 2.1. Se corta ahí. **No hay serie para el documento contrario**: no existe NC de proveedor (H4c sigue abierta) — pregunta 3.

### 2.5 Revertir una DEVOLUCIÓN (NC)
Contrario: salida de bodega por lo devuelto al `unit_cost` del movimiento `'return'`; `sales_lines.qty_returned` de regreso; contra-NC; contrariar el PAG virtual y su alloc (`azagro.ts:1641-1646`) para que el saldo de la FV vuelva a subir. Si después de la NC alguien cobró el resto de la FV, la cadena se cruza con 2.1.

### 2.6 CANCELAR (sin movimiento)
- **Solicitud**: hoy se **borra** (`deleteRequest` `requests.ts:548-550`, borrado duro con bitácora). Decisión 15 dice "se marca cancelada, se conserva, nunca se borra": el borrado duro tiene que irse.
- **Cotización** viva o vencida: marcar cancelada; si es la ligada a una solicitud, la solicitud se libera igual que con una rechazada (`quoteStillBlocks`, `request-lock.ts` — mismo candado, un estado más).
- **Pedido en borrador**: marcar cancelado. Si vino de cotización, **la cotización quedó `'accepted'`** (`ops.ts:1677`) y **ya nacieron OC `'confirmed'` con FP** (`:1704-1727`): cancelar el pedido en borrador obliga a cancelar en cascada esas OC y a contrariar esas FP (hasta que la Decisión 14 las mueva a la recepción). Y hay que decidir qué pasa con la cotización (pregunta 2).
- **OC confirmada sin recibir**: hoy **sí movió cartera** (la FP), así que por Decisión 15 no se cancela, se revierte (contra-FP). Con Decisión 14 construida, no habrá movido nada y se cancela limpio. Por eso Decisión 14 va **antes** en el plan.
- **Pedido confirmado sin entregar**: el pedido en sí no movió nada; sus OC sí (FP). Decisión 15 nombra "pedido sin confirmar" como cancelable y no dice nada del confirmado sin entregar — pregunta 1.

---

## 3. Qué falta en la base

**Ya existe y sirve:**
- `audit_log` (`company_id, user_id, action, entity, entity_id, name, detail, created_at`): quién, cuándo y qué, texto libre. Suficiente para la bitácora de cada cancelación/reversa con un `action` nuevo.
- `stock_moves` inmutable, con `ref` único (`0015_folios_unicos.sql:11`), `unit_cost` por movimiento, `created_by`, `origin` — la reversa de inventario es un movimiento más, al costo que ya está guardado.
- `payments` / `payment_allocs` / `bank_moves` con `created_by`, y `bank_moves.payment_id` + `invoice_id` como ligas reales; `refreshInvoiceResidual` ya reabre una factura al bajar la suma de allocs.
- Folios únicos por serie (`0015:6-10`): un documento contrario necesita su propio folio.

**No existe (verificado: `grep -rniE "cancel|revers|void|anul"` en `migrations/` y `src/lib` no devuelve ninguna columna):**
1. **Estado "cancelado" / "revertido"** en ningún documento. Los estados en uso son solo: `open/paid` (facturas), `draft/confirmed/done` (pedidos y OC), `draft/sent/accepted/partial/rejected` (cotizaciones), `open/rfq/quoted` (solicitudes), `awarded` (RFQ). Ningún lector sabe saltarse un documento cancelado.
2. **Quién, cuándo y por qué** en el documento mismo: no hay `cancelled_at`, `cancelled_by`, `cancel_reason` en `customer_requests`, `quotes`, `sales_orders`, `purchase_orders` ni `invoices`. Hoy eso solo cabría en la bitácora.
3. **La liga original ↔ reversa**: no hay `reverses_id` (o equivalente) en `invoices`, `payments`, `bank_moves` ni `stock_moves`. Un contra-PAG no tendría forma de decir a cuál PAG cancela, salvo por texto en `memo`.
4. **Signo de los pagos**: `payments.amount` es siempre positivo y `kind` solo vale `'inbound'`/`'outbound'` (`src/lib`: 3 y 1 usos). Un contra-cobro necesita o un monto negativo o un `kind` nuevo; `payment_allocs.amount` negativo ya lo tolera la suma, pero `refreshInvoiceResidual` hace `Math.max(0, …)` (`stock.ts:268`).
5. **Tipo de movimiento de inventario para reversa**: `StockMoveType` es `receipt|delivery|internal|adjust|opening|return` (`stock.ts:6-15`), con prefijo de folio fijo por tipo. Hace falta uno (`reversal`) o reutilizar `adjust` con la liga.
6. **`paid_date` no se limpia** al reabrir una factura (`stock.ts:279`).
7. **Los lectores**: 14 `state = 'open'`, 3 `<> 'paid'`, 3 `<> 'done'`, 2 `= 'done'`, 2 `= 'paid'` en `src/lib` (`azagro.ts` 10 de ellos: tablero, cartera, vencimientos; `reports.ts` P&L y Panorama; `orders.ts` límite de crédito; `alerts.ts`); en pantallas, 9 `state === "done"`, 9 `!== "paid"`, 5 `=== "paid"`, etc. Cada uno tiene que excluir lo cancelado/revertido, o un pedido cancelado seguirá contando como pendiente y una FV revertida como cartera.
8. **Series**: FV/FI/PAG/NC/FP se numeran contando renglones (`count(*)` justo antes de cada insert: NC `azagro.ts:1607`, FI `ops.ts:2736`, FV y PAG igual) — un contra-documento consume folio de su serie; para la FP contraria no hay serie.

---

## 4. Los casos que se rompen

1. **Revertir una recepción cuya mercancía ya se vendió.** `postStock` lo rechaza ("Stock insuficiente", `stock.ts:182-189`). No hay salida limpia: hay que revertir primero la entrega. Se reporta, no se fuerza. **Resuelto por rechazo, no por reversa.**
2. **El promedio no vuelve solo.** Revertir una entrada deja el promedio contaminado (§ 2.3). Salida limpia posible pero cara: recalcular reproduciendo el kardex sin el par. Sin eso, la Decisión 9 (no contaminar) se cumple para la devolución de cliente pero no para la reversa de una recepción. **Decisión del dueño (pregunta 4).**
3. **FV con devolución parcial previa y luego reversa de la entrega.** Seis documentos en cadena (FV, NC, PAG virtual, sus tres contrarios) más el movimiento de inventario por la diferencia. Se puede, pero es el caso donde más fácil se descuadra cartera contra inventario. Propongo **bloquearlo en la primera versión** ("revierte primero la devolución") y abrirlo después.
4. **Un cobro que hizo cuatro cosas en un clic** (FI + PAG + PAG de pronto pago + ATC, `ops.ts:1936-2055`). La reversa tiene que saber cuáles nacieron de ese clic. Hoy solo se sabe por fecha y por texto (`memo "Pronto pago FV-…"`, `origin "Ajuste TC FV-…"`). Con la liga de § 3.3 se sabe con certeza; sin ella, se adivina — y adivinar es justo lo que el principio prohíbe. **Por eso la liga va en el paso 0.**
5. **Cancelar un pedido en borrador que vino de cotización.** Las OC ya nacieron `'confirmed'` con FP (`ops.ts:1704-1727`) aunque el pedido siga en borrador: cancelar el pedido es también cancelar OC y contrariar FP en cascada, y la cotización queda `'accepted'` apuntando a un pedido cancelado. **Se corta si Decisión 14 no está construida antes** (con ella, solo cascada de OC, sin FP). Y la cotización necesita respuesta (pregunta 2).
6. **`reviseQuote` busca pedidos en borrador** (`ops.ts:1273-1277`, `ordenes.filter((o) => o.state === "draft")`) para decidir si una cotización aceptada se puede revisar. Un pedido cancelado que siga en `'draft'` la dejaría revisable y **le escribiría precios** (`:1503-1519`). Es un lector más que tiene que excluir cancelados — y de los peligrosos, porque escribe.
7. **Límite de crédito** (`orders.ts:545-551`) suma `residual` de facturas `'open'`: una FV revertida por contra-documento en negativo suma cero neto (bien), pero si la reversa se hace por estado, la FV tiene que salir de `'open'` o sigue consumiendo línea.
8. **La FP de una OC que nunca se recibió y ya se pagó** (posible hoy, porque la FP existe desde la OC): con Decisión 14, esas FP existentes quedan huérfanas de su regla — hay datos de prueba así en la base (pregunta 7).
9. **Corte de Compaq**: sus facturas tienen `cutover_key` y `opening_paid` (`cutover.ts:200-205`); revertirlas es contra-documento como cualquier otra, pero el índice único de folio las excluye (`0015:6`, `where cutover_key is null`) — un contrario con el mismo folio de Compaq no choca, pero tampoco se distingue. Marcar por estado, no por folio.

---

## 5. Plan por pasos

Cada paso deja el sistema funcionando y las pruebas en verde. "Dinero" = cartera o banco.

| Paso | Qué | Toca | Tamaño |
|---|---|---|---|
| **0** | **Cimientos, sin cambiar comportamiento.** Migración: estado `cancelled` en solicitud/cotización/pedido/OC y `reversed` en facturas; `cancelled_at/by/reason` en esas cinco tablas; `reverses_id` en `invoices`, `payments`, `bank_moves`, `stock_moves`; `paid_date` se limpia al reabrir (`stock.ts:279`). **Todos los lectores** (§ 3.7, incluido `reviseQuote` § 4.6) excluyen cancelado/revertido. Acciones nuevas en bitácora. Prueba: un documento marcado a mano desaparece de tablero, cartera, límite de crédito, P&L, vencimientos y expediente. | Nada (lectura) | Mediano — muchos archivos, cero lógica de negocio |
| **1** | **Cancelar lo liviano.** Solicitud (sustituye el borrado duro de `deleteRequest`), cotización (libera la solicitud como una rechazada), pedido en borrador **sin OC hijas**. Lo hace quien tiene permiso de editar ese módulo (pregunta 8). | Nada | Chico |
| **2** | **Decisión 9 — la devolución entra al costo con el que salió.** `returnSale` pasa a `postStock` el `unit_cost` del movimiento `'delivery'` del mismo pedido y producto (`stock_moves.origin` = pedido). Independiente de todo lo demás; entra aquí porque la reversa de entrega (paso 6) usa la misma lectura. | Inventario | Chico |
| **3** | **Decisión 14 — la FP nace al recibir.** Quitar la FP de `createPurchase` (`azagro.ts:1153-1160`), `decideQuote` (`ops.ts:1722-1730`) y `applyRfqWinners` (`rfq.ts:304-315`); `receivePurchase` la crea siempre (hoy solo si no existe, `:1211-1231`) con la fecha de recepción; la fecha de la factura del proveedor ajusta el plazo después. Tratamiento de las FP ya existentes de OC no recibidas: pregunta 7. **Prerrequisito** para cancelar OC y pedidos confirmados limpio (§ 2.6). | Cartera de proveedor (corrige defecto) | Mediano |
| **4** | **Cancelar en cascada.** OC confirmada sin recibir; pedido en borrador o confirmado sin entregar con sus OC hijas; la cotización según pregunta 2. | Nada (después del paso 3) | Chico–mediano |
| **5** | **Decisión 16 — reversa de pago.** Contra-PAG + contra-alloc + contra-`bank_move` ligados por `reverses_id`; deshace pronto pago, ATC o `fx_result`, limpia `paid_date` y los campos `fx_*`; la FI se queda (pregunta 5); conciliación según pregunta 6. Solo admin y gerencia; una sola acción, una confirmación, bitácora con la cadena completa. | **Banco + cartera** | Mediano |
| **6** | **Reversa de recepción.** Salida contraria al costo de la entrada (rechazo si ya salió); OC de regreso a confirmada; contra-FP si no está pagada, si no exige paso 5 primero. Promedio según pregunta 4. | Inventario + cartera de proveedor | Mediano |
| **7** | **Reversa de entrega/FV.** Entrada contraria al costo de la salida; pedido de regreso a confirmado; contra-FV en la serie que se decida (pregunta 3); cascada contra-FI y contra-ATC; exige pagos revertidos antes (paso 5); **bloquea si hay NC previa** (§ 4.3) en esta versión. | Inventario + cartera de cliente | Grande — es el que más cosas encadena |
| **8** | **Reversa de devolución (NC)** y, si se abre, el caso § 4.3. | Inventario + cartera | Mediano |
| **9** | **Recálculo del promedio** (solo si el dueño lo pide en la pregunta 4). | Inventario | Grande |

Dependencias duras: 0 → todo; 3 → 4 y 6; 5 → 6 y 7; 2 → 7. Lo de dinero empieza en el paso 5; hasta el 4 todo es cancelar sin mover nada más que estados.

Fuera de este bloque, pero que lo tocan: Decisión 12 (anticipo) cambia qué hace un cobro con el sobrante, y por tanto qué revierte el paso 5 — si el anticipo se construye antes, el paso 5 lo hereda; si después, el paso 5 se amplía. Decisión 10 (mora proporcional en devolución) vive en `returnSale`, junto al paso 2, pero no es deshacer: va en su propio bloque.

---

## 6. Lo que necesito que decida el dueño antes de empezar

Las ocho decisiones cubren el qué. Esto es lo que quedó sin cubrir, en el orden en que lo va a topar la construcción:

1. **Un pedido confirmado que todavía no se entrega**: ¿se cancela como los livianos (él mismo no movió nada), o cuenta como "ya movió algo" por las órdenes de compra que nacieron con él? (Decisión 15 solo nombra "pedido sin confirmar".)
2. **Al cancelar un pedido que salió de una cotización aceptada**: ¿la cotización vuelve a estar viva para aceptarse otra vez, o se queda como "aceptada, con pedido cancelado" y hay que cotizar de nuevo?
3. **Con qué folio nacen los documentos contrarios.** La reversa de una factura de cliente, ¿es una nota de crédito (NC, serie que ya existe) por el total, o una factura en negativo? La reversa de una factura de proveedor no tiene serie (no hay nota de crédito de proveedor) — ¿serie nueva, o se marca revertida sin documento contrario? (La regla de siempre es no abrir series sin pedirlo.)
4. **El promedio de inventario al revertir una entrada**: ¿debe quedar como si esa mercancía nunca hubiera entrado (hay que recalcular el kardex; es la pieza más grande del bloque), o se acepta que el promedio quede movido y se anota?
5. **Un pago que en ese mismo clic facturó intereses**: al revertir el pago, la factura de intereses ¿se queda (el interés hasta esa fecha era real) o se revierte junto con él?
6. **Un pago que ya estaba conciliado con el banco**: su reversa ¿nace conciliada también, o pendiente de conciliar?
7. **Las facturas de proveedor que ya existen para órdenes que no se han recibido** (nacieron con el defecto que corrige la Decisión 14; en la base hay datos de prueba así): al construir el paso 3, ¿se revierten, se dejan como están, o se marcan?
8. **"Lo puede hacer quien capturó"**: ¿solo esa persona, o cualquiera con permiso de editar ese módulo? Con el candado de hoy, la persona que captura y la que cancela suelen tener el mismo permiso, y "quien capturó" puede ya no estar.
9. **Una reversa que arrastra varias cosas** (entrega con pagos y mora): ¿se hace paso por paso (primero cada pago, luego la factura), o una sola acción que enseña la cadena completa y pregunta una vez?

Sin 1, 2 y 3 no se puede escribir el paso 4 ni el 7; sin 4, el 6 y el 9; sin 5 y 6, el 5. El 0, 1, 2 y 3 se pueden construir ya.
