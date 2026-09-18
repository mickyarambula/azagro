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

**El tipo de cambio** (§ 11) es lo que más pesa: el TC se congela bien del lado cliente (cotización → pedido → FV → cobro con ATC), pero **el costo no tiene moneda en ningún lado** — un costo en dólares que llega a una cotización en pesos se precia como pesos, el kardex pondera dólares con pesos, la OC desde RFQ nace con TC = 1, y una FP en dólares se paga mezclando pesos contra un saldo en dólares sin diferencial. **El costo del proveedor con vigencia** (§ 10): la vigencia al cliente sí sirve de molde; del lado proveedor hoy no hay nada que fechar.

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
| 3.1 | Listas de precios por cliente, por grupo/zona | ✗ | `products.list_price` único por empresa; `partner_products` kind `sell` solo **registra** el último precio pactado (`links.ts:14-27`) y ningún camino de precio lo lee. `group_name` es texto libre para filtrar. | No hay lista ni precio pactado reutilizable; cada cotización recalcula desde cero. **Corrección del dueño (17-sep): no se construyen listas** — lo que se guarda es el costo del proveedor con vigencia (§ 10). |
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

Candados sin salida y defectos que salieron al levantar el mapa, sin severidad asignada (van a la ronda que les toque). Los marcados **$** tocan dinero directamente.

1. **Reasignar vendedor a un cliente existente es imposible por pantalla** (3.13) — `savePartner` nunca toca `seller_id`.
2. **La guía de carga se sobrescribe entre entregas parciales** y no imprime lo del evento (2.11).
3. **$ El flete nunca entra al costo del kardex** (1.6); el costo financiero corre sobre el flete estimado y no el real.
4. **$ Gasto ligado solo a `po_id` queda huérfano** del P&L (1.7).
5. **$ FP en USD sin diferencial cambiario** (4.5, § 11).
6. **No se puede crear una cuenta de banco** desde la app (4.7).
7. **Gastos y movimientos bancarios sueltos sin bitácora**; folio `GAS-` por `count(*)+1` (4.8).
8. **Kardex en pantalla capado a 200 movimientos de toda la empresa** (2.9).
9. **Sin bandera activo/inactivo en productos** (2.8).
10. **`applyRfqWinners` y la creación de OC en `decideQuote` fuera de `withTx`**; folios PV/OC/SC por `count(*)+1` (1.2).
11. **$ El sobrante de un cobro se descarta en silencio** (`ops.ts:1994`) — consecuencia de que no exista el anticipo (3.5).
12. Comentario obsoleto del #13 en `cpo.ts:57-58`.
13. **$ El costo no tiene moneda en ningún lado** (§ 11.2): `products.cost`, `ref_cost`, `quote_lines.cost`, `purchase_lines.unit_price` y el promedio del kardex son números sin unidad; `applyRfqWinners` copia el bid ganador crudo a `quote_lines.cost` (`rfq.ts:236-241`) aunque la RFQ sea en USD y la cotización en MXN; `assertCostForCredit` solo exige `cost > 0`.
14. **$ `applyRfqWinners` crea la OC con `fx_rate = 1` hardcodeado** (`rfq.ts:283-287`) aunque la RFQ sea en USD — viola la regla 9.
15. **$ `dealPnlCore` resta `po_cost` crudo contra `saleUnit` sin convertir moneda** (`reports.ts:296-326`): el margen de un pedido con moneda mixta no es margen en ninguna de las dos.
16. **$ Pago a una FP en USD: la pantalla ofrece TC y tratamiento, el servidor los ignora** (`ops.ts:1973-1996`): pesos depositados se aplican 1:1 contra un saldo en dólares.
17. **FP normal en USD (`amount` crudo en USD, sin `amount_fx`) y FP del corte (`amount` en pesos) conviven en `invoices` sin nada que las distinga** (`azagro.ts:1345-1372, 1606-1609` vs `cutover-core.ts:356-379`).
18. **El TC de cotización y pedido no se revalida contra `fx_rates` al guardar** (a diferencia de la TIIE, `ops.ts:911-919`): `quotes.tsx:450` y `orders.ts:551-553` aceptan cualquier número; `saveOrder` propone el último renglón de la tabla aunque sea futuro (`orders.ts:113-115`).
19. **`saveFx` pisa el TC de una fecha ya usada** (`ops.ts:544`, `on conflict do update`) sin versión.
20. **El bloque «Dólar americano» del estado de cuenta imprime pesos con signo US$** (`statements.tsx:76-78,183-221`, `doc-text.ts:200-217`): `r.cargo`/`r.saldo` son `invoices.amount`, que en una FV USD es el importe en MXN.
21. **La estimación del diferencial en el estado de cuenta abierto usa `amount_fx` completo y un solo `fx_paid`** (`ops.ts:2491-2494`), no lo abierto ni un promedio ponderado — el cobro sí lo hace bien (`fxPaymentSplit`).
22. **`rememberTrade` pisa `partner_products.unit_price` sin fecha, origen ni bitácora** (`links.ts:144-156`); `vendor_rfq_bids` no tiene fecha, moneda ni vigencia (migración 0010:9-40).
23. **Sin reporte de posición en moneda extranjera** ni revaluación de saldos abiertos (§ 11.4).

