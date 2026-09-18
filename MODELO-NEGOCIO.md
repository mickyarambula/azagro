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

**El tipo de cambio** (§ 11) es lo que más pesa — y el dueño lo enmarcó el 17-sep: las líneas de crédito son **en pesos**, la operación es en buena parte **en dólares**, y el crédito largo agranda ese desajuste; el **TC pactado es la herramienta de cobertura**, con dos dinámicas reales (§ 11.0) que el sistema tiene que soportar explícitamente y una **posición cambiaria** (§ 11.6) que hoy no existe. Lo ya encontrado sigue primero: el TC se congela bien del lado cliente (cotización → pedido → FV → cobro con ATC), pero **el costo no tiene moneda en ningún lado** — un costo en dólares que llega a una cotización en pesos se precia como pesos, el kardex pondera dólares con pesos, la OC desde RFQ nace con TC = 1, y una FP en dólares se paga mezclando pesos contra un saldo en dólares sin diferencial. **El costo del proveedor con vigencia** (§ 10): la vigencia al cliente sí sirve de molde; del lado proveedor hoy no hay nada que fechar.

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
24. **$ Comprar dólares no se puede registrar**: la transferencia entre cuentas (`addBankMove`, `ops.ts:2185-2253`) no pide TC ni valida moneda e inserta el mismo importe en las dos cuentas (`:2239-2249`): 18,000 MXN de Banorte MXN a Banorte USD acreditan "18,000" en la cuenta en dólares. La UI (`banks.tsx:205-234`) tampoco lo pide.
25. **$ El inicio suma pesos y dólares en un solo número**: `cash` (`azagro.ts:419-425`) suma todas las cuentas sin `currency`; `ar`/`ap` (`:318-331`) suman residuales de todas las monedas; `getPanorama` (`reports.ts:736-825`) agrega 500 pedidos sin moneda.
26. **`listInvoices` no expone `amount_fx`, `fx_agreed` ni `fx_paid`** (`azagro.ts:2644-2733`); `getUpcomingPayable` (`reports.ts:945-972`) ni siquiera trae `currency`; `getUpcomingDue` separa "de docs. USD" pero el total del bucket sigue mixto (`vencimientos.tsx:106,187-206`).
27. **No hay un helper "TC de hoy"**: cinco pantallas repiten `nearestRate(tabla, hoy)` con su propia consulta (`orders.ts:113`, `quotes.tsx:247`, `ops.ts:1107`, `cpo.ts:192`, `cutover-core.ts:232`); el TC vigente solo se ve en Ajustes, no en el inicio.

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

