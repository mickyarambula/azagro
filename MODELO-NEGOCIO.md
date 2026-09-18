# Mapa funcional del negocio — Azagro contra el sistema (17-sep-2026)

Azagro compra y vende insumos agrícolas (fertilizantes y agroquímicos). Es una distribuidora estándar: se compra de contado o a crédito, con o sin anticipo, para inventariar o contra pedido; se vende de inventario o directo del proveedor, de contado o a crédito, con o sin anticipo; se cobra, se paga, se devuelve. La única particularidad es cómo Almacenes Santa Rosa financia — y eso ya está resuelto en el catálogo de cuatro circuitos (`DISENO_FINANCIAMIENTO.md`, `src/lib/erp/circuits.ts`). Todo lo demás es distribución y el sistema tiene que soportarla completa.

Este documento es el mapa de lo que una distribuidora así necesita, capacidad por capacidad, y para cada una: **existe**, **a medias** o **no existe** en el sistema hoy, con archivo:línea cuando existe. Se levantó con cuatro pasadas de solo lectura sobre el código del 17-sep-2026 (después de los cierres de los grupos A–E de `AUDITORIA.md` y de las Decisiones 69–75). No propone construir nada; es el mapa. Las preguntas que ya estaban abiertas en `ESTADO.md` se citan por su clave, no se reabren.

**Leyenda:** ✅ existe · ◐ a medias · ✗ no existe · (D) decidido en `DECISIONES.md` y sin construir · (A) pregunta abierta en `ESTADO.md`.

## 0. Resumen en una pantalla

| Proceso | ✅ | ◐ | ✗ | Lo que más pesa que falte |
|---|---|---|---|---|
| Comprar | 4 | 5 | 3 | anticipo a proveedor · NC/devolución a proveedor · flete que no entra al kardex |
| Almacenar | 5 | 5 | 5 | lotes/caducidad · UOM con conversión · conteo físico · reserva física · producto inactivo |
| Vender | 9 | 6 | 7 | listas de precios · descuento comercial · anticipo de cliente · remisión por entrega · reasignar vendedor |
| Cobrar y pagar | 6 | 4 | 6 | reparto de un cobro entre facturas (D13) · anticipos (D11-12) · alta de bancos · lado Santa Rosa |
| Medir | 5 | 4 | 5 | margen por producto/familia · rotación · ventas por vendedor · cierre de periodo |

Lo que ya está sólido y no hay que volver a tocar: el kardex y su trazabilidad, bodegas múltiples, la cadena SOL→COT→PV→ENV→FV con parciales por evento, la cartera del lado cliente (cobro, mora, pronto pago, TC, estado de cuenta, aging, recordatorios), las cuatro reversas y la cancelación en cascada, el P&L por pedido y consolidado, el inicio, y la importación del corte.

**El plazo "cosecha"** (§ 6): existe en el sistema y el dueño acaba de decir que no existe en su operación. Está muy poco enredado: es un clon de "fecha" con otra etiqueta; quitarlo de pantalla es una línea, quitarlo del todo son ~6 archivos y un archivo de pruebas.

---

## 1. COMPRAR