---

## 8. Preguntas: las contestadas contra el código y las que sí son decisión de negocio

Criterio: esto es una distribuidora estándar y el sistema tiene que soportarlo todo. Lo que el estándar contesta solo, se contesta aquí; solo queda para el dueño lo que no se puede resolver leyendo.

Las que ya estaban abiertas se citan por clave (no se reabren): **H4c** NC/devolución a proveedor · **H5** lotes y caducidad · **H6** UOM · **L8a** costo en ajuste de entrada · **D-C** cuenta con Santa Rosa · **4.2** comisión y FEGA de la mora en el circuito · **4.5** quién absorbe el pronto pago en lineal · **4.13** Reportes como módulo. Decididas y sin construir: **D11-12** anticipo de cliente · **D13** reparto de un cobro.

### 8.1 Contestadas con el criterio de distribución estándar

| Pregunta | Respuesta | Por qué |
|---|---|---|
| Cosecha | **Se quita.** De pantalla ya (una línea); del motor cuando se abra `order-terms.ts` por otra razón. Falta asentarlo en `DECISIONES.md`. | El dueño dijo que no existe en su operación (§ 6). |
| Anticipo a proveedor | **Se soporta**, aplicable contra cualquier FP abierta del proveedor — el espejo de la Decisión 12. | Toda distribuidora paga anticipos a proveedores; el estándar no distingue "la FP que lo originó". |
| Plazo distinto por OC | **Se soporta**: la ficha propone, la OC puede pactar otro. | Es el mismo patrón que ya tiene el cliente (política en la ficha, el pedido la propone). |
| Flete que Azagro paga aparte | **Entra al costo del kardex** (landed cost) cuando se liga a la OC; y el costo financiero corre sobre el flete real, no el estimado. Cuando el proveedor trae precio puesto, flete = 0 y nada cambia. | Estándar de valuación de inventario; hoy el flete solo vive en el precio (1.6). |
| Listas de precios / escalón por volumen | **No se construyen.** | Corrección del dueño: no hay listas formales; lo que se guarda es el **costo del proveedor con vigencia** (§ 10). |
| Descuento comercial | **Se soporta como renglón aparte del margen** (`discount` en la partida): el precio sale de la fórmula (regla 8) y el descuento lo baja después; el P&L reporta el margen real neto. | Estándar; hoy el único modo de bajar un precio es bajar el margen, y eso esconde la concesión. |
| Zona | **Un campo en la ficha**, cuando un reporte lo pida. | Barato; no decide dinero. |
| Mora que cobran proveedores | **Sin motor**: si un proveedor cobra moratorios, se captura como gasto financiero cuando llega. | El estándar no calcula intereses del lado proveedor; los registra. `reports.ts:940` queda correcto. |
| Bancos | **Alta de cuentas desde la app, incluida caja/efectivo.** | Estándar; hoy solo las dos sembradas (4.7). |
| UOM con conversión | **Se soporta** (unidad de compra, de venta y de kardex con factor). Qué productos lo necesitan es dato de catálogo, no decisión. | H6 queda como pregunta de dimensionamiento, no de diseño. |
| Mezclas / BOM | **Después**: cuando se decida producir o maquilar. | El dueño ya dijo "a futuro". |
| Producto inactivo | **Bandera `is_active`**, fuera de los selectores, conserva historial. | Estándar. |
| Moneda del costo | **Todo costo lleva moneda; el kardex vive en pesos y convierte al recibir con el TC de la OC**; la cotización convierte el costo a su moneda con su TC congelado. | Estándar (§ 11.5); hoy es el hueco 13. |
| Diferencial cambiario del lado proveedor | **Simétrico al del cliente**, automático al pagar, sobre lo abierto. | Estándar; hoy no existe (hueco 16). |
| Vigencia del costo: ¿global, por familia o por producto? | **Por producto, con valor por omisión en Ajustes** (regla 9: el número vive en Ajustes; la excepción vive en el producto). | El dueño dijo que unos cambian mucho y otros poco; "por familia" exige un catálogo de familias que hoy es texto libre. |