**A. Indispensable antes de operar en paralelo** (sin esto, la operación real se atora o pierde dinero). Con la corrección del dueño (§ 11.0), el tipo de cambio ocupa los dos primeros lugares y no se mueve de ahí:
1. **Moneda y TC en toda la cadena de compra** (§ 11.2-11.3, huecos 13-17, 24): que un costo lleve moneda; que la OC declare **su** TC (el del proveedor), no el del cliente ni 1; que la FP nazca con `amount_fx` y `fx_agreed`; que pagar una FP en dólares capture el TC y genere su diferencial (espejo del ATC); y que **comprar dólares** sea un movimiento con TC (pesos salen, dólares entran, TC de compra guardado). Sin esto, ninguna de las dos dinámicas del dueño se puede registrar: la 1 porque comprar dólares acredita pesos como dólares, la 2 porque pagar en pesos al TC del proveedor mezcla pesos contra un saldo en dólares. Y el P&L deja de restar dólares contra pesos.
2. **Posición cambiaria** (§ 11.6): la vista que hoy no existe — cuánto se debe y nos deben en dólares por vencimiento, a qué TC se pactó cada documento vivo contra el TC de hoy, cuánto se gana o pierde si el dólar se mueve X pesos, y qué parte está cubierta y cuál abierta. Depende de 1 (sin `amount_fx` en la FP y sin TC en la compra de dólares no hay con qué calcularla). Tarjeta en el inicio con el TC de hoy y la exposición neta.
3. **Cosecha fuera de pantalla** — una línea; no se captura lo que no existe.
4. **Anticipo de cliente (D11-12) y reparto de un cobro (D13)** — decididos hace 10 días; hoy el sobrante de un depósito se descarta y cada cobro real de un productor suele cubrir varias facturas. Son la misma pieza (saldo a favor + aplicación a N facturas). Con el anticipo a proveedor como espejo (8.1).
5. **Reasignar vendedor** — candado sin salida en un dato que filtra media aplicación.
6. **Guía de carga por evento** — el bloque de parciales quedó cojo del lado del papel que firma el cliente.
7. **Alta de cuentas de banco** — si hay una tercera cuenta o caja, hoy no cabe.
8. **NC / devolución a proveedor (H4c)** — mercancía equivocada llega; hoy la FP se queda viva sin camino.
9. Los cierres pendientes de `AUDITORIA.md` § 4 que tocan dinero (GRUPO F #28, J #33) — ya priorizados ahí.

**B. Necesario en el primer trimestre de operación** (se puede arrancar sin ello, pero pronto duele):
10. **Costo del proveedor con vigencia** (§ 10) y el aviso "costo vence antes que la cotización" — es la pieza que sustituye a las listas de precios y la que protege el margen al cotizar.
11. **Producto inactivo** y **catálogo de producto** con ingrediente activo y presentación.
12. **Kardex con filtro por producto y fecha en el servidor** (hoy 200 renglones de toda la empresa).
13. **Flete real al costo del kardex** y al costo financiero (8.1).
14. **Descuento comercial** como renglón (8.1).
15. **Margen por producto y por familia**; **ventas por vendedor** — para que Reportes conteste lo que hoy contesta el Excel.
16. **Bitácora en gastos y movimientos bancarios sueltos**; folios PV/OC/SC/GAS por `folio_counters`; OC desde RFQ en transacción; TC revalidado contra la tabla al guardar.
17. **Reposición real** (punto de pedido con demanda comprometida y tránsito) — hoy el mínimo avisa, no sugiere.
18. **Conteo físico** (L8a) — el primer inventario físico contra el sistema lo va a pedir.

**C. Puede esperar / depende de respuestas del dueño:**
19. **UOM con conversión (H6)** y **lotes/caducidad (H5)** — estructurales sobre el kardex; van separados y UOM antes que lotes; lotes según la respuesta 8.2-2.
20. **Fórmulas / mezclas (BOM)** — el menos invasivo de los estructurales; entra cuando se decida producir o maquilar.
21. **Liquidación con Santa Rosa (D-C)** — Fase 3 del circuito lineal; hoy se lleva fuera del sistema.
22. **Rotación, DSO, top deudores, concentración, valuación histórica, cierre de periodo, exportar cartera y estado de cuenta** — reportes y candados de madurez. (La revaluación de saldos en USD ya no está aquí: va dentro de la posición cambiaria, A.2.)
23. **Comisiones de vendedor, zona, aprobación de OC por monto, propuesta de pago a proveedores, importar estado de cuenta bancario** — según 8.2-1 y volumen.

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

### 11.0 La realidad del negocio (corrección del dueño, 17-sep-2026)

- Proveedores y clientes, unos en pesos y otros en dólares. **Con todos se negocia el TC.**
- **Las líneas de crédito de Azagro son en pesos** (Santa Rosa financia en MXN; `FinancingBase` y `pricing.ts` no tienen moneda — trabajan en lo que traiga el costo). La operación es en buena parte en dólares. **Ese desajuste es la exposición de fondo**, y la agranda el crédito largo: entre que se compra y que se cobra pasan meses.
- **El TC pactado no es un dato administrativo: es la herramienta de cobertura.** Las dos dinámicas reales:
  - **Dinámica 1 — cubrir con dólares:** comprar dólares para pagarle al proveedor, y vender en dólares con TC pactado. Las dos patas quedan en dólares; el margen en pesos queda fijo en el momento en que se compran los dólares contra el pactado con el cliente.
  - **Dinámica 2 — cubrir con TC pactado en las dos puntas:** pagarle al proveedor **en pesos al TC que él pone**, facturar al cliente **en dólares al TC pactado**, y cobrar **en pesos a ese mismo TC**. Las dos patas quedan fijas en pesos; el margen no depende del mercado mientras el cliente honre el pactado (y si no, el ATC captura la diferencia — ya construido).
- **No hay un escenario único. El sistema tiene que aguantar todos**, y decir en cada momento qué está cubierto y qué está abierto.

Lo que sigue (11.1-11.5) es el estado del código antes de esta corrección; 11.6-11.8 es lo que falta con esta corrección encima. Lo que ya se había encontrado (costo sin moneda, OC con TC = 1, pago de FP ignorando el TC, P&L mezclando monedas) **sigue siendo lo primero** — sin eso no se puede registrar ninguna de las dos dinámicas.

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

### 11.6 La exposición cambiaria como cosa propia

**Qué hay hoy como materia prima** (verificado):
- Por documento sí se sabe la moneda y el TC: `quotes`/`sales_orders`/`purchase_orders.currency + fx_rate`; FV con `amount_fx` y `fx_agreed`; FP con `currency` y `fx_agreed` pero **sin `amount_fx`**; cobros con `fx_paid`. `banks.currency` existe y `/bancos` la enseña por cuenta. `purchase_orders.so_id` e `invoices.order_id` permiten aparear las OC y las FV de un pedido; la FP se amarra a su OC por `origin` (texto).
- La única vista por moneda es el **estado de cuenta por cliente** (`getStatement`, `ops.ts:2653-2673`, `byCurrency` MXN/USD con cargo, abono, saldo, interés y utilidad cambiaria) — por socio, no de la empresa. `getUpcomingDue` separa "de docs. USD" por mes pero el total sigue mixto.
- El TC de hoy vive en Ajustes (`settings.tsx:637-670`, captura manual por fecha, solo admin, sin cadencia obligada); `nearestRate` (`credit.ts:35`) lo resuelve, repetido en cinco pantallas.

**Qué no hay** (huecos 23-27): ninguna vista consolidada en dólares; el inicio suma pesos con dólares en caja, por cobrar y por pagar; `listInvoices` no expone los campos de TC; **comprar dólares no se puede registrar** (la transferencia entre cuentas acredita pesos como dólares); no hay revaluación ni sensibilidad; nada dice qué está cubierto.

**La pieza: «Posición cambiaria».** Una sola pantalla y una tarjeta en el inicio que contestan las cuatro preguntas del dueño:

| Pregunta | Qué enseña | De dónde sale |
|---|---|---|
| ¿Cuánto se debe y cuánto nos deben en dólares, por vencimiento? | Cubetas hoy / 1-30 / 31-60 / 61-90 / 91-150 / +150 con **USD abiertos** por lado: CxC (FV vivas USD), CxP (FP vivas USD), **comprometido** (OC confirmadas sin recibir en USD; PV confirmados sin facturar en USD) | `invoices.amount_fx − pagado en USD` (exige `amount_fx` en la FP: hueco 17), `purchase_orders`/`sales_orders` por `currency` y pendiente |
| ¿A qué TC se pactó cada documento vivo y cuál es el TC de hoy? | Tabla por documento: tipo, socio, USD abierto, **TC pactado**, vence, MXN al pactado, MXN al TC de hoy, diferencia | `fx_agreed` / `fx_rate` por documento; un helper único `fxToday()` (hueco 27) enseñado en el inicio |
| ¿Cuánto se gana o pierde si el dólar se mueve X pesos? | Posición neta abierta en USD × X, por cubeta y total; y la **revaluación** de lo vivo al TC de hoy (no realizado) | Posición neta = (banco USD + CxC USD + PV USD comprometidos) − (CxP USD + OC USD comprometidas), **solo la parte abierta** (ver cobertura) |
| ¿Qué está cubierto y qué está abierto? | Por deal (pedido + sus OC + FV/FP + dólares comprados): **cubierto, dinámica 1** (OC en USD pagada con dólares comprados a TC conocido, FV en USD con pactado) · **cubierto, dinámica 2** (OC/FP pagada en MXN al TC del proveedor, FV en USD con pactado y cobro en MXN al pactado) · **abierto lado compra** (FP en USD viva sin dólares en caja) · **abierto lado venta** (venta en MXN con costo en USD, o FV USD sin pactado) · **abierto ambos** | Comparar `po.currency/fx` vs `so.currency/fx` vs saldo USD en banco y la compra de dólares registrada con su TC (hueco 24) |

Reglas que la sostienen (sin proponer código): (i) la posición se calcula **en vivo**, sin columna "exposición" (mismo patrón que `creditExposure`, D51); (ii) el TC de hoy es el de la tabla a la fecha o el sistema dice "sin TC de hoy" (regla 9), nunca uno inventado; (iii) la cobertura se **deriva** de los documentos, no se declara a mano — pero cada documento sí declara explícitamente su moneda y su TC (11.7); (iv) "dólares en caja" es el saldo de las cuentas en USD, y su costo en pesos es el TC de cada compra registrada.

**Dónde vive:** motor puro `src/lib/erp/fx-position.ts` (clasificación por deal, cubetas, sensibilidad — probado con números como `parciales.ts`), consulta en el mismo archivo o en `reports.ts`, pantalla `/posicion` (o pestaña en `/reportes`), tarjeta en `/` ("Exposición neta USD · TC hoy · ± si se mueve 1 peso"), y `fxToday()` en `credit.ts` junto a `nearestRate`. Prerrequisitos: A.1 completo (sin `amount_fx` en la FP, sin TC real en la OC y sin compra de dólares con TC no hay con qué calcular).

### 11.7 Las dos dinámicas, soportadas explícitamente: qué declara cada documento y qué compara el sistema

Hoy la cadena respeta el TC del cliente y **pierde** el del proveedor. Para que las dos dinámicas existan por diseño y no por accidente:

| Documento | Declara hoy | Debe declarar | Compara / produce |
|---|---|---|---|
| COT | moneda + TC (editable, sin revalidar) | moneda + **TC pactado con el cliente**, revalidado contra la tabla o capturado con motivo (como la TIIE) | — |
| PV | hereda COT | hereda COT; el TC pactado es el compromiso con el cliente | — |
| OC | TC del cliente (vía cotización) o **1** (vía RFQ) | moneda + **TC del proveedor** (el que él pone en dinámica 2; el de mercado esperado en dinámica 1), nunca el del cliente | **Spread cambiario del deal** = PV.fx − OC.fx sobre los USD del pedido: una línea en el P&L del pedido (hoy no existe) |
| FP | `amount` en moneda de la OC, sin `amount_fx` | `amount` en MXN al TC de la OC + `amount_fx` + `fx_agreed` — **el mismo molde que la FV** (`azagro.ts:2059`) y que ya usa el corte (D70) | — |
| Compra de dólares | no se puede registrar | movimiento de banco **con TC**: salen MXN, entran USD, `fx_rate` de compra guardado (hueco 24) | Costo en pesos de los dólares en caja |
| Pago de FP | pesos contra dólares 1:1 | si se paga en MXN: `fx_paid` y **diferencial vs `fx_agreed`** (espejo del ATC, hueco 16); si se paga en USD desde la cuenta USD: sin diferencial, y se consume "dólares en caja" | Utilidad/pérdida cambiaria realizada lado compra |
| FV | moneda + TC pactado (`fx_agreed`) — correcto | igual | — |
| Cobro | `fx_paid` vs `fx_agreed` → ATC / `fx_result` — correcto | igual | Utilidad/pérdida cambiaria realizada lado venta (existe) |
| P&L del pedido | resta `po_cost` crudo contra venta | costo y venta **en MXN a sus TC declarados**, más la línea de spread cambiario y los dos diferenciales realizados | Margen real en una sola moneda |

Con esto, "cubierto" y "abierto" (11.6) se derivan solos, y las decisiones 8.2-4 y 8.2-5 del dueño se vuelven capturables: quién absorbe el TC en una venta en pesos con costo en dólares es lo que el P&L enseña como "abierto lado venta", y pagar desde la cuenta USD o MXN es un dato del pago, no una política.

### 11.8 Qué hace el estándar y cómo se llaman los reportes

**Lo que un ERP contable da de serie** (Odoo, SAP Business One, Dynamics 365 Business Central, NetSuite — todos lo mismo con otros nombres):
1. **Partidas abiertas por moneda** — "Aged Receivable / Aged Payable" con columna en moneda del documento y en moneda de la empresa (Odoo: *Aged Receivable/Payable*; SAP B1: *Open Items List*; BC: *Aged Accounts Receivable* por moneda). Es la mitad de la primera pregunta del dueño (falta "comprometido" por OC/PV y falta cobertura).
2. **Diferencia cambiaria realizada** — automática al liquidar, en los dos lados. Odoo: asiento en el *Exchange Difference Journal*; SAP B1: *Exchange Rate Differences*; NetSuite: *Realized Exchange Rate Gains and Losses*. Azagro lo tiene del lado cliente (ATC/`fx_result`), no del proveedor.
3. **Revaluación del no realizado** — los saldos abiertos en moneda extranjera se valúan al TC de cierre y la diferencia se asienta con reversa. Odoo: *Unrealized Currency Gains/Losses* (Contabilidad ▸ Informes) y el asistente *Foreign Currency Revaluation*; SAP B1: *Conversion Differences*; BC: *Adjust Exchange Rates*; NetSuite: *Currency Revaluation*. Es la tercera pregunta del dueño en su versión contable ("cuánto vale hoy lo vivo"), sin sensibilidad ni cobertura.
4. **Inventario y costos en moneda de la empresa**, convertidos al recibir — nunca mezclados. Odoo valúa en MXN al TC de la recepción; el costo del proveedor (`product.supplierinfo`) lleva moneda y vigencia.

**Lo que un ERP de distribución NO da de serie, y que el dueño está pidiendo:** la **posición cambiaria neta por vencimiento con cobertura** — "cuánto está abierto, cuánto cubierto, y cuánto cambia si el dólar se mueve un peso". Eso es un reporte de **tesorería**, no de contabilidad: en la práctica se llama *FX exposure report* / *net open position by maturity* / *currency exposure by bucket* (SAP Treasury "Exposure Management", Kyriba, o un Excel de tesorería), y su lógica es la de 11.6: activos en USD menos pasivos en USD, por cubeta, separando lo cubierto (*natural hedge*: cuentas por cobrar en USD contra cuentas por pagar en USD, o dólares ya comprados) de lo abierto. Las coberturas con forwards (contabilidad de coberturas, IFRS 9 / NIF C-10) son otro nivel y no aplican: la cobertura de Azagro es el **TC pactado con la contraparte**, que ningún ERP de serie modela como cobertura — por eso la pieza de 11.6 es de Azagro, y por eso se construye encima de los documentos, no de un módulo.

**Una empresa que financia en una moneda y vende en otra** (el caso del dueño) hace, en el estándar, exactamente las dos dinámicas: (1) *matching* — compra la moneda del pasivo cuando adquiere el compromiso, para que activo y pasivo queden en la misma moneda; (2) *pass-through* — fija el TC con la contraparte en los dos lados y opera en la moneda de la línea. Y mide lo que queda fuera de las dos con el reporte de posición. Ningún ERP decide cuál usar; reporta. Lo que Azagro tiene y ningún ERP de serie: el **ATC "por cobrar / por devolver"** negociado con el cliente cuando el cobro no honra el pactado, y el TC pactado en la FV en vez del TC de la fecha de factura — las dos son la práctica real del negocio (`EXCEL_VS_SISTEMA.md` § 4) y se conservan.

---

## 12. Bloque A.1 — informe de solo lectura (paso 1, 17-sep-2026) y decisiones tomadas

Pasada de solo lectura (`investigar-bloque`, paso 1) sobre "moneda y TC en toda la cadena de compra" (§ 9 A.1), hecha con cuatro pasadas paralelas. El dueño aceptó las ocho recomendaciones el mismo día → **Decisiones 76-81** en `DECISIONES.md`. El paso 3 (SQL de la migración, punto de paro) viene después de este informe.

### 12.1 Lo que existe hoy

- **Ningún costo tiene moneda:** `products.cost` (0002:47), `ref_cost` (0016:14), `quote_lines.cost/freight/other_cost` (0009:17-18), `customer_request_lines.cost` (0017:42-51), `vendor_rfq_bids.unit_price` (0010:33-39), `purchase_lines.unit_price` (0002:98-105), `partner_products.unit_price` (0009:3-12), `stock_moves.unit_cost`/`stock_quants.avg_cost` (0034:37-38). Solo las cabeceras: `quotes.currency/fx_rate` (0003:110), `purchase_orders.currency/fx_rate` (0003:21-22), `vendor_rfqs.currency` (nace por código, `rfq.ts:32`), `customer_requests.currency` (0017:54). `PriceInput` (`pricing.ts:40-56`) no admite moneda; `resolveCost`/`assertCostForCredit` (`cost.ts:20-26, 55-71`) solo comparan magnitud.
- **Costo → precio sin conversión:** `applyCheapest` (`requests.ts:786`), `quoteFromRequest` (`:959-976`), `applyRfqWinners` (`rfq.ts:239`), `createQuote` (`ops.ts:968`), `reviseQuote` (`:1400`).
- **Costo → kardex:** `receivePurchase`/`receivePartial` pasan `unit_price` crudo a `postStock` (`azagro.ts:1458, 1529`); `postStock` (`stock.ts:269`), `movingAverage` (`:58-65`), `refreshProductCost` (`:191-206`) sin moneda.
- **OC, tres nacimientos:** `createPurchase` (`azagro.ts:1247-1314`) con `fxRate` default 1 y **`/purchases` no manda `fxRate`** (`purchases.tsx:174-183`) → toda OC USD manual nace con TC = 1 en silencio; `applyRfqWinners` (`rfq.ts:282-289`) `1` literal; `decideQuote` (`ops.ts:1714-1723`) hereda el TC del cliente. Ninguno revalida contra `fx_rates`. `purchases.tsx:258,293` propone `p.cost` sin moneda; `rfq.$rfqId.tsx` no enseña la moneda del proveedor.
- **FP en dólares crudos:** `bornSupplierDebt` (`azagro.ts:1369-1373`) y `bornSupplierDebtByReceipt` (`:1605-1609`): `amount = po.total` en la moneda de la OC, `fx_agreed = po.fx_rate`, `amount_fx` nunca. Moldes correctos ya existentes: FV (`issueDeliveryInvoice`, `azagro.ts:2004, 2051-2064`) y corte (`cutover-core.ts:356-381`, D70, cliente y proveedor).
- **Lectores de proveedor que suman crudo:** `getDashboard.ap`/`payableWeek` (`azagro.ts:327-331, 467-472`), `getUpcomingPayable` (`reports.ts:945-972`, sin `currency`), `getLiveStatement.ap` (`ops.ts:2655`; `byCurrency` solo de cliente), resumen de `/credit` (`credit.tsx:92-96`), `getCompanyPnl.purchases` (`reports.ts:671-677`). Por fila: `credit.tsx:209,211`, `vencimientos.tsx:154` con `moneyIn(r.amount, r.currency)` — con el molde FV deben leer `amount_fx`. `listInvoices` no expone `amount_fx/fx_agreed/fx_paid` (`azagro.ts:2644-2733`).
- **Pago de FP:** `applyInvoicePayment` `isUsdCustomer` exige `kind === "customer"` (`ops.ts:1973-1996`); `fxPaymentSplit` (`credit.ts:389-405`) es pura y sin `kind`; `fxTreatment` (`:2054-2089`) con ATC `kind:'customer'` hardcodeado (`:2066`); reversa simétrica salvo `reversal.ts:207`; la pantalla ofrece TC por `currency === "USD"` sin `kind` (`credit.tsx:561`, `banks.tsx:246-266`); `payments` sin columna de TC; `bank_moves.amount` de un cobro USD son pesos reales (`:2041,2047`); nadie valida `banks.currency`.
- **Bancos:** `bank_moves` sin `fx_rate/amount_fx/currency` (0003:74-85 + 0008/0029/0038); `addBankMove` `transferencia` (`ops.ts:2228-2249`) inserta el mismo `amount` en las dos cuentas, sin liga ni validación de moneda; `banks.tsx:205-217` sin TC; `cash` (`azagro.ts:419-425`) suma todo; la rama sin factura no deja bitácora.
- **P&L:** `dealPnlCore` (`reports.ts:188-550`) no trae `po.currency/fx_rate`; `po_cost` (`:296-301`) solo `pl.unit_price`; `saleUnit` (`:316`) tratado como pesos siempre (L4a); `costUnit` (`:317-326`) dólares crudos si la OC es USD; `fx_result` de la FV entra como `fxIncome` (`:480`), sin equivalente de proveedor; `getPanorama` hereda; `getCompanyPnl` suma `invoices.amount` de proveedor sin moneda.
- **Red de seguridad:** las pruebas de precio (`erp-circuito-lineal` +2,940, `erp-precio`, `erp-financiamiento-precio`, `erp-dos-precios`, `erp-costo-referencia`) usan números puros → intactas si la conversión ocurre antes del motor. **Ninguna prueba de `npm test` ejecuta `dealPnlCore` contra una base** (todas son copias JS o `includes("literal")`); `erp-circuitos-verificacion.mjs` es manual y su query tampoco trae moneda. **Ninguna prueba crea OC/FP de proveedor en USD** por el camino normal. El bloque no rompe pruebas — y no tiene ninguna que lo proteja: hay que escribirla.
- **Borrado:** `purchase_orders`, `invoices` (`cutover_key is null`), `payments`, `bank_moves` en PURGE; `fx_rates`, `banks` en KEEP (`purge-plan.mjs:58-64, 301-308`). Columnas nuevas no cambian el plan.
- **Abiertas que se citan y no se tocan:** L4a (`ESTADO.md:456-477`, lado venta), 4.3 (`:1018-1028`), 8.2-4 y 8.2-5 de este documento.

### 12.2 Decisiones tomadas (17-sep-2026)

| # | Decisión | Recomendación aceptada |
|---|---|---|
| 76 | El costo lleva moneda y se convierte ANTES del motor | (a) convertir con TC de tabla a la fecha, enseñado y editable; sin renglón se detiene |
| 77 | Catálogo y kardex en pesos | (a) convertir al recibir con el TC de la OC; al final del bloque, con revisor de dinero |
| 78 | La OC en USD declara el TC del proveedor | (a) obligatorio, propuesto de tabla, nunca 1 ni el del cliente; el campo antes del candado |
| 79 | La FP con molde FV/corte + backfill | (a) `amount` en pesos al TC de la OC, `amount_fx`, `fx_agreed`; backfill `currency='USD' and cutover_key is null` |
| 80 | Diferencial cambiario del lado proveedor | (a) `fx_result` o ATC `kind='supplier'`, reversa simétrica |
| 81 | Compra de dólares y dólares en caja | (a) `kind='compra-usd'` con TC y liga entre patas; promedio móvil por cuenta |

Siguen abiertas para el dueño: 8.2-4 (venta en pesos con costo en dólares: quién absorbe), 8.2-5 (pagar la FP desde la cuenta USD o MXN), 4.3 y L4a.

### 12.3 Cómo se parte (T4) y qué NO va

- **A.1a — Declarar y convertir:** moneda y TC del costo en solicitud/RFQ/cotización; TC del proveedor en los tres nacimientos de OC (campo en `/purchases` antes del candado); FP con molde FV + backfill; `dealPnlCore` con `po.currency/fx_rate`, `costUnit` en pesos, líneas nuevas (spread del deal, diferenciales); lectores por fila a `amount_fx`; prueba nueva con OC USD en PGlite; `erp-circuitos-verificacion.mjs` actualizado.
- **A.1b — Pagar la FP con TC:** rama proveedor en `applyInvoicePayment`, ATC `kind='supplier'`, reversa simétrica, `payments.fx_rate`, validación `banks.currency`.
- **A.1c — Comprar dólares y el kardex en pesos:** `compra-usd` con TC y `pair_id`, promedio de dólares en caja, `cash`/`ar`/`ap` por moneda; recepción convirtiendo antes de `postStock` (D77).
- **Fuera de este bloque:** posición cambiaria (A.2); el lado venta de L4a; costo con vigencia (§ 10); `byCurrency` de proveedor en el estado de cuenta; FI en dólares; `fxToday()` en el inicio (A.2).

### 12.4 Lo que no se pudo determinar leyendo

Cuántas OC/FP en USD y transferencias MXN→USD existen en Neon (no se consulta producción; hoy es dato de prueba); si `/purchases` inyecta `fxRate` en tiempo de ejecución (por grep no); si el corte de existencias acepta costo en USD; si `MoneyField` tiene prop de moneda sin usar; si `/rfq/nuevo` captura un TC que luego se descarta; qué lectores asumen que `payments.amount` son pesos al TC pactado (al menos el hueco 21).

### 12.5 Construido — A.1a, 17-sep-2026

`src/lib/erp/fx.ts` (puro: `costToMxn`, `mxnToCostCurrency`, `supplierInvoiceAmounts`, `poCostToMxn`, `invoiceShown`, `fxAt`, `isUsdFx`), migración 0044 (columnas nullable + backfill de FP USD sin `cutover_key`), `scripts/erp-moneda-del-costo.test.mjs` (12/12). `npm test` 868/868, `tsc` limpio, **ninguna prueba existente cambió** (los seis literales de "cableado" que congelan inserts y bitácora se conservaron reordenando columnas y con `.extend`). `pricing.ts`, `cost.ts`, `stock.ts` no cambian de firma. Verificado en navegador (PGlite fresco): OC en USD con TC 18.5 propuesto de la tabla; recepción detenida por el plazo del proveedor (Decisión 67) y, con plazo, **FP-0001 = USD 10,000.00 · TC 18.5 · $185,000.00**, totales de Cuentas por pagar en pesos.

**Revisor de dinero: primera pasada NO PASA** por el backfill (`residual × TC` en vez de importe − abonos: una FP con abono de 500 quedaba en 9,250 donde el sistema calcula 18,000) — corregido: `residual = round(amount × fx, 2) − (amount − residual)`, los abonos previos son pesos reales del banco y no se convierten. Corregidos también: el papel «Documento» de Cartera con `invoiceShown`; `setPurchaseFxRate` en `withTx` con `for update`; el TC de la solicitud a la **fecha de la solicitud**; el mensaje del candado nombra también «entregar» (brokeraje); la pantalla de compras no manda `fxRate: 0`. **Avisos anotados, no tocados (van a A.1b/A.1c o al orden de § 9):** (1) el kardex sigue recibiendo `unit_price` crudo — OC 1,000 USD a 18.50 → kardex 1,000, FP 18,500, P&L 18,500 — hasta A.1c (Decisión 77); (2) la solicitud no enseña ni deja corregir el TC antes de elegir proveedor (`pickVendor`/`applyCheapest` toman el de la tabla a la fecha de la solicitud; se ve después como texto) — la RFQ sí lo pide; (3) `decideQuote` agrupa por proveedor + moneda + TC: partidas elegidas con TC distinto producen dos OC; partidas anteriores a la 0044 con `cost_currency` vacío se tratan como MXN; (4) la bitácora de cancelar/revertir etiqueta el importe de la FP (ya pesos) con la moneda de la OC (`cancel.ts:194,207`, `delivery-reversal.ts:207`); (5) el papel del estado de cuenta sigue imprimiendo el cargo en pesos con moneda USD (hueco 20, L4a); (6) `vendor_rfqs.currency` sigue naciendo también por código (`rfq.ts:33`), duplicado inofensivo de la 0044; (7) el backfill convierte OC nacidas de `decideQuote` antes de este bloque con el TC que tenían (el del cliente); (8) ninguna prueba ejecuta `bornSupplierDebt`/`decideQuote`/`dealPnlCore` contra PGlite con OC en USD (el harness no importa módulos con alias `@/`): la aritmética está fijada en puro y el camino real se verificó en navegador.

### 12.6 Construido — A.1b, 17-sep-2026

Sin migración (usa `payments.currency/fx_rate` de la 0003, `bank_moves.amount_fx/fx_rate` de la 0044 e `invoices.fx_result/fx_paid/fx_treatment`). `fx.ts`: `settleMode` (factura USD/MXN × cuenta USD/MXN), `usdBankSettlement`, `mxnInvoicePaidInUsd`, `fxResultDeltaFor`. `applyInvoicePayment`: la factura en dólares pagada con pesos usa el mismo `fxPaymentSplit` en los dos lados y el diferencial lleva signo por lado (pérdida si Azagro le pagó de más al proveedor); el ATC nace con el `kind` de la factura («POR PAGAR» / «POR COBRAR AL PROVEEDOR»); desde la cuenta en dólares el banco lleva dólares (`amount` y `amount_fx` con signo, `fx_rate` = pactado) y no hay diferencial; factura en pesos pagada con dólares se convierte al TC del pago; el candado de saldo compara en la moneda de la cuenta; el PAG queda en pesos al pactado con el TC del movimiento. `reversal.ts`: `isUsd`/`fxResultDelta`, sin diferencial cuando el abono salió de la cuenta en dólares, y el TC del abono anterior se toma del movimiento (nunca `|dólares| ÷ dólares = 1`). Pantallas: Cartera y Bancos piden TC y tratamiento solo con cuenta en pesos; con cuenta en dólares el importe es en dólares. `scripts/erp-pago-fp-tc.test.mjs` (8/8), `npm test` en verde sin cambiar ninguna prueba existente (`fxPaymentSplit({`, `fx_result = fx_result +`, `const signed = …` y la línea de `fxDiff` de la reversa se conservan).

**Verificado en navegador (PGlite fresco):** FP-0001 de 10,000 USD a 18.5 → pago de 400 USD desde Banorte USD: «Aplicado $7,400.00 en Banorte USD. Saldo factura $177,600.00. Caja $1,600.00», fila Pagado USD 400.00 / Saldo USD 9,600.00 → pago de 11,400 MXN a 19.00 desde Banorte MXN: «Aplicado $11,100.00 en Banorte MXN. Saldo factura $166,500.00. Caja $38,600.00. Diferencial TC: pérdida cambiaria 300.00» → preview de «Revertir último abono»: contra-pago −11,100, contra-movimiento +11,400 MXN, «pérdida cambiaria de este pago registrada en la factura → se regresa · $300.00».

**Revisor de dinero: PASA CON AVISOS.** Cerrados antes de commitear: el ATC de proveedor ya no entra como «compra» en el P&L por periodo (`getCompanyPnl` excluye `inv_class='fx'`); el panorama de ajustes de TC es solo de cliente; la reversa con abonos en dos monedas ya no escribe `fx_paid = 1`; el PAG queda en `'MXN'`. **Anotados, no tocados:** (1) el `fx_result` de la FP todavía no entra al P&L del pedido (`netProfit` congelado; el diferencial realizado del lado compra queda como columna pendiente — en el caso del 19.00 la pérdida de 300 no se ve en la utilidad del pedido); (2) el contra-movimiento de la reversa no copia `amount_fx`/`fx_rate` (insert congelado por `erp-revertir-pago:66-70`; cuando exista el promedio de dólares en caja, ese renglón no tendrá costo en pesos); (3) `fx_invoiced` no crece para proveedor, y la estimación del estado de cuenta abierto (hueco 21) sigue sobre `amount_fx` completo; (4) una FP en USD pagada desde Banorte USD entre `a6fe4e0` y este commit escribió pesos en la cuenta en dólares (datos de prueba); (5) el preview de la reversa etiqueta el PAG (pesos al pactado) con la moneda de la factura («$11,100.00 USD»), misma familia del hueco 20; (6) `payments.fx_rate = 1` en pesos con pesos es el default del esquema, no un TC.

---

## 13. La matriz de monedas (18-sep-2026)

En el negocio pasa de todo: se compra en pesos o en dólares, se vende en pesos o en dólares, se paga al proveedor en una u otra y el cliente paga en una u otra — y las combinaciones se cruzan. Esta sección recorre **las 16 combinaciones** (moneda de la compra × moneda de la venta × moneda con que Azagro paga × moneda con que el cliente paga) contra el código del 18-sep-2026 (después de A.1a y A.1b), eslabón por eslabón: cotización a proveedor, cotización al cliente, pedido, OC, FP, FV, cobro, pago, kardex, P&L y el papel que ve el cliente. Tres pasadas de solo lectura la verificaron línea por línea.

**Cómo leerla.** Cada eslabón depende de UNA o DOS de las cuatro monedas, así que las 16 casillas se arman de cuatro piezas:

| Pieza | Depende de | Estado | Dónde |
|---|---|---|---|
| **Compra** (RFQ → OC → FP → P&L costo) | moneda de la compra | ✅ en MXN y en USD (A.1a, Decisiones 76-79) | `rfq.ts:240,253`, `azagro.ts:1301` (`createPurchase`), `ops.ts:1723-1725` (`decideQuote`: la OC nace en la moneda del **proveedor**, no en la del cliente), `bornSupplierDebt*` con `supplierInvoiceAmounts`, `reports.ts:336` (`poCostToMxn`) |
| **Kardex** (recepción → promedio → `products.cost` → siguiente cotización) | moneda de la compra | ✅ en MXN · **◐ en USD hasta A.1c**: `receivePurchase`/`receivePartial` pasan `unit_price` crudo a `postStock` (`azagro.ts:1538, 1609`); `refreshProductCost` lo escribe en `products.cost` (`stock.ts:204`) y `resolveCost` lo reusa como pesos en la siguiente cotización sin OC propia (`cost.ts:20-26`, `ops.ts:969`); `/inventory` lo enseña con signo `$` (`inventory.tsx:430`) | Decisión 77, pendiente |
| **Venta** (cotización → pedido → FV → NC → papel → estado de cuenta → límite de crédito) | moneda de la venta | ✅ en MXN · **✗ en USD (L4a)**: el precio se captura en un `MoneyField` sin etiqueta de moneda (`quotes.tsx:594-606`, `order-form.tsx:572-583`) con el precio de lista en pesos por omisión (`quotes.tsx:264`), `createQuote`/`quoteFromRequest` nunca multiplican ni dividen por `fx_rate` (`ops.ts:940-955`, `requests.ts:976-1047`), `decideQuote` hereda el número crudo (`ops.ts:1625-1687`) mientras dos líneas más abajo la OC sí convierte (`:1727`), `issueDeliveryInvoice` guarda `amount = Σ qty × unit_price` y `amount_fx = amount / fx` (`azagro.ts:2143-2148`) **sin candado**; la NC de devolución nace sin `amount_fx` ni `fx_agreed` (`azagro.ts:2569-2579`, hallazgo nuevo); `creditExposure` suma el total del pedido USD contra un límite en pesos (`credit-limit.ts:39-68`); el papel y el estado de cuenta imprimen esa cifra con signo US$ (`doc-text.ts:116-145`, `ops.ts:2698-2709`, `statements.tsx:178-224`) | `ESTADO.md` L4a, Decisión 2 (solo el modelo) |
| **Dinero** (cobro y pago: factura × cuenta) | moneda de la factura × moneda de la cuenta | ✅ los cuatro modos en los dos lados (A.1b, Decisión 80): `settleMode` (`fx.ts:133-160`), `applyInvoicePayment` (`ops.ts:1999-2000, 2089-2117`), reversa (`reversal.ts:215-223`) · **◐ la caja**: comprar dólares no existe (`addBankMove` `transferencia` acredita el mismo número en las dos cuentas, `ops.ts:2286-2292`), el inicio suma pesos y dólares en un número (`azagro.ts:420-426`), los KPIs de `/credit` (`:91-99`) y las cubetas de `/vencimientos` (`:104-116`) suman residuales de las dos monedas, `getUpcomingPayable` no trae moneda (`reports.ts:977-1004`) | A.1c (compra de dólares, caja por moneda), A.2 (posición) |

Y tres transversales que cruzan casillas: (i) **el `fx_result` de la FP no entra al P&L del pedido** (`reports.ts:509` lee solo `fv.fx_result`; `netProfit` congelado) — toca toda compra en USD pagada con pesos; (ii) **`fxSpread` solo cuando OC y pedido son USD** (`reports.ts:368-371`) — en compra USD con venta MXN el spread real no se ve en ningún lado (8.2-4, abierta); (iii) **la FI y el pronto pago son siempre en pesos** (`ops.ts:2823, 2886, 2162`) — la mora de una FV en USD se cobra en pesos sobre el cargo al pactado (`EXCEL_VS_SISTEMA.md` § 4 dice que en el Excel hubo cobros de mora en USD: sigue sin existir).

### 13.1 Las 16 combinaciones

Columnas: **C** compra, **V** venta, **P** pago al proveedor (moneda de la cuenta), **K** cobro al cliente (moneda de la cuenta). Estado global: ✅ funciona · ◐ a medias · ✗ no funciona. "Real" = pasa en la operación según § 11.0; "rara" = posible pero no es práctica normal; "teórica" = solo por combinatoria.

| # | C | V | P | K | Global | Cotiz. prov. · OC · FP | Kardex | Cotiz. cliente · PV · FV · papel | Pago (modo) | Cobro (modo) | P&L | Depende de | Ocurre |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | MXN | MXN | MXN | MXN | ✅ | ✅ | ✅ | ✅ | ✅ mxn | ✅ mxn | ✅ | — | real (todo nacional) |
| 2 | MXN | MXN | MXN | USD | ◐ | ✅ | ✅ | ✅ | ✅ mxn | ✅ mxn-con-dólares (TC del pago, sin diferencial: la deuda es en pesos) | ✅ | caja por moneda (A.1c) | rara |
| 3 | MXN | MXN | USD | MXN | ◐ | ✅ | ✅ | ✅ | ✅ mxn-con-dólares | ✅ mxn | ✅ | dólares en caja + caja por moneda (A.1c) | teórica |
| 4 | MXN | MXN | USD | USD | ◐ | ✅ | ✅ | ✅ | ✅ mxn-con-dólares | ✅ mxn-con-dólares | ✅ | A.1c | teórica |
| 5 | MXN | USD | MXN | MXN | ✗ | ✅ (OC en pesos aunque el pedido sea USD, `ops.ts:1723`) | ✅ | ✗ L4a | ✅ mxn | ✅ usd-con-pesos (TC del cobro, ATC/utilidad) — sobre `amount`/`amount_fx` que pueden haber nacido mal | ◐ `sale` en la unidad tecleada vs `landed` en pesos (`reports.ts:329-354`) | L4a | **real (dinámica 2 con proveedor nacional)** |
| 6 | MXN | USD | MXN | USD | ✗ | ✅ | ✅ | ✗ L4a | ✅ mxn | ✅ usd-con-dólares (sin diferencial) | ◐ | L4a, A.1c | real |
| 7 | MXN | USD | USD | MXN | ✗ | ✅ | ✅ | ✗ L4a | ✅ mxn-con-dólares | ✅ usd-con-pesos | ◐ | L4a, A.1c | teórica |
| 8 | MXN | USD | USD | USD | ✗ | ✅ | ✅ | ✗ L4a | ✅ mxn-con-dólares | ✅ usd-con-dólares | ◐ | L4a, A.1c | teórica |
| 9 | USD | MXN | MXN | MXN | ◐ | ✅ (OC en USD con TC del proveedor) | ◐ crudo hasta A.1c | ✅ | ✅ usd-con-pesos: pérdida/utilidad con signo de proveedor, ATC «POR PAGAR»/«POR COBRAR AL PROVEEDOR» | ✅ mxn | ◐ costo bien (`poCostToMxn`); **el diferencial del pago no entra** (i); **spread 0** (ii) | A.1c; 8.2-4; (i) | **real (compra en USD, venta en pesos — la exposición abierta de § 11.0)** |
| 10 | USD | MXN | MXN | USD | ◐ | ✅ | ◐ | ✅ | ✅ usd-con-pesos | ✅ mxn-con-dólares | ◐ (i)(ii) | A.1c; (i) | rara |
| 11 | USD | MXN | USD | MXN | ◐ | ✅ | ◐ | ✅ | ✅ usd-con-dólares (sin diferencial; exige dólares en la cuenta → **comprar dólares no existe**) | ✅ mxn | ◐ (ii) | **A.1c (compra de dólares)** | real (dinámica 1 con cliente nacional) |
| 12 | USD | MXN | USD | USD | ◐ | ✅ | ◐ | ✅ | ✅ usd-con-dólares | ✅ mxn-con-dólares | ◐ (ii) | A.1c | teórica |
| 13 | USD | USD | MXN | MXN | ✗ | ✅ | ◐ | ✗ L4a | ✅ usd-con-pesos | ✅ usd-con-pesos | ◐ `fxSpread` sí (OC y pedido USD) pero sobre `sale` ambiguo; (i) | L4a, A.1c, (i) | **real (dinámica 2: pagar en pesos al TC del proveedor, facturar en USD al pactado, cobrar en pesos)** |
| 14 | USD | USD | MXN | USD | ✗ | ✅ | ◐ | ✗ L4a | ✅ usd-con-pesos | ✅ usd-con-dólares | ◐ (i) | L4a, A.1c, (i) | rara |
| 15 | USD | USD | USD | MXN | ✗ | ✅ | ◐ | ✗ L4a | ✅ usd-con-dólares (exige dólares en caja) | ✅ usd-con-pesos (cobro en pesos al pactado) | ◐ | L4a, **A.1c (compra de dólares)** | **real (dinámica 1 cobrando en pesos al pactado)** |
| 16 | USD | USD | USD | USD | ✗ | ✅ | ◐ | ✗ L4a | ✅ usd-con-dólares | ✅ usd-con-dólares | ◐ | L4a, A.1c | **real (dinámica 1 pura: todo en dólares)** |

**Resumen (18-sep-2026, antes de A.1c y L4a):** 1 completa (#1), 7 a medias (#2-4 por la caja por moneda; #9-12 por el kardex crudo, el diferencial de la FP fuera del P&L y el spread que no se ve), **8 no funcionan** (#5-8 y #13-16: toda venta en dólares, por L4a). **Después de A.1c (§ 12.7) y L4a (§ 12.8):** la pieza «Venta» es ✅ en USD y la pieza «Kardex» es ✅ en USD; quedan a medias las casillas que dependen de (i) el diferencial de la FP fuera del P&L y (ii) el spread que no se ve (8.2-4, abierta), y la posición cambiaria (A.2). De las combinaciones que de verdad pasan en la operación — #1, #5, #9, #11, #13, #15, #16 — hoy solo #1 está completa; **las dos dinámicas de cobertura del dueño (#13 y #15/#16) caen en L4a**: la mecánica de pago y cobro ya es correcta (A.1b), pero el número que factura la FV puede nacer 18× mal si el vendedor teclea dólares, y ningún candado lo detiene.

### 13.2 Lo que rompe L4a (todas las casillas con V = USD)

El precio de venta vive en pesos por convención del motor (`pricing.ts` no tiene moneda; el costo entra en pesos por A.1a) pero la pantalla no lo dice: el campo es un `MoneyField` sin moneda, el precio por omisión es el de lista en pesos, y el importe de la partida se enseña con `moneyIn(imp, currency)` → «US$» (`quotes.tsx:594-610`). Si el vendedor teclea 500 pensando en dólares, la FV nace con `amount = 500` (pesos) y `amount_fx = 500/18 = 27.78` "dólares" (`azagro.ts:2143-2148`): el caso literal de `LOGICA.md` h.14. A partir de ahí todo es consistente entre sí y todo está mal: el cobro reparte bien un número equivocado, el estado de cuenta lo imprime en el bloque "Dólar americano" con signo US$, `creditExposure` lo suma contra el límite en pesos, y `dealPnlCore` resta un costo bien convertido contra una venta ambigua. **Cerrar L4a** es el espejo de A.1a del lado venta: capturar el precio en la moneda del pedido con la etiqueta puesta y convertirlo a pesos con `fx_rate` al guardar (`mxnToCostCurrency` al revés), en los cinco nacimientos (`createQuote`, `quoteFromRequest`, `decideQuote`, `saveOrder`, `createSale`) y en la NC (`returnSale` con `amount_fx`/`fx_agreed`); los lectores en pesos no cambian. Es del tamaño de A.1a + A.1b juntos y conviene partirlo. **Es lo que sigue después de A.1c.**

### 13.3 Lo que depende de A.1c (todas las casillas con C = USD o con P/K = USD)

- **Kardex en pesos** (#9-16): la recepción convierte con el TC de la OC antes de `postStock`; con la base limpia no hay promedios que descontaminar.
- **Comprar dólares** (#3-4, #11-12, #15-16): sin `compra-usd` la cuenta en dólares solo recibe dólares por cobros de clientes en USD; pagar al proveedor en dólares (dinámica 1) exige haberlos comprado, y hoy la transferencia MXN→USD acredita pesos como dólares.
- **Caja, por cobrar y por pagar por moneda** (#2-16): el inicio suma un solo número.

### 13.4 El `fx_result` de la FP y el spread (casillas con C = USD)

Con pago en pesos (#9, #10, #13, #14) el diferencial del lado compra se registra en la FP (`fx_result` con signo de pérdida, o ATC de proveedor) pero **no llega al P&L del pedido**: la línea `netProfit = margin + mora + fxIncome − finance − discount` está congelada y `fxIncome` lee solo la FV. Con compra USD y venta MXN (#9-12) el spread cambiario del deal es 0 por construcción: `fxSpread` exige pedido y OC en USD. Los dos son columnas pendientes del P&L, no errores de saldo.

### 13.5 Banco ≠ moneda de la factura, en los dos lados

| Factura | Cuenta | Modo | Cliente | Proveedor |
|---|---|---|---|---|
| USD | MXN | usd-con-pesos | `fxPaymentSplit`, diferencial = utilidad/pérdida o ATC por cobrar/devolver (dinámica 2) | mismo reparto, signo contrario, ATC por pagar / por cobrar al proveedor |
| USD | USD | usd-con-dólares | sin diferencial, el banco lleva dólares (dinámica 1) | igual — exige dólares en caja (A.1c) |
| MXN | USD | mxn-con-dólares | los dólares valen pesos al TC del pago; sin diferencial (la deuda es en pesos) | igual |
| MXN | MXN | mxn | como siempre | como siempre |

Los ocho renglones están construidos y probados (`erp-pago-fp-tc`); la reversa los deshace con el mismo signo y no inventa diferencial cuando el abono salió de la cuenta en dólares. Lo que falta alrededor: el contra-movimiento de la reversa no copia `amount_fx`/`fx_rate`, y `fx_invoiced` no crece para proveedor (la estimación del estado de cuenta abierto sigue sobre `amount_fx` completo, hueco 21).

### 13.6 Hallazgos nuevos de esta pasada

1. **La NC de devolución de una FV en USD nace sin `amount_fx` ni `fx_agreed`** (`azagro.ts:2569-2579`): cualquier suma futura por `amount_fx` (posición cambiaria) contará la FV en dólares y la NC en cero. Va con el cierre de L4a.
2. El papel de la OC al proveedor imprime la moneda pero **no el TC** (`purchases.tsx:481-497`); el mensaje de RFQ (`doc-text.ts:271-274`) no dice en qué moneda se espera la cotización.
3. La solicitud no deja corregir el TC antes de elegir proveedor (usa el de la tabla a la fecha de la solicitud, `requests.ts:658, 790`); la RFQ sí.
4. `payments.currency` queda en `'MXN'` aunque el banco sea USD: el PAG está en pesos al pactado y solo `bank_moves` sabe que salieron dólares (decisión de A.1b, anotada).

### 12.7 Construido — A.1c, 18-sep-2026

Sin migración (columnas de la 0044). Con la base de pruebas limpia, del plan salieron la reparación del kardex viejo, la derivación de TC de OC viejas y la descontaminación de promedios; quedó lo que debe ser de aquí en adelante:

1. **Comprar dólares** (`compra-usd`, y su espejo `venta-usd` — la salida legítima para pasar dólares a pesos, que de otro modo quedaba sin camino): `addBankMove` exige TC (propuesto de la tabla a la fecha, editable), valida que la cuenta origen sea MXN y la destino USD (o al revés), compara el saldo en la moneda de la cuenta origen, escribe dos movimientos ligados por `pair_id` con `amount_fx`/`fx_rate`, y bitácora. Una **transferencia entre cuentas de distinta moneda se rechaza** nombrando «Compra de dólares» / «Venta de dólares»; las dos patas de una transferencia también quedan ligadas.
2. **Dólares en caja a promedio móvil por cuenta** (`usdCashAverage`, pura): cada entrada con TC (compra, cobro en dólares al pactado) se pondera; cada salida sale al promedio; lo sin TC (saldo inicial) se lleva aparte sin inventarle costo; **una reversa deshace la entrada a su TC** (el contra-movimiento copia `amount_fx`/`fx_rate` sin tocar los literales congelados de `erp-revertir-pago`). Bancos lo enseña: «TC promedio 18.4 · $18,400.00 en pesos».
3. **Inicio por moneda:** `cash` = solo cuentas en pesos, `cashUsd`, `arUsd`/`apUsd` (residual ÷ TC pactado de los documentos USD); las tarjetas dicen «Pesos · US$… en la cuenta en dólares» y «… · US$9,000.00 en dólares».
4. **Recepción en pesos** (Decisión 77): `receivePurchase` y `receivePartial` pasan a `postStock` `unit_price × TC de la OC` (`receiptUnitCostMxn`); una OC en dólares sin TC real no entra (mismo mensaje que la FP). `postStock`, `stock.ts`, `pricing.ts`, `cost.ts` no cambiaron de bytes.

`scripts/erp-compra-dolares.test.mjs` (6/6), `npm test` **882/882**, `tsc` limpio, ninguna prueba existente cambió. **Verificado en navegador (PGlite fresco):** compra de 1,000 USD a 18.40 → Banorte MXN $31,600.00, Banorte USD «USD 1,000.00 · TC promedio 18.4 · $18,400.00 en pesos», dos movimientos ligados; OC de 10 × 1,000 USD a 18.50 recibida → kardex **$18,500.00** por unidad, inventario **$185,000.00**, FP-0001 **$185,000.00** (USD 10,000.00 · TC 18.5): **kardex y deuda dicen el mismo número**; pago de 1,000 USD desde Banorte USD → saldo USD 0.00, FP con USD 1,000.00 pagados; inicio: «Caja $31,600.00 · Saldos bancarios en pesos», «Por pagar $166,500.00 · USD 9,000.00 en dólares».

**Revisor de dinero: PASA CON AVISOS.** Cerrado antes de commitear: la reversa de un cobro en dólares ya no mueve el promedio de caja ($66.70 en su ejemplo). Anotados: (1) no hay contra-movimiento para `compra-usd`/`venta-usd` (nada se borra; una compra mal capturada se corrige con la venta contraria al mismo TC, sin liga `reverses_id`); (2) pagar una FP desde la cuenta en dólares no registra la diferencia entre el TC pactado de la FP y el promedio de los dólares (Decisión 80 dice «sin diferencial»; es de la posición cambiaria, A.2); (3) una transferencia USD→USD entre dos cuentas en dólares sale al promedio en la origen y entra «sin TC» en la destino; (4) una OC USD con TC 1 (nacida antes de la 0044) ya no se puede recibir hasta capturar el TC en Compras — la salida existe (`setPurchaseFxRate`).

### 12.8 Construido — L4a (Decisión 82), 18-sep-2026

Sin migración. **El precio de venta se captura en la moneda del documento y se guarda en pesos** — el espejo de A.1a del lado venta:

1. **Aritmética pura** (`src/lib/erp/fx.ts`): `saleToMxn` (dólares → pesos al TC del documento, se detiene sin TC), `salePriceShown` (pesos → moneda del documento para enseñar), `snapOrConvert` (una revisión que devuelve el mismo precio que enseñó conserva el peso guardado byte a byte; un precio distinto se convierte), `finShown` (la base del financiamiento del servidor, en pesos, bajada a la moneda del documento), `reshowPrice` (al cambiar la moneda o el TC en pantalla, lo ya escrito se re-enseña; con la misma moneda y otro TC, los dólares escritos siguen siendo esos dólares). Una NC en dólares lleva `amount_fx` negativo, y `invoiceShown` la enseña en dólares (antes salía «−US$92,500.00»).
2. **Los seis nacimientos convierten ANTES del motor:** `createQuote` (los tres precios, antes de `priced`), `reviseQuote` (contra `quote_lines`), `saveOrder` (contra `sales_lines`), `createSale` (con candado: sin TC no nace), `convertCustomerPO` (con el TC de la tabla al convertir); `decideQuote` no cambia (copia pesos a pesos). **Las dos NC** (`returnSale`, `creditNoteFor`) nacen con `amount_fx`/`fx_agreed` de la FV que abonan.
3. **Pantallas en la moneda del documento, lo guardado intacto:** cotización (columnas «P. contado (USD)», precio de lista propuesto en la moneda elegida, el panel «Ver» abre con los precios, el costo puesto y el financiamiento divididos, la escalera y el aviso de utilidad negativa en la misma moneda; en pesos no se divide nada aunque haya `fx_rate` guardado), pedido (formulario, lista de pedidos, ficha, tabla «Heredado de COT», devolución, selector de factura), OC del cliente, papel y mensaje (`printQuote`, `SendButton`), **estado de cuenta** (la fila de una FV en dólares sale dividida entre el TC pactado: cargo, abonos, saldo, interés, FEGA y pronto pago — el interés es lineal en el capital, así que dividir da exactamente el interés sobre el capital en dólares; `ar`/`ap` del socio siguen en pesos vía `saldoMxn`; `utCambiaria` es pesos y no se divide), recordatorios y alertas (`invoiceShown`).
4. **Hallazgo colateral, corregido:** una empresa creada DESPUÉS de la migración 0024 nacía sin catálogo de circuitos (la migración solo sembró las que existían) y no podía cotizar («no está en el catálogo»). `seedCircuits` (`src/lib/erp/circuits-seed.ts`) siembra los cuatro circuitos desde `seedCompany`, idempotente, con la comisión de apertura **sin capturar** (se captura en Ajustes → Circuitos; regla 9).

`scripts/erp-precio-en-moneda.test.mjs` (17) y `scripts/erp-circuitos-siembra.test.mjs` (2); `npm test` **901/901**, `tsc` limpio, ninguna prueba existente cambió. **Verificado en navegador (PGlite fresco):** COT-0001 en USD con TC 18.5, precio de lista $18,500 propuesto como **1,000** al capturar el TC, 10 × 1,000 → «USD 10,000.00 · dólar pactado 18.5»; el panel «Ver» enseña precio 1,000 · costo puesto USD 500.00 · utilidad 500 · margen 50 % · «Sin cambios de precio»; PV-0001 con **1,000 USD** por unidad y total USD 10,000.00 (guardado: 18,500 y 185,000 pesos); entrega ENV/0001 y FV-0001 «USD 10,000.00 · TC 18.5 · $185,000.00»; devolución de 5 → NC-0001 «−USD 5,000.00», FV saldo USD 5,000.00; estado de cuenta en el bloque «Dólar americano»: cargo USD 10,000.00, abonos USD 5,000.00, saldo USD 5,000.00; P&L del pedido en pesos: venta $185,000.00, costo $92,500.00, margen 50 %.

**Revisor de dinero: NO PASA a la primera; cerrado antes de commitear:** (1) la escalera y el margen de una cotización EN PESOS se dividían entre el TC de la tabla (`fxQ` decidía por el número, no por la moneda); (2) la siembra de circuitos leía una columna tirada por la 0026; (3) cuatro pantallas de Pedidos enseñaban pesos con signo US$; (4) encontrado en navegador: doble división en la ficha del pedido (54.05 en vez de 1,000) y el panel «Ver» abría con los pesos crudos. **Avisos que quedan anotados:** FV en dólares nacidas ANTES de este cambio (amount en dólares tecleados) no tienen backfill — no determinado si existen en producción; la columna «Ut. cambiaria» del papel del estado de cuenta imprime pesos con signo US$ (pre-existente); `snapOrConvert` amarra por `product_id` (dos partidas del mismo producto: −0.0001 pesos); cambiar el TC de un pedido con el mismo precio en dólares cambia los pesos guardados (es lo que dice la Decisión 2). **Segunda pasada del revisor: PASA CON AVISOS** — (a) en la pantalla del estado de cuenta, la columna «Ut. cambiaria» del bloque en dólares imprime pesos con signo US$ (`statements.tsx`; el papel sí la imprime en pesos; pre-existente, pendiente); (b) una OC del cliente en USD propone el precio en 0 y el validador acepta 0 — un cero que pasa, no un número inventado; (c) una empresa nueva nace con ASR elegible y Línea Santa Rosa por construir, copia de la migración 0024, aunque el lineal sea el predeterminado desde el 5-sep.

### 13.7 Lo que sigue después de A.1c: cerrar L4a — **CONSTRUIDO el 18-sep-2026 (§ 12.8)**

**Cerrar L4a destraba 8 de las 16 casillas de la matriz — toda venta en dólares —, incluidas las dos dinámicas de cobertura del dueño (#13 dinámica 2, #15/#16 dinámica 1).** Es el espejo de A.1a del lado venta: el precio se captura **en la moneda del pedido, con la etiqueta puesta**, y se convierte a pesos con el `fx_rate` del documento al guardar (`mxnToCostCurrency` al revés), en los cinco nacimientos — `createQuote`, `quoteFromRequest`, `decideQuote`, `saveOrder`, `createSale` — y en la NC de devolución (`returnSale`, que hoy nace **sin `amount_fx` ni `fx_agreed`**: hallazgo nuevo, § 13.6). Los lectores en pesos (`creditExposure`, `byCurrency`, `dealPnlCore`, papel y estado de cuenta) no cambian de fórmula; la FV deja de poder nacer 18× mal. Es del tamaño de A.1a + A.1b juntos y conviene partirlo (captura y nacimientos primero; NC y lectores por fila después). Ver § 13.2.