| # | Capacidad | Estado | Dónde / qué hay | Qué falta |
|---|---|---|---|---|
| 1.1 | Solicitud de cotización a proveedores (SC/RFQ), comparar, elegir ganador | ✅ | `src/lib/erp/rfq.ts` (tablas `vendor_rfqs*`), `src/routes/rfq.$rfqId.tsx`: grid producto×proveedor, sugiere el más barato, `applyRfqWinners` arma la(s) OC (rfq.ts:208). Sirve para stock y para un pedido de cliente. | Sin prueba dedicada. `applyRfqWinners` crea varias OC fuera de `withTx` (una falla a la mitad deja OC parciales). |
| 1.2 | Orden de compra: inventario vs directa/brokeraje; manual vs desde RFQ; MXN/USD con TC | ✅ | `createPurchase` (`src/lib/azagro.ts:1247`), `fulfillKind`, `currency`/`fxRate`; también desde `applyRfqWinners` y `decideQuote` (`ops.ts:1718`). | El folio OC/SC sale de `count(*)+1` (azagro.ts:1273, rfq.ts:154/279, ops.ts:1715), fuera del cierre del grupo C. Una OC manual no acepta `soId` (ver `AUDITORIA.md` § 4 GRUPO F). Sin flujo de aprobación por monto: nace `confirmed`. |
| 1.3 | Condiciones de compra: contado vs crédito | ◐ por diseño | El plazo vive **solo** en `partners.payment_days`; `bornSupplierDebt*` lo lee de ahí y se detiene si es null (Decisión 30). | No se puede pactar plazo distinto por OC: ni campo ni pantalla (`purchases.tsx`). Contado se expresa como `payment_days = 0`. |
| 1.4 | Anticipo a proveedor (pagar antes de recibir, aplicar contra la FP) | ✗ | `registerPayment`/`applyInvoicePayment` exigen `invoiceId` (azagro.ts:2824-2864): solo se paga contra factura nacida. | El concepto no existe. Sin decisión escrita (la de cliente sí: D11-12). |
| 1.5 | Recepción total/parcial por evento (RCP/), cierre corto, reversa | ✅ | `receivePurchase`/`receivePartial` (azagro.ts:1377/1489), `bornSupplierDebtByReceipt` (1565), `closeShortPurchase` (2263), `receipt-reversal.ts`. Pruebas `erp-recepcion-parcial`, `erp-revertir-recepcion-parcial`, `erp-parciales-paso7`. | — |
| 1.6 | Flete y otros gastos al costo puesto | ◐ con hueco | `landedUnit = cost + freight + other` (`pricing.ts:81,189`) se captura en `quote_lines.freight`/`other_cost` **al cotizar al cliente**. Precio puesto en destino = `unit_price` de la OC con flete 0. Flete real a fletero = `expenses` con `so_id`, entra al P&L del pedido (`reports.ts:462`). | **El kardex nunca ve el flete**: `postStock` en recepción usa solo `purchase_lines.unit_price` (azagro.ts:1458/1529); `purchase_lines` no tiene columna de flete. Y el costo financiero se calcula sobre el flete estimado al cotizar, nunca sobre el gasto real (`reports.ts:459-461`): dos números que no se concilian. Hoy es coherente solo porque el proveedor trae el precio puesto. |
| 1.7 | Gastos de importación / otros cargos ligados a la OC | ◐ | `expenses.po_id` existe (migración 0008, `expenses.ts:150`). | `orderExpenses` (`reports.ts:156-167`) filtra solo por `so_id`: un gasto ligado solo a una OC de inventario queda huérfano — descuenta banco y no llega a ningún costo ni P&L. |
| 1.8 | Devolución a proveedor / NC de proveedor | ✗ (A) H4c | Nada reduce el residual de una FP salvo pagarla o revertir la recepción entera (que no es devolver, aclaración del dueño 9-sep). | Mercancía equivocada de un proveedor no tiene camino. `ESTADO.md` H4c. |
| 1.9 | Factura del proveedor: nace al recibir, folio fiscal, cotejo de tres vías | ◐ | FP por evento; `supplier_folio`/`folio_fiscal`/`uuid_fiscal` (migración 0027) se capturan después, texto libre (`saveInvoiceReference`, azagro.ts:2750). | La FP siempre nace = recibido × precio de OC; no hay campo para un importe distinto que facture el proveedor, así que no hay discrepancia posible ni cotejo real OC↔recepción↔factura. |
| 1.10 | Catálogo de proveedores: alta, plazo, resync Compaq | ✅ ya auditado | `compaq.ts`, `erp-resync-no-pisa.test.mjs`. Sin moneda en el socio a propósito (Decisión 2). | Ver `AUDITORIA.md` § 4 GRUPO I (resync fantasma). |
| 1.11 | Historial de costos por producto y proveedor | ◐ | `products.cost` (promedio), `ref_cost` (manual), `partner_products` kind `buy` = **último** precio por proveedor+producto (`links.ts:16-27`, `rememberTrade`). | Sin historial temporal ni costo por proveedor consultable en el tiempo: el último pisa al anterior. |
| 1.12 | Reposición: mínimo, máximo, punto de pedido, sugerencia de compra, demanda comprometida, en tránsito | ◐ mínimo | `products.min_stock` (migración 0002:49), único dato; alimenta la bandeja del inicio (azagro.ts:343-364). | Sin máximo, punto de pedido, sugerencia de cantidad, ni resta de pedidos confirmados sin entregar ni suma de compras en tránsito (`loc_type='transit'` existe pero no cuenta). Mínimo por empresa, no por bodega. |

## 2. ALMACENAR