### 8.2 Las que sí son decisión de negocio (no se resuelven leyendo)

1. **Comisiones a vendedores.** ¿Se pagan? ¿Sobre venta facturada, sobre cobrado, o sobre margen? Hoy no existe nada (3.14) y el estándar admite las tres bases.
2. **Lotes y caducidad (H5): cuándo y en qué productos.** El diseño está claro (se soporta); lo que no se sabe es si hace falta en el primer trimestre o después, y para qué familias — eso mueve el orden de § 9.
3. **Costo vencido al cotizar: ¿avisa o bloquea?** (§ 10.4). Si el costo del proveedor vence antes que la cotización al cliente, el estándar avisa y deja cotizar bajo responsabilidad del vendedor. Bloquear es una política de riesgo tuya.
4. **Venta en pesos con costo en dólares: ¿quién absorbe el movimiento del TC entre cotizar y pagar la OC?** Hoy queda en Azagro sin que nadie lo vea (§ 11.2). Las salidas estándar son: cotizar en dólares a esos clientes, vigencia corta cuando el costo es en USD, o un aviso con el TC de referencia en el papel. La Decisión 2 ("el cliente asume el riesgo cambiario") cubre la venta en USD, no este caso.
5. **¿La OC al proveedor en dólares se paga desde la cuenta en dólares o desde la de pesos?** Cambia si hace falta TC al pagar la FP (§ 11.3). Ambas cuentas existen.

---

## 9. Orden propuesto: qué es indispensable para operar y qué puede esperar

Criterio: "operar" = correr la semana en paralelo con Compaq (CLAUDE.md § Siguiente 3) sin perder dinero ni datos. Sin proponer cómo construir — solo qué va antes.