| # | Capacidad | Estado | Dónde / qué hay | Qué falta |
|---|---|---|---|---|
| 2.1 | Kardex inmutable, promedio móvil, existencia = suma del kardex | ✅ | `stock.ts:223-319` (`postStock`, único punto de escritura), `movingAverage` (58-65), `qtyFromMoves` (127-137). | El promedio es **por bodega**; el catálogo enseña un solo "costo promedio" que es promedio de promedios (`refreshProductCost`, stock.ts:191-206). |
| 2.2 | Bodegas múltiples, transferencias, existencia por bodega | ✅ | `locations` N internas (`locations.ts:29-108`, `/bodegas`), `transferStock` (azagro.ts:1094-1127). | Sin prueba dedicada de transferencia. |
| 2.3 | Lotes y caducidad | ✗ (A) H5 | Nada en migraciones ni `src/`. La reversa de recepción **depende** de que no haya lotes (`receipt-reversal.ts:26-28`, Decisión 35). | Tamaño: columna en `stock_moves` y `stock_quants` (la llave de existencia pasa a producto+bodega+lote), todos los lectores que suman por producto-bodega, y qué lote lleva el historial ya movido. |
| 2.4 | Unidades de medida y conversión (L↔tambo, kg↔saco; unidad de compra ≠ venta) | ◐ (A) H6 | `uoms` es catálogo libre código+nombre (migración 0005:3-9); `products.uom` una sola columna; `purchase_lines.uom`/`sales_lines.uom` son etiqueta impresa. | Sin factor de conversión ni unidad de compra vs venta: nada traduce cantidades. Tamaño: decidir en qué unidad vive el kardex y revisar cada cantidad × costo (promedio, valuación, `weightedCost`, `deliveredUnitCost`). |
| 2.5 | Conteo físico (hoja, diferencia, ajuste con motivo) | ✗ (A) L8a | Solo `adjustStock` directo. | Sin flujo contar→comparar→ajustar. |
| 2.6 | Ajuste de inventario con costo y motivo; mermas; baja de vencido/dañado | ◐ | `adjustStock` (azagro.ts:1129-1164): cantidad ±, `note` opcional, bitácora. | No pide costo (entra al promedio, L8a); motivo opcional; un clic sin confirmación (`AUDITORIA.md` #59); sin tipo "merma" distinto de "corrección". |
| 2.7 | Fórmulas / mezclas (BOM), producción propia o maquila | ✗ | Cero en migraciones y `src/` (`bom`, `formula`, `receta`, `component`, `kit`, `mezcla`, `maquila`). | Tamaño: el menos invasivo de los tres estructurales — una tabla de receta y un tipo nuevo de `stock_moves` (consumo de componentes → entrada del terminado al costo ponderado); no cambia la forma de la existencia actual. |
| 2.8 | Catálogo de productos: familia, marca, ingrediente activo, registro COFEPRIS, presentación, código de barras, proveedor habitual, activo/inactivo | ◐ | Código, nombre, tipo (`product_kinds`, familia gruesa derivada en `compaq.ts:148`/`azagro.ts:823`), UOM, costo, `ref_cost`, `list_price`, `min_stock` (`product-form.tsx`). | Sin marca, ingrediente activo, COFEPRIS, presentación, código de barras, proveedor habitual. **Sin bandera activo/inactivo**: un descontinuado sigue en todos los selectores para siempre. |
| 2.9 | Valuación de existencias y kardex consultable | ◐ | `listInventory` valúa cantidad × costo por producto-bodega (azagro.ts:939-958); `/inventory` suma por bodega y tipo; exporta CSV. | El kardex trae `limit 200` de **toda la empresa** sin filtro de producto ni fecha en el servidor (azagro.ts:975-1002); el filtro y el saldo corrido se hacen en el navegador — con volumen, se queda corto y el saldo no arranca del cero real. Sin valuación a fecha pasada. |
| 2.10 | Reserva / apartado físico para pedidos confirmados (disponible = existencia − comprometido) | ✗ | Solo existe apartado de **línea de crédito** (`credit-limit.ts`, D51), no de mercancía. `postStock` valida "hay suficiente ahora" al entregar (stock.ts:271-282). | Dos pedidos confirmados compiten por la misma existencia sin aviso: el primero en entregar se la lleva. |
| 2.11 | Remisión / guía de carga que ampara la salida sin factura | ◐ | `guiaSheet` (`print-doc.ts:187-265`): fletero, chofer, placas, renglones, firma; `saveGuia` (`orders.ts:837-878`). El evento `ENV/000N` sí queda en el kardex. | La guía imprime el **folio y las cantidades del pedido completo**, no del evento (`sales.$orderId.tsx:1111,1121-1128`); sus datos (firma, chofer) son columnas únicas de `sales_orders` que **se sobrescriben** en cada impresión: con dos entregas parciales se pierde la constancia firmada de la primera. No es un documento con folio propio. |
| 2.12 | Devolución de cliente al costo de salida | ✅ | `returnSale` → `deliveredUnitCost`/`weightedCost` (D9, D26, D27). Pruebas `erp-devolucion-costo`, `erp-devolucion-por-partida`. | Sin devolución **sin reingreso** (producto dañado): toda devolución reingresa; el camino paralelo es un ajuste de merma sin liga a la NC. |
| 2.13 | Trazabilidad por movimiento (usuario, fecha, documento, evento, reversa) | ✅ | `stock_moves.created_by/date/ref/origin/event_ref/reverses_id`; `OriginFolio` en pantalla; `erp-trazabilidad.test.mjs`. | — |

## 3. VENDER

| # | Capacidad | Estado | Dónde / qué hay | Qué falta |
|---|---|---|---|---|
| 3.1 | Listas de precios por cliente, por grupo/zona | ✗ | `products.list_price` único por empresa; `partner_products` kind `sell` solo **registra** el último precio pactado (`links.ts:14-27`) y ningún camino de precio lo lee. `group_name` es texto libre para filtrar. | No hay lista ni precio pactado reutilizable; cada cotización recalcula desde cero. |
| 3.2 | Escalón de precio por volumen | ✗ | La única "escalera" es de plazos (`ladder.ts`), no de cantidad. | — |
| 3.3 | Precio pactado / fijo por partida frente a la regla 8 | ◐ | `createQuote` acepta `cashPrice`/`creditPrice` por partida (`ops.ts:865-880`) y despeja el margen hacia atrás (`marginFromPrice`, `margins.ts:153-157`). | Queda como margen implícito de ESA cotización, no como lista. Conviven sin contradicción con la regla 8 porque no hay segundo camino de precio. Si un día hay lista o descuento, la pregunta de diseño es si resta antes del margen (cambia la utilidad real) o después. |
| 3.4 | Descuento comercial por volumen, línea o cliente (distinto del pronto pago) | ✗ | Sin `discount` en `sales_lines` ni `quote_lines`; todo "descuento" del código es el pronto pago financiero (`ops.ts:2098-2176`). | El único modo de bajar un precio es bajar el margen. |
| 3.5 | Anticipo de cliente | ✗ (D) 11-12 | Si el pago excede el saldo, **el sobrante se descarta**: `applied = Math.min(amount, residual)` (`ops.ts:1994`). El corte rechaza saldos negativos (D71) "hasta que exista el anticipo". `addBankMove` admite un cobro sin factura que no toca cartera. | Sin tabla ni `kind` de anticipo; el residual ≤ 0 se rechaza en `applyInvoicePayment` (`ops.ts:1969`). Ver § 4 para el tamaño. |
| 3.6 | Cadena SOL→COT (dos columnas, escalera)→PV→ENV→FV; vender sin cotizar; pedido desde OC del cliente | ✅ | `deal.ts` (`getDealTrail`), `createQuote`/`decideQuote` (`ops.ts:843/1540`), `createSale` (azagro.ts:1671, `/sales/nuevo`, siempre contado), `convertCustomerPO` (`cpo.ts:158-240`). `erp-nacimiento-credito.test.mjs`. | — |
| 3.7 | Remisión al cliente antes de la factura, con folio propio | ◐ | Entregar ≠ facturar está construido (D47, `ENV/000N`). | No hay documento "Remisión" imprimible por evento — solo la guía de carga a nivel pedido (2.11). Consolidar remisiones en una FV no aplica: D46 es una FV por entrega. |
| 3.8 | Facturación: una FV por entrega; FV consolidada; FV anticipada; puente de timbrado | ✅ / ✗ / ✗ / ✅ | `issueDeliveryInvoice` (azagro.ts:1925-2081) idempotente por evento. `folio_fiscal`/`uuid_fiscal` (migración 0027) capturados después. | Consolidada: no existe por diseño (D46). Anticipada: bloqueada a propósito (`invoiceDelivery` exige entrega viva, azagro.ts:2109) — es candado con salida (entregar). |
| 3.9 | Devolución parcial por partida, con NC aplicada a la FV elegida | ✅ | `returnSale` con `lineId` (grupo D), `applies_to_id` (migración 0036), `returnProposal` (D52). | Sin devolución sin reingreso (2.12). |
| 3.10 | Límite de crédito por cliente, en vivo, facturado + apartado | ✅ | `credit-limit.ts` (D51, D62), `erp-parciales-paso6`. En pesos siempre (las FV guardan `amount` en MXN). | Sin límite por grupo. Concurrencia sin candado (`AUDITORIA.md` #41). |
| 3.11 | Ventas en dólares con TC pactado | ✅ | `sales_orders.currency`/`fx_rate`, `quotes` igual (migración 0003); TC de tabla o se detiene. | — |
| 3.12 | Condiciones por cliente: política de cobro, plazo, límite, grupo, zona | ◐ | `policy_code` (migración 0043, D73), `payment_days`, `credit_limit`, `group_name` texto libre. | **Sin zona/región** en ninguna migración. Grupo sin catálogo. |
| 3.13 | Vendedor asignado / cartera propia | ◐ candado sin salida | `partners.seller_id` (migración 0004:29) alimenta `own_only` en más de diez consultas. | Se escribe **solo al crear** el cliente con el usuario que lo dio de alta (azagro.ts:667-670); `savePartner` nunca lo toca (632-643). **No hay forma de reasignar un cliente a otro vendedor** salvo SQL a mano. |
| 3.14 | Comisiones a vendedores | ✗ | Todo `commission` del repo es la comisión de apertura ASR (`credit_circuits.commission_rate`) o `credit_policies.charge_commission`. | — |
| 3.15 | Cancelar pedido / cotización; cascada | ✅ | `cancelQuote`/`cancelOrder`, `cancel.ts` (5c). | — |
| 3.16 | Documento que sale de la empresa (papel + envío correo/WhatsApp) | ✅ con huecos | `doc-text.ts`, `send-doc.tsx`: SOL/COT/PV/FV/NC al cliente, SC/OC al proveedor, estado de cuenta. | Huecos ya en `AUDITORIA.md` § 4 GRUPO K (#35, #36, #61, #72). Guía de carga sin liga al evento (2.11). |
| 3.17 | OC del cliente (`customer_pos`) | ✅ | `cpo.ts`: alta con precio 100% capturado a mano (sin margen ni fórmula), conversión exige plazo y política. | El comentario del #13 sigue en el código (`cpo.ts:57-58`) aunque el hallazgo se cerró en el commit de permisos: comentario obsoleto. Sin candado de precio por debajo del costo. |
| 3.18 | Quién ve precio, costo y margen | ✅ ya auditado | `acl.ts:301-311` (`canSeeCosts`, `canSeeMargins`, `canSeeSalePrices`). | — |

## 4. COBRAR Y PAGAR

| # | Capacidad | Estado | Dónde / qué hay | Qué falta |
|---|---|---|---|---|
| 4.1 | Cobro a una factura: PAG, banco, TC/ATC, pronto pago, FI antes del cobro, `paid_date` del último abono | ✅ | `applyInvoicePayment` (`ops.ts:1922-2183`): `for update`, rechaza revertida y saldo cero, `fxPaymentSplit`, `issueMoraInvoice`, `nextDocFolio`, `payment_allocs`, `earlyPayBonus`, `refreshInvoiceResidual`. Pruebas `erp-estado-cuenta`, `erp-politica-cobro`. | Una factura por llamada (→ 4.2). |
| 4.2 | Un cobro repartido entre varias facturas, con propuesta del sistema | ✗ (D) 13 | `invoiceId` singular (`ops.ts:1927`); `reversal.ts:145-152` lo dice en comentario y bloquea la reversa si un PAG tuviera más de un alloc. | Decidida el 7-sep, sin construir. El botón de cabecera de `/credit` no es esto (`AUDITORIA.md` § 4 GRUPO J). |
| 4.3 | Anticipo de cliente (saldo a favor aplicable a una o varias FV) | ✗ (D) 11-12 | Ver 3.5. El remanente de una NC cuya factura ya no tiene saldo queda muerto (azagro.ts:2505-2522): no se puede aplicar a otra factura. | Tamaño: un documento propio (o `invoices` con clase anticipo) con residual negativo permitido, `nextInvoiceState` y `applyInvoicePayment` aprendiendo a aplicar saldo a favor, `creditExposure` restándolo, el estado de cuenta enseñándolo, y el corte aceptando negativos (D71 se destraba). Toca la regla 5c. |
| 4.4 | Anticipo a proveedor | ✗ | Ver 1.4. | Sin decisión escrita. Misma pieza que 4.3 del lado proveedor. |
| 4.5 | Pago a proveedor: parcial, USD, reversa | ◐ | Parcial y reversa iguales que el cobro. | **FP en USD sin diferencial cambiario**: `bornSupplierDebt` no llena `amount_fx` (azagro.ts:1345-1372) y `applyInvoicePayment` solo calcula TC si `kind === 'customer'` (`ops.ts:1973`). Es la "nota al margen" de `AUDITORIA.md` § 3 y el aviso (6) del grupo B. Sin reparto de un movimiento bancario entre varias FP (= 4.2). |
| 4.6 | Notas de crédito: de cliente; de proveedor; aplicar a otra factura | ✅ / ✗ / ◐ | NC de devolución con `applies_to_id`. | NC de proveedor: H4c. Aplicar el remanente de una NC a una factura distinta de la de origen: no hay pantalla ni función (= 4.3). |
| 4.7 | Bancos: cuentas, movimientos, conciliación, saldo inicial del corte, transferencias, caja chica, importar estado de cuenta | ◐ | `bank_moves`, `reconcileMove` (`ops.ts:2255-2277`), `cutover_key` (migración 0038), transferencia entre cuentas (`addBankMove`, `ops.ts:2244-2249`). | **No se puede dar de alta una cuenta desde la app**: `banks` solo se siembra con `BANK_CATALOG` (Banorte MXN/USD, azagro.ts:169, catalog.ts:37-40). Sin caja chica. Sin importar estado de cuenta. Las dos patas de una transferencia no quedan ligadas por ningún campo; sin validación de moneda entre cuentas. |
| 4.8 | Gastos: captura, categoría, banco, liga a pedido/OC | ✅ con huecos | `createExpense` (`expenses.ts:140-185`), `EXPENSE_CATALOG` (operativo/pedido/financiero), `so_id`/`po_id`. | Sin bitácora (cero `writeAudit` en `expenses.ts`); folio `GAS-` por `count(*)+1` (165-166); gasto solo con `po_id` invisible al P&L (1.7). |
| 4.9 | Cuentas por cobrar: estado de cuenta, aging, próximos vencimientos, recordatorios | ✅ | `getLiveStatement` (`ops.ts:2279+`), `statements.tsx`, aging por tramo en el inicio (azagro.ts:365-378), `vencimientos.tsx`, `sendPaymentReminder`/`sendPartnerReminders` (`alerts.ts:270-405`) con bitácora. | Sin DSO, top deudores ni concentración. `statements.tsx` y `credit.tsx` no exportan CSV. |
| 4.10 | Cuentas por pagar: estado de cuenta, aging, programación de pagos | ◐ | `vencimientos.tsx` con toggle cliente/proveedor; `getUpcomingPayable` (`reports.ts:945+`) por mes. | Sin "propuesta de pago" (a quién pagar con el efectivo disponible) — el comentario de `reports.ts:877` la nombra, no existe. |
| 4.11 | Mora / intereses del lado cliente; mora que Azagro paga a proveedores | ✅ / ✗ por diseño | `computeMora`/`issueMoraInvoice` con TIIE de tabla, dos interruptores por política, nunca con días ≤ 0, en `withTx` + `for update`. | Del lado proveedor el código decide que no existe (`reports.ts:940-941`: "Azagro no paga mora a proveedor"). Pregunta al dueño: ¿algún proveedor sí cobra moratorios? |
| 4.12 | Diferencial cambiario | ✅ cliente / ✗ proveedor | ATC y `fx_result` en el cobro. | Ver 4.5. |
| 4.13 | Reversas de cobro y pago | ✅ | `reversal.ts` (paso 5), `erp-revertir-pago`. | — |
| 4.14 | Liquidación con Santa Rosa (FV Azagro→ASR, cobro de ASR, factura espejo, cuenta "Santa Rosa por facturas") | ✗ (A) D-C | Santa Rosa solo es socio de catálogo kind `finance` y parámetro de circuito (`credit_circuits`, migración 0024). `DISENO_FINANCIAMIENTO.md` § 4 marca "No" en los pasos 7-10. | Sin documento, tabla ni función. Lo único es la categoría de gasto "Intereses pagados" sin liga al circuito. `ESTADO.md` D-C, 4.2, 4.5. |

## 5. MEDIR

| # | Capacidad | Estado | Dónde / qué hay | Qué falta |
|---|---|---|---|---|
| 5.1 | P&L por pedido y consolidado por periodo; cuatro visiones de utilidad | ✅ | `computeDealPnl` (`reports.ts:42+`), `listDealPnl` (552), `getCompanyPnl` (645), `getPanorama` (736): devengada/realizada/caja/proporcional, gastos por clase. | Filtros: solo rango de fechas y cartera propia. |
| 5.2 | Margen por producto, por familia/línea, por cliente | ◐ | Por cliente: `getPanorama` agrupa por razón social. `products.category`/`product_type` existen. | **Ningún reporte agrupa por producto ni por familia** (cero en `reports.ts`). |
| 5.3 | Rotación de inventario (días, veces al año) | ✗ | Cero coincidencias en `src/`. | — |
| 5.4 | Ventas por vendedor, por zona; compras por proveedor | ◐ | `seller_id` es **filtro** de visibilidad, no dimensión de agrupación. | Sin reporte vendedor vs vendedor; zona no existe como dato; compras por proveedor solo como saldo, no como volumen. |
| 5.5 | Valuación de inventario | ✅ hoy / ✗ histórica | `getDashboard` por tipo de ubicación (azagro.ts:332-342), `/inventory` por bodega con CSV. | Sin valuación a una fecha pasada. |
| 5.6 | Cartera: aging, DSO, top deudores, concentración | ✅ / ✗ / ✗ / ✗ | Aging por tramo en el inicio y en `/vencimientos`. | DSO, top deudores y concentración no existen. |
| 5.7 | Inicio: "¿qué me va a doler hoy?" | ✅ | `getDashboard` (azagro.ts:307+): caja, por cobrar con vencidas, por pagar, inventario, aging, bandeja de atención, cola operativa; filtrado por cartera y permiso. | — |
| 5.8 | Bitácora | ✅ con huecos concretos | `writeAudit` en cobro/pago, reversas, pronto pago, TC, recordatorios, conciliar, ajustes de stock, cancelar rechazado, cerrar corto. | **No dejan rastro**: `createExpense`/`addExpenseCategory`; `addBankMove` sin `invoiceId` (transferencias, ajustes bancarios); resync de catálogos (grupo I); cambios de nombre/RFC en `savePartner`. |
| 5.9 | Exportar CSV | ◐ | `exportCsv` en cotizaciones, OC del cliente, bancos, compras, inventario, reportes, gastos, ventas. | No en estado de cuenta ni en cartera (`statements.tsx`, `credit.tsx`). |
| 5.10 | Cierre de periodo / candado de fecha | ✗ | Cero en migraciones y `src/`. | Cualquier fecha pasada sigue abierta a captura. Un cobro con fecha futura también entra (`AUDITORIA.md` #47). |

### Transversales (ya auditados, se citan)

Permisos por módulo y nivel `deliver` (`acl.ts`, D48/D74) ✅. Cancelar y las cuatro reversas (5c-5d) ✅. Moneda y TC de tabla (regla 9) ✅ del lado cliente, ◐ del lado proveedor (4.5). Importación del corte Compaq ✅ (grupo B), pendiente el archivo real (H8a). Folios de dinero por `folio_counters` ✅ (grupo C); PV/OC/SC/GAS/COT/SOL todavía por `count(*)+1`.

---

## 6. El plazo "cosecha" (`term_kind = 'harvest'`)

El dueño acaba de corregir: en su operación **no existe** el plazo "a cosecha". El sistema lo tiene desde `migrations/0006_orders.sql:3` (muy temprano) y ayer, 17-sep, la Decisión 69 / migración 0040 le aplicó a "Fecha y Cosecha por igual" la corrección de `computeDues`. Ninguna decisión de `DECISIONES.md` lo introdujo como requisito; la única fuente es el hallazgo #4 de la auditoría, que lo usó como escenario y que el propio auditor marcó como "sospecha".

**Dónde vive (inventario completo):**

| Capa | Dónde | Cuánto |
|---|---|---|
| Esquema | `sales_orders.term_kind text` (0006:3), texto libre sin CHECK; `0040:28,47` dos UPDATE que tratan `'date'` y `'harvest'` en la misma condición | 1 columna, 0 datos sembrados |
| Motor | `order-terms.ts`: `TERM_KINDS` (:3) y **una rama** en `computeDues` (:40-50, 11 líneas); `orders.ts:61` enum de zod | 1 rama real |
| Motores que NO lo conocen | `credit.ts`, `ladder.ts`, `pricing.ts`, `reports.ts`, `parciales.ts`: 0 coincidencias — trabajan sobre `credit_days` ya derivado | 0 |
| Nacimientos que lo producen | solo `saveOrder` (captura manual); `decideQuote` y `convertCustomerPO` nunca lo generan | 1 camino |
| Pantalla | `order-form.tsx`: etiqueta en `TERMS` (:58), bloque de fechas **compartido** con `'date'` (:390, difiere solo en la etiqueta :395), `termLabel` (:617); `sales.$orderId.tsx:142` whitelist; `partner-form.tsx:210` copy | 5 puntos, 3 archivos |
| Papel / doc-text | 0 coincidencias | 0 |
| Pruebas | solo `scripts/erp-nacimiento-credito.test.mjs`: 1 test exclusivo (:136-146), 1 test de la 0040 con 3 pedidos `'harvest'` de 7 (:296-339), el fuzz de 4,000 casos con `kinds` de 4 tipos (:388), la copia congelada `computeDuesViejo` | 1 archivo, 8 literales |
| Documentos | `CLAUDE.md` regla 1 (una mención), `AUDITORIA.md` #4 y grupo A | — |

**Qué tan enredado está: poco.** `'harvest'` es un caso especial de `'date'`, no una lógica distinta: las dos ramas de `computeDues` son casi idénticas (la única diferencia real es que `'harvest'` truena si falta `creditDue` y `'date'` lo rellena con `date`), el formulario dibuja el mismo bloque para ambos, ningún motor de precio, mora, financiamiento o P&L los distingue, y la 0040 los trata como una sola categoría.

**Qué costaría quitarlo:**
- **Mínimo (dejar de ofrecerlo):** borrar 1 línea de `TERMS` en `order-form.tsx:58` (y la rama de `termLabel`). Cero pruebas rotas, cero migración. Un pedido viejo con `'harvest'` en la base seguiría funcionando porque el motor sigue aceptando el valor.
- **Máximo (quitar valor y lógica):** `order-terms.ts` (quitar de `TERM_KINDS`, colapsar la rama, ~15 líneas), `orders.ts:61`, `order-form.tsx` (3 puntos), `sales.$orderId.tsx:142`, `partner-form.tsx:210`, `CLAUDE.md` regla 1, y **reescribir** `erp-nacimiento-credito.test.mjs` (borrar 1 test, reescribir el de la 0040 con otros datos, achicar el fuzz a 3 tipos). Habría que decidir qué pasa con pedidos ya nacidos con `'harvest'` (solo datos de prueba hoy; en Neon no se verificó). Aviso: cambiar una prueba existente es la señal de "ahí se para" de METODOLOGIA § 5 — aquí es intencional y hay que decirlo con OK del dueño.

**Recomendación para cuando se decida:** el mínimo ahora (nadie debe poder capturar un plazo que no existe) y el máximo cuando se toque `order-terms.ts` por otra razón, para no abrir el motor solo por esto.

---

## 7. Hallazgos nuevos del barrido (no estaban en `AUDITORIA.md`)

Candados sin salida y defectos que salieron al levantar el mapa, sin severidad asignada (van a la ronda que les toque):

1. **Reasignar vendedor a un cliente existente es imposible por pantalla** (3.13) — `savePartner` nunca toca `seller_id`.
2. **La guía de carga se sobrescribe entre entregas parciales** y no imprime lo del evento (2.11) — incompatible con el bloque de parciales que el propio sistema construyó.
3. **El flete nunca entra al costo del kardex** (1.6); el costo financiero corre sobre el flete estimado y no el real.
4. **Gasto ligado solo a `po_id` queda huérfano** del P&L (1.7).
5. **FP en USD sin diferencial cambiario** (4.5) — ya anotado como nota al margen; ahora con el sitio exacto.
6. **No se puede crear una cuenta de banco** desde la app (4.7).
7. **Gastos y movimientos bancarios sueltos sin bitácora**; folio `GAS-` por `count(*)+1` (4.8).
8. **Kardex en pantalla capado a 200 movimientos de toda la empresa** (2.9).
9. **Sin bandera activo/inactivo en productos** (2.8).
10. **`applyRfqWinners` y la creación de OC en `decideQuote` fuera de `withTx`**; folios PV/OC/SC por `count(*)+1` (1.2).
11. **El sobrante de un cobro se descarta en silencio** (`ops.ts:1994`) — consecuencia directa de que no exista el anticipo (3.5).
12. Comentario obsoleto del #13 en `cpo.ts:57-58`.

---

## 8. Preguntas que el mapa levanta

Las que ya están abiertas se citan por clave (no se reabren): **H4c** NC/devolución a proveedor · **H5** lotes y caducidad · **H6** UOM · **L8a** costo en ajuste de entrada · **D-C** cuenta con Santa Rosa · **4.2** comisión y FEGA de la mora en el circuito · **4.5** quién absorbe el pronto pago en lineal · **4.13** Reportes como módulo. Decididas y sin construir: **D11-12** anticipo de cliente · **D13** reparto de un cobro.

Nuevas, para el dueño:
1. **Cosecha:** ¿se quita de pantalla ya (mínimo) y el motor después, o todo de una vez?
2. **Anticipo a proveedor:** ¿existe en la operación (se paga antes de recibir)? ¿Se aplica solo contra la FP de esa compra o contra cualquier FP abierta del proveedor?
3. **Plazo por OC:** ¿se pacta alguna vez un plazo distinto al de la ficha del proveedor para una compra puntual?
4. **Flete:** confirmar que los proveedores traen precio puesto en destino en todos los casos; cuando Azagro paga un flete aparte, ¿debe entrar al costo del kardex (promedio) o solo al precio?
5. **Listas de precios y descuento comercial:** ¿existen hoy en la operación (Excel, acuerdos por grupo, precio por volumen)? Si sí, ¿el descuento se aplica antes o después del margen?
6. **Zona:** ¿los clientes se agrupan por zona para precio, vendedor o reporte?
7. **Comisión de vendedor:** ¿se paga? ¿sobre venta, sobre cobro, sobre margen?
8. **Mora de proveedores:** ¿alguno cobra moratorios reales?
9. **Bancos:** ¿solo las dos cuentas Banorte, o hay más (y caja chica)?
10. **Lotes:** ¿qué productos lo exigen hoy (agroquímicos regulados) y desde cuándo?
11. **UOM:** ¿qué productos se compran en una unidad y se venden en otra?
12. **Mezclas:** ¿cuándo se planea producir en casa o por maquila? (define si BOM entra en este año).
13. **Producto inactivo:** ¿agregar la bandera, o disciplina de nombre?

---

## 9. Orden propuesto: qué es indispensable para operar y qué puede esperar

Criterio: "operar" = correr la semana en paralelo con Compaq (CLAUDE.md § Siguiente 3) sin perder dinero ni datos. Sin proponer cómo construir — solo qué va antes.

**A. Indispensable antes de operar en paralelo** (sin esto, la operación real se atora o pierde dinero):
1. **Cosecha fuera de pantalla** — una línea; no se captura lo que no existe.
2. **Anticipo de cliente (D11-12) y reparto de un cobro (D13)** — decididos hace 10 días; hoy el sobrante de un depósito se descarta y cada cobro real de un productor suele cubrir varias facturas. Son la misma pieza (saldo a favor + aplicación a N facturas).
3. **Reasignar vendedor** — candado sin salida en un dato que filtra media aplicación.
4. **Guía de carga por evento** — el bloque de parciales quedó cojo del lado del papel que firma el cliente; en operación real es la constancia de entrega.
5. **Alta de cuentas de banco** — si hay una tercera cuenta o caja, hoy no cabe.
6. **NC / devolución a proveedor (H4c)** — mercancía equivocada llega; hoy la FP se queda viva sin camino.
7. Los cierres pendientes de `AUDITORIA.md` § 4 que tocan dinero (GRUPO F #28, J #33) — ya priorizados ahí.

**B. Necesario en el primer trimestre de operación** (se puede arrancar sin ello, pero pronto duele):
8. **Producto inactivo** y **catálogo de producto** con ingrediente activo y presentación.
9. **Kardex con filtro por producto y fecha en el servidor** (hoy 200 renglones de toda la empresa).
10. **Anticipo a proveedor** (si la respuesta a la pregunta 2 es sí).
11. **FP en USD con diferencial cambiario** (si hay compras en dólares con volumen).
12. **Margen por producto y por familia**; **ventas por vendedor** — para que Reportes conteste lo que hoy contesta el Excel.
13. **Bitácora en gastos y movimientos bancarios sueltos**; folios PV/OC/SC/GAS por `folio_counters`; OC desde RFQ en transacción.
14. **Reposición real** (punto de pedido con demanda comprometida y tránsito) — hoy el mínimo avisa, no sugiere.
15. **Conteo físico** (L8a) — el primer inventario físico contra el sistema lo va a pedir.

**C. Puede esperar / depende de respuestas del dueño:**
16. **Listas de precios, escalón por volumen, descuento comercial** — solo si existen en la operación (pregunta 5); si no, la regla 8 con margen por partida ya lo cubre.
17. **UOM con conversión (H6)** y **lotes/caducidad (H5)** — estructurales sobre el kardex; se dimensionan con las respuestas 10 y 11. Van separados (son independientes) y UOM probablemente antes que lotes.
18. **Fórmulas / mezclas (BOM)** — el menos invasivo de los estructurales; entra cuando se decida producir o maquilar (pregunta 12).
19. **Liquidación con Santa Rosa (D-C)** — Fase 3 del circuito lineal; hoy se lleva fuera del sistema.
20. **Rotación, DSO, top deudores, concentración, valuación histórica, cierre de periodo, exportar cartera y estado de cuenta** — reportes y candados de madurez.
21. **Comisiones de vendedor, zona, aprobación de OC por monto, propuesta de pago a proveedores, importar estado de cuenta bancario** — según respuestas 6, 7, 9.