**A. Indispensable antes de operar en paralelo** (sin esto, la operación real se atora o pierde dinero):
1. **Moneda del costo y del TC en compras** (§ 11, huecos 13-16): que un costo lleve moneda, que la OC desde RFQ no nazca con TC = 1, que el P&L no reste dólares contra pesos, y que pagar una FP en dólares no mezcle pesos contra dólares. Con "gran parte de la operación en dólares", esto está por encima de todo lo demás: pierde dinero en silencio en cada compra en USD.
2. **Cosecha fuera de pantalla** — una línea; no se captura lo que no existe.
3. **Anticipo de cliente (D11-12) y reparto de un cobro (D13)** — decididos hace 10 días; hoy el sobrante de un depósito se descarta y cada cobro real de un productor suele cubrir varias facturas. Son la misma pieza (saldo a favor + aplicación a N facturas). Con el anticipo a proveedor como espejo (8.1).
4. **Reasignar vendedor** — candado sin salida en un dato que filtra media aplicación.
5. **Guía de carga por evento** — el bloque de parciales quedó cojo del lado del papel que firma el cliente.
6. **Alta de cuentas de banco** — si hay una tercera cuenta o caja, hoy no cabe.
7. **NC / devolución a proveedor (H4c)** — mercancía equivocada llega; hoy la FP se queda viva sin camino.
8. Los cierres pendientes de `AUDITORIA.md` § 4 que tocan dinero (GRUPO F #28, J #33) — ya priorizados ahí.

**B. Necesario en el primer trimestre de operación** (se puede arrancar sin ello, pero pronto duele):
9. **Costo del proveedor con vigencia** (§ 10) y el aviso "costo vence antes que la cotización" — es la pieza que sustituye a las listas de precios y la que protege el margen al cotizar.
10. **Producto inactivo** y **catálogo de producto** con ingrediente activo y presentación.
11. **Kardex con filtro por producto y fecha en el servidor** (hoy 200 renglones de toda la empresa).
12. **Flete real al costo del kardex** y al costo financiero (8.1).
13. **Descuento comercial** como renglón (8.1).
14. **Margen por producto y por familia**; **ventas por vendedor**; **posición en moneda extranjera** — para que Reportes conteste lo que hoy contesta el Excel.
15. **Bitácora en gastos y movimientos bancarios sueltos**; folios PV/OC/SC/GAS por `folio_counters`; OC desde RFQ en transacción; TC revalidado contra la tabla al guardar.
16. **Reposición real** (punto de pedido con demanda comprometida y tránsito) — hoy el mínimo avisa, no sugiere.
17. **Conteo físico** (L8a) — el primer inventario físico contra el sistema lo va a pedir.

**C. Puede esperar / depende de respuestas del dueño:**
18. **UOM con conversión (H6)** y **lotes/caducidad (H5)** — estructurales sobre el kardex; van separados y UOM antes que lotes; lotes según la respuesta 8.2-2.
19. **Fórmulas / mezclas (BOM)** — el menos invasivo de los estructurales; entra cuando se decida producir o maquilar.
20. **Liquidación con Santa Rosa (D-C)** — Fase 3 del circuito lineal; hoy se lleva fuera del sistema.
21. **Rotación, DSO, top deudores, concentración, valuación histórica, cierre de periodo, revaluación de saldos en USD, exportar cartera y estado de cuenta** — reportes y candados de madurez.
22. **Comisiones de vendedor, zona, aprobación de OC por monto, propuesta de pago a proveedores, importar estado de cuenta bancario** — según 8.2-1 y volumen.

---

## 10. Costo del proveedor con vigencia (corrección del dueño, 17-sep-2026)

**Lo que el dueño corrigió:** no hay listas de precios formales y **no se construye** un catálogo de listas con vigencias que nadie mantenga. Lo real: el costo se corrobora con el proveedor, pero si ya se cotizó hace poco se usa el que se tiene; unos productos cambian mucho y otros poco. La propuesta a evaluar: **guardar el costo del proveedor con vigencia** — cada cotización a proveedor deja el costo con su fecha y hasta cuándo vale; la siguiente vez el sistema lo propone y avisa si sigue vigente o ya venció. Se llena solo con el trabajo que ya se hace.

### 10.1 El molde: la vigencia hacia el cliente, como está construida

| Pieza | Dónde | Qué hace |
|---|---|---|
| Dato | `quotes.valid_until` (insert en `createQuote`, `ops.ts:948`) | Fecha congelada en el documento al nacer; no hay estado "vencida". |
| Parámetro | `company_settings.quote_validity_days` (migración 0028:6) | Días en Ajustes, sin default: si no está capturado la pantalla se detiene (regla 9). La pantalla lo propone (`quotes.tsx:250`) y se congela al guardar. |
| Regla | `quoteStillBlocks(state, validUntil, today)` (`request-lock.ts:33-38`) | Función pura, derivada por fecha en cada lectura: aceptada siempre bloquea, rechazada nunca, draft/sent solo si `validUntil ≥ hoy`. |
| Candado con salida | `decideQuote` rechaza una vencida (`ops.ts:1583-1587`) | Salida: `duplicateQuote` (`ops.ts:1027`) o `quoteFromRequest` de nuevo (`requests.ts:821`) — tasas de HOY, la vieja se conserva con su folio. |
| Pantalla y papel | `quotes.tsx:674` (`expired`), `:388` (`Vigencia …` en el papel) | El mismo dato leído, sin duplicarlo. |
| Prueba | `scripts/erp-recotizar.test.mjs` | Los cuatro casos del candado y los dos caminos de recotizar. |

**Veredicto: sí sirve de molde**, byte a byte en la regla (función pura fecha-vs-hoy), en el candado con salida y en la prueba. Lo que **no** calza tal cual es el parámetro: la vigencia del cliente es un número global en Ajustes; la del costo tiene que ser por producto con un valor por omisión en Ajustes, porque "unos cambian mucho y otros poco" (8.1).

### 10.2 Qué guarda hoy el sistema del costo cotizado por proveedor

- `vendor_rfq_bids` (migración 0010:9-40): `rfq_id, partner_id, product_id, unit_price`. **Sin fecha, sin moneda, sin vigencia.** Ninguna migración posterior le agregó nada.
- `partner_products` kind `buy` (migración 0009:3-12): `partner_id, product_id, unit_price, notes`, único por par. **Sin fecha, sin moneda.** `rememberTrade` (`links.ts:121-168`) hace `on conflict do update set unit_price` — el último pisa al anterior sin rastro de cuándo ni de dónde vino (bid, OC adjudicada, cotización manual o captura a mano: todos escriben ahí).
- **¿Se reúsa un costo de una RFQ anterior?** No: `createRfq` (`rfq.ts:136-180`) y `saveRfqBid` (`:182-206`) arrancan de cero; ningún sitio lee un bid anterior para proponerlo. `partner_products` solo se usa para decidir **a quién invitar** (`solicitudes.$solicitudId.tsx:186-188`), nunca para proponer un precio.
- **¿Se sabe si un costo es de ayer o de hace tres meses?** No. `vendor_rfqs.created_at` existe, pero el `unit_price` que sobrevive en `partner_products` no sabe de qué RFQ, OC o captura salió.
- **¿La cotización al cliente propone un costo?** Sí, pero sin proveedor: `createQuote` (`ops.ts:965-968`) → `resolveCost` (`cost.ts:20-26`): **kardex → `ref_cost` → nada**. Con RFQ, `quoteFromRequest` usa `customer_request_lines.cost`, llenado por `applyCheapest` (`requests.ts:759-801`, el bid más barato del RFQ vivo) o a mano.

### 10.3 ¿Cabe encima de lo que existe? Tamaño

`partner_products` es "el último precio conocido por par", no un historial: cada escritura pisa. Dos opciones, sin proponer construir:

- **(a) Mínima:** dos columnas en `partner_products` (`quoted_at`, `valid_until`) + `currency`. Un solo renglón vigente por proveedor+producto; sin "cuánto costaba antes". Barata; suficiente para "propón y avisa si venció".
- **(b) Con historial:** tabla de costos cotizados (proveedor, producto, costo, **moneda**, fecha, vence, origen: bid / OC / manual). Conserva cada captura; permite ver la curva de un producto que "cambia mucho". Es la que resuelve también el hueco 22 (sin rastro de cambios de costo).

En cualquiera de las dos:
- **Sitios de escritura** (donde el sistema se entera de un costo nuevo — todos ya existen, solo hay que fecharlos): `saveRfqBid` (`rfq.ts:182-206`), `applyRfqWinners` (`:208-311`), la OC confirmada (`createPurchase`, hoy no toca `partner_products`), y el `line.cost` tecleado en `createQuote` (`ops.ts:939,968`, hoy solo va a `quote_lines`).
- **Sitios de lectura** (donde se propondría): la RFQ nueva (precio + fecha al lado de cada proveedor invitado), `createQuote` (un tercer origen "costo de proveedor vigente" antes de caer a `ref_cost`), la OC manual.
- **Parámetro:** `products.cost_validity_days` con valor por omisión en Ajustes (mismo patrón que `ref_cost`, migración 0016).
- **Regla vigente/vencido:** la función pura de 10.1, reusada.
- **Moneda obligatoria en el costo** — es el mismo hueco del § 11: sin moneda, fechar el costo no basta.

### 10.4 Lo que cuesta dinero: vigencia del costo vs vigencia de la cotización

**¿El sistema lo vigila hoy?** No al cotizar. La única comparación costo-cotizado vs costo-real ocurre **después de la venta**, en `dealPnlCore` (`reports.ts:312-326`): "el costo real manda: OC del proveedor, luego el de la cotización". Si el proveedor subió entre cotizar y comprar, el P&L del pedido ya trae el costo más caro — **en silencio**: no hay aviso, ni columna "diferencia contra lo cotizado", solo una utilidad más baja que la proyectada. `createQuote`, `decideQuote` y `reviseQuote` no comparan nada porque en ese momento el costo real no existe, y el costo con fecha tampoco.

**Cómo avisarlo al cotizar (diseño, sin código):** con el costo fechado de 10.3, al cotizar se compara `costo.vence < cotización.valid_until` y la pantalla dice, con fechas: "El costo de [producto] con [proveedor] vence el [fecha]; la cotización vale hasta el [fecha]: [N] días de margen expuesto". Nunca en el papel (regla 7). Que avise o bloquee es la decisión 8.2-3; el estándar avisa. Complemento natural: al confirmar la OC real, si su costo difiere del cotizado, un renglón en el P&L del pedido que diga cuánto se movió — hoy ese número existe pero no se enseña.

---

## 11. El tipo de cambio

Gran parte de la operación es en dólares y el TC mueve los precios. Esta sección recorre el TC de punta a punta contra el código del 17-sep-2026.

### 11.1 Dónde se congela el TC hoy

| Documento / momento | De dónde sale | Dónde se guarda | ¿Cambia después? |
|---|---|---|---|
| Tabla `fx_rates` (migración 0003:87-93) | Admin captura por fecha (`saveFx`, `ops.ts:531-555`) | `fx_rates(date, usd_mxn)`, único por fecha | `on conflict do update` (`ops.ts:544`): se pisa sin versión; bitácora sí. |
| Cotización nueva (`createQuote`, `ops.ts:843-955`) | La pantalla propone `nearestRate(tabla, hoy)` (`quotes.tsx:247-249`) en un campo **editable** (`:450`) | `quotes.fx_rate` (`ops.ts:948-952`) | El servidor **no revalida** contra la tabla (la TIIE sí, `ops.ts:911-919`); solo exige `> 0`. |
| `reviseQuote` (`ops.ts:1228-1420`) | No toca `fx_rate` | Congelado desde la original | — |
| Duplicar vencida/rechazada (`ops.ts:1040-1226`) | `nearestRate` al duplicar (`:1112-1118`); sin tabla se detiene | `quotes.fx_rate` nuevo | — |
| Pedido desde cotización (`decideQuote`) | **Hereda** `q.fx_rate` (`ops.ts:1672`) | `sales_orders.fx_rate` | No se recalcula. |
| Pedido directo (`saveOrder`, `orders.ts:537-553`) | La pantalla propone el **último renglón** de la tabla aunque sea futuro (`orders.ts:113-115`), editable | `sales_orders.fx_rate` | Sin revalidación. |
| OC desde cotización aceptada (`decideQuote`) | `q.fx_rate` — **el TC pactado con el cliente** (`ops.ts:1719-1721`) | `purchase_orders.fx_rate` | El TC del proveedor nunca se captura aparte. |
| OC desde RFQ de inventario (`applyRfqWinners`) | **`fx_rate = 1` hardcodeado** (`rfq.ts:283-287`) aunque `vendor_rfqs.currency = 'USD'` | `purchase_orders.fx_rate = 1` | Defecto: viola la regla 9. |
| FV de entrega (`issueDeliveryInvoice`) | `so.fx_rate`, el del **pedido**, no el del día de la entrega (`azagro.ts:2003`) | `amount` en MXN, `amount_fx = mxn / fx`, `fx_agreed` (`:2059`) | No. |
| FP por OC o por recepción (`bornSupplierDebt*`) | `po.fx_rate` | **`amount` en la moneda de la OC, sin convertir; `amount_fx` nunca se escribe** (`azagro.ts:1345-1372, 1606-1609`) | No. |
| Cobro de FV en USD (`applyInvoicePayment`) | TC del día del pago, capturado en pantalla (`fxPaid`) | `fx_paid` (el último), `fx_result` o ATC; `fx_agreed` no cambia (`ops.ts:2076`) | Cada pago trae su TC. |
| Corte Compaq (`cutover-core.ts:228-236, 356-379`) | `fxAtCutover` (último renglón ≤ fecha del corte; sin renglón se rechaza, D70) | `amount`/`residual` en **pesos**, `amount_fx`, `fx_agreed` — **cliente y proveedor por igual** | No. |

Resumen: del lado **cliente** el TC se congela una vez (cotización), viaja al pedido y a la FV, y el cobro captura el del día con su diferencial. Del lado **proveedor** el TC de la OC es el del cliente (vía cotización) o 1 (vía RFQ), la FP nace en dólares crudos sin equivalente en pesos, y el pago no captura nada.

### 11.2 Qué pasa con el margen cuando el TC se mueve

**El hallazgo de fondo:** `priceSale`/`priceSaleLineal` (`pricing.ts`) reciben `cost` como número puro, sin moneda. `products.cost`, `ref_cost` (`cost.ts:39-47`), `quote_lines.cost`, `purchase_lines.unit_price` y el promedio móvil (`stock.ts:163-206`) tampoco tienen moneda. `applyRfqWinners` copia el bid ganador **tal cual** a `quote_lines.cost` (`rfq.ts:236-241`) sin comparar `vendor_rfqs.currency` con `quotes.currency`. `assertCostForCredit` (`cost.ts:55-71`) solo verifica `cost > 0`.

**Caso con el código (costo 1,000 USD, TC 17.50 al cotizar, cliente en MXN, margen 20 %, sin financiamiento para simplificar):**

| Etapa | Lo que hace el sistema | Lo que pasa con el dinero |
|---|---|---|
| Cotizar, si el costo entró por RFQ en USD | `quote_lines.cost = 1000` se precia **como pesos**: precio = 1,000 ÷ 0.80 = **1,250 MXN** | El costo real puesto es 17,500 MXN. Se prometió 1,250 por algo que cuesta 17,500. **Ninguna pantalla lo detecta.** |
| Cotizar, si alguien capturó 17,500 MXN a mano | precio = 17,500 ÷ 0.80 = **21,875 MXN**, margen 4,375 | Correcto al cotizar; el TC 17.50 queda implícito en el precio y **la exposición nace aquí**. |
| Confirmar | `decideQuote` hereda el TC; la OC hereda el TC del cliente (17.50) | El TC real del proveedor no se captura. |
| Comprar / pagar la OC a 18.50 | FP en USD crudos (1,000); el pago aplica pesos contra dólares 1:1 (11.3); sin ATC de proveedor | Costo real 18,500 MXN. **Margen real 3,375 (15.4 %), no 4,375 (20 %).** La pérdida de 1,000 MXN no aparece en ningún lado. |
| Entregar / facturar | FV en MXN al TC del pedido | — |
| P&L del pedido | `dealPnlCore` usa `po_cost = purchase_lines.unit_price` **crudo** (1,000, en USD) contra `saleUnit` en MXN (`reports.ts:296-326`) | El "margen" mezcla dólares con pesos: no es margen en ninguna moneda. |

**Cliente en USD y Azagro compra en USD** (la cobertura natural): el margen queda en dólares *si* las dos patas quedaron en USD — pero el sistema no lo garantiza: si la OC nació con `fx_rate = 1` (RFQ) o en MXN por descuido, el margen queda expuesto sin que nadie lo haya decidido ni lo vea.

**El caso real del Excel (31-ago, `EXCEL_VS_SISTEMA.md` § 4), del lado cliente:** FV de 10,000 USD a TC pactado 19.00 → `amount = 190,000`, `amount_fx = 10,000`. El cliente deposita 186,000 MXN (TC real 18.60). Hoy `fxPaymentSplit` (`credit.ts:389-405`) escala contra lo abierto: 186,000 ÷ 18.60 = 10,000 USD → la factura queda pagada en dólares; el diferencial 10,000 × (19.00 − 18.60) = **4,000 MXN** se trata según `fxTreatment` (`ops.ts:2054-2089`): pérdida en `fx_result`, o un **ATC por cobrar** de 4,000 que queda abierto. Son exactamente las dos salidas del Excel ("se asume como pérdida" o "quedan $4,000 POR COBRAR"). **Este lado está bien construido.** Lo que el Excel hacía y el sistema no: la vista bimoneda del estado de cuenta (hoy imprime pesos con signo US$, hueco 20) y el cobro de mora en dólares (las FI son siempre en pesos).

### 11.3 ¿FP en USD y FV en USD usan el mismo TC?

**No, y nada los compara.** En un pedido directo/brokeraje (`deliverPartial`, `azagro.ts:1824-1913`): `issueDeliveryInvoice` (`:1881`) usa `so.fx_rate` (pactado con el cliente); `bornSupplierDebtByReceipt` (`:1901-1909`) usa `po.fx_rate` (de esa OC). Pueden diferir libremente — una OC a 18.00 sirviendo una venta pactada a 17.50 — y `dealPnlCore` no tiene una línea "diferencial FP↔FV": resta crudos.

Además, la FP en USD **no se paga bien**: `applyInvoicePayment` solo activa el tratamiento cambiario si `kind === 'customer'` (`ops.ts:1973-1974`); para proveedor cae a `applied = min(amount, residual)` (`:1993-1996`) y `fxPaid` solo sirve para un memo (`:2043`). La pantalla de `/credit` ofrece los mismos controles de TC y tratamiento para pagar a proveedor, así que la persona los usa creyendo que se registran. Como el `residual` está en dólares crudos, **pesos depositados se aplican 1:1 contra dólares**: pagar 18,500 MXN a una FP de 1,000 USD la deja con residual −17,500. Si se paga desde la cuenta Banorte USD el importe cuadra, pero sigue sin diferencial ni equivalente en pesos para el P&L.

### 11.4 El diferencial cambiario: qué captura el ATC y qué se pierde

| Caso | Hoy | Se pierde / se gana sin verse |
|---|---|---|
| (a) FP en USD pagada a otro TC | Nada: `isUsdCustomer` excluye proveedor | **Todo** el diferencial del lado compras. Y el saldo de la FP queda mal si el pago fue en pesos. |
| (b) FV en USD cobrada parcialmente | El abono real está bien (`fxPaymentSplit` contra `residualMxn`, tratamiento por pago) | La **estimación** del estado de cuenta abierto (`ops.ts:2491-2494`) usa `amount_fx` completo y un solo `fx_paid`: con dos pagos a TC distintos, lo que se ve antes de liquidar no es lo pendiente. |
| (c) Pedido en USD con costo en USD | `dealPnlCore` resta crudos sin conversión | No hay "diferencial" identificable: hay un margen sin unidades. |
| (d) Reversa de un cobro con ATC | Correcta (`reversal.ts:207-375`): reconstruye `fx_result`, `fx_paid`, marca el ATC | Solo del lado que sí se capturó; del proveedor no hay nada que revertir. |
| (e) El corte | FP USD del corte entra en **pesos** con `amount_fx` (D70) | Convive con la FP normal en **dólares crudos** en la misma tabla, sin columna que las distinga (hueco 17): cualquier suma por `kind='supplier'` mezcla. |
| Posición en moneda extranjera / revaluación | No existe | Nadie sabe cuánto se debe y cuánto nos deben en USD hoy, ni cuánto vale eso al TC de hoy. |

### 11.5 Qué hace un ERP de distribución que vende en dos monedas (Odoo, como referencia abierta)

Odoo, con una empresa cuya moneda es MXN, hace esto — y es lo que hace cualquier ERP contable serio:

1. **Una moneda de la empresa; todo documento lleva la suya y su TC a su fecha.** `res.currency.rate` es una tabla por fecha (se puede alimentar sola de Banxico). Cada factura, factura de proveedor y pago guarda el importe en su moneda **y** el equivalente en MXN al TC de **su propia fecha** (fecha de factura, fecha de pago). El TC de una cotización es referencia; **la factura re-convierte a la fecha de factura**.
2. **La deuda en moneda extranjera es la verdad.** Una factura de 10,000 USD está pagada cuando se recibieron 10,000 USD, punto. Si el cliente paga en MXN, el pago se convierte al TC de la fecha del pago y lo que quede en USD sigue abierto — el "por cobrar" del Excel sale solo, sin documento aparte.
3. **El diferencial realizado es automático y simétrico.** Al conciliar pago contra factura, la diferencia en MXN entre el TC de la factura y el del pago se asienta sola en el diario de diferencias cambiarias (ganancia o pérdida), **sobre lo que se está liquidando**, del lado cliente **y** del lado proveedor por igual. No hay decisión "por lote"; la utilidad/pérdida cambiaria es un resultado, no una negociación.
4. **El no realizado se revalúa al cierre.** Reporte de "revaluación de moneda extranjera": los saldos abiertos en USD se valúan al TC de fin de periodo y la diferencia se asienta con reversa automática al día siguiente. Contesta "¿cuánto valen hoy mis cuentas en dólares?".
5. **El inventario se valúa en la moneda de la empresa, siempre.** Una OC en USD se convierte a MXN al TC de la recepción (o de la factura del proveedor, con ajuste por diferencia de precio); el promedio móvil nunca mezcla monedas. El costo del producto (`standard_price`) es MXN.
6. **Precios y costos con moneda explícita.** Una lista de precios tiene moneda; un costo de proveedor (`product.supplierinfo`) tiene moneda, fecha y vigencia (`date_start`/`date_end`) — exactamente la pieza de § 10, con historial.
7. **Cotizar en pesos con costo en dólares no lo protege nadie**: ni Odoo. Es un control de negocio: cotizar en USD, vigencia corta, o cláusula de TC en el papel (8.2-4).

**Dónde diverge Azagro del estándar (los huecos 13-23 en una línea cada uno):** el costo y el kardex no tienen moneda (5, 6); el diferencial solo existe del lado cliente (3); la FP en USD no tiene equivalente en pesos ni se paga con TC (1, 3); no hay revaluación ni posición (4); el TC de cotización y pedido se captura libre sin revalidar (1); la FV toma el TC del pedido, no de la fecha de factura (1 — esto es una decisión de negocio de Azagro, "TC pactado", que el Excel también seguía; conviene dejarla así y decirlo). Lo que Azagro tiene y Odoo no: el **ATC "por cobrar / por devolver"** como documento negociado con el cliente — es una práctica real del negocio (Excel § 4), no un defecto.
