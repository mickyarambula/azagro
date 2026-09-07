# SESIÓN D — Barrido técnico: recorrer el sistema como quien trabaja ahí

**Fecha:** 6-sep-2026 · **Base:** `main` en `4f76f4d` (paso 4 subido) · **Alcance:** solo diagnóstico, nada se construyó.
**Método:** cada punto se verificó en el código con `grep`/`sed`; se cita `archivo:línea`. Lo que no se pudo verificar no está aquí. Los datos de la base son de prueba; el corte de Compaq es lo último y sigue sin decidirse si se trae historial.

**Escala.** Gravedad: **ALTA** = no se puede hacer el trabajo del día o el dinero queda mal · **MEDIA** = se hace con rodeo o queda inconsistente · **BAJA** = molestia. Frecuencia: diario / semanal / mensual / raro. Comportamiento: **truena con mensaje** · **inconsistente en silencio** · **no se puede** · **funciona con límite**.

Los siete caminos raros que ya estaban en `LOGICA.md` no se repiten aquí con detalle; al final del § 1 va su gravedad, frecuencia y qué hace hoy el sistema. El estado de los 20 hallazgos de `LOGICA.md`, re-verificado hoy, está en el § 5.6.

---

## 1. LO QUE IMPIDE OPERAR (de más grave a menos)

### 1.1 Nada se puede deshacer: ni cancelar, ni revertir, ni borrar
- **Qué pasa hoy.** No existe una sola función de cancelación o reversa en `src/lib`. `grep -rn cancel src/lib` no regresa ninguna; el único "Cancelar" de pantalla es el botón que cierra el panel de cambio de plazo (`src/routes/sales.$orderId.tsx:389`). Tampoco hay `delete from sales_orders`, `purchase_orders`, `quotes` ni `invoices` en ningún archivo (grep vacío). Un pago capturado por error se queda (LOGICA H8), una OC capturada al proveedor equivocado se queda con su FP viva (`src/lib/azagro.ts:1146-1152`), un pedido confirmado por error no se puede anular.
- **Lo único que sí se borra:** una solicitud sin cotizar (`src/lib/erp/requests.ts:514-528`, bloquea si tiene `quote_id`) y una ubicación sin existencias (`src/lib/erp/locations.ts:82-110`).
- **Gravedad ALTA · semanal · no se puede.** La corrección hoy es a mano en la base. Decisión del dueño **ABIERTA** en `ESTADO.md` (H4a, H4b).

### 1.2 Entregar y recibir es todo o nada, y entregar es facturar en el mismo clic
- **Qué pasa hoy.** `deliverSale` recibe solo `{ soId }` (`src/lib/azagro.ts:1379`) y escribe `qty_delivered = qty` (`:1427`); `receivePurchase` escribe `qty_received = qty` (`:1198`). En el mismo `deliverSale` nace la FV (`:1433-1495`): no hay entrega sin factura ni factura sin entrega, y no se puede facturar una parte.
- **Gravedad ALTA · semanal** (granel, embarques en dos viajes, cliente que recoge por partes) **· no se puede.** Decisión **ABIERTA** (`ESTADO.md` H4d).

### 1.3 La FV del sistema no sabe qué CFDI timbró Compaq (y la FP no sabe qué factura del proveedor es)
- **Qué pasa hoy.** Compaq sigue timbrando (`CLAUDE.md` § No romper 3), pero la tabla `invoices` no tiene ninguna columna para el folio o UUID del CFDI: sus columnas son `id company_id kind name partner_id date due_date state amount residual origin late_amount` (`migrations/0002_azagro.sql`) más las que se agregan en caliente (`calc calc_client circuit_code created_by credit_days credit_due cutover_key fega_part fx_result fx_treatment int_part inv_class invoice_days opening_paid order_id paid_date params_snap policy_code`). `grep -rni "uuid|folio_fiscal|cfdi|timbr" src migrations` no encuentra nada de negocio. Lo mismo del lado proveedor: `purchase_orders` solo tiene `notes` (`migrations/0002_azagro.sql`, más `fulfill_kind rfq_id so_id`) y la FP no guarda el folio de la factura que llegó.
- **Consecuencia.** Durante la semana en paralelo cada FV-#### del sistema y cada factura de Compaq son dos numeraciones sin puente; cobranza y contabilidad tienen que cruzarlas de memoria. La FV-#### además salta porque cuenta todas las facturas de cliente (LOGICA 20.3, `src/lib/azagro.ts:1433`), así que ni siquiera coincide con el número del pedido.
- **Gravedad ALTA · diario desde la semana en paralelo · inconsistente en silencio.** Hallazgo nuevo.

### 1.4 Cotización vencida o rechazada desde una solicitud = callejón sin salida
- **Qué pasa hoy.** La validez de la cotización que nace de una solicitud es fija: `addDays(today, 15)` en `quoteFromRequest` (`src/lib/erp/requests.ts:818`). Vencida, `decideQuote` no la deja aceptar ni rechazar (`src/lib/erp/ops.ts:1354-1355`). Rechazada, queda en `state = 'rejected'` (`:1359`) sin limpiar `customer_requests.quote_id`, así que `quoteFromRequest` se niega a cotizar otra vez ("Esta solicitud ya tiene…", `requests.ts:868`) y `deleteRequest` se niega a borrar la solicitud porque tiene cotización (`requests.ts:526-528`). `reviseQuote` no acepta una rechazada (`ops.ts:1053`) y su validador no recibe `validUntil` (`ops.ts:998` en adelante), así que tampoco se puede extender la fecha.
- **Consecuencia.** El cliente que dice "sí" al día 16, o que dijo "no" y luego regresa, obliga a capturar la solicitud desde cero (partidas, proveedores, márgenes, flete).
- **Gravedad ALTA · semanal · no se puede.** Hallazgo nuevo.

### 1.5 Los permisos cruzan la solicitud de ventas con la RFQ de compras
- **Qué pasa hoy.** Enviar la RFQ a proveedores desde la solicitud exige `purchases:edit` (`src/lib/erp/requests.ts:574`), pero la pantalla `/solicitudes` vive en el módulo `quotes` (`src/lib/erp/acl.ts:185-209`). En la plantilla de permisos (`acl.ts:97-183`) **compras** tiene `quotes: none` y **ventas** tiene `purchases: none`. Resultado: ventas abre la solicitud y truena al enviar la RFQ; compras no puede ni abrir la solicitud. Lo mismo al aplicar ganadores de una RFQ suelta: el candado decide `stock ? "purchases" : "quotes"` (`src/lib/erp/rfq.ts:230`).
- **Consecuencia.** Solo admin, gerencia o administración pueden cerrar el ciclo solicitud → RFQ → cotización. Con los roles reales, el flujo diario se detiene en la primera persona que no es admin.
- **Gravedad ALTA cuando se repartan roles · diario · truena con mensaje / no se puede.** Hallazgo nuevo.

### 1.6 No se puede dar de alta, cambiar ni cerrar una cuenta de banco
- **Qué pasa hoy.** Las cuentas nacen de un catálogo fijo en código, `BANK_CATALOG`, sembrado al crear la empresa (`src/lib/azagro.ts:158-168`). En el servidor solo existen `listBanks`, `saveBankOpening`, `addBankMove` y `reconcileMove` (`src/lib/erp/ops.ts`); `src/routes/banks.tsx` no tiene alta ("Nueva cuenta" no aparece). Una cuenta nueva, un cambio de número o de moneda, o cerrar una cuenta, es un cambio de código y un deploy.
- **Gravedad ALTA desde el corte** (Bancos es una de las tres cosas que se pegan al arrancar, `CLAUDE.md` § Siguiente) **· raro pero bloqueante · no se puede.** Hallazgo nuevo.

### 1.7 Un pago mayor al saldo se pierde en silencio
- **Qué pasa hoy.** `applied = Math.min(opts.amount, residual)` y el banco registra solo lo aplicado (`src/lib/erp/ops.ts:1687-1688`). No hay anticipo ni saldo a favor (`grep anticipo src/lib` vacío). El banco del sistema no cuadra contra el estado de cuenta real y nadie se entera.
- **Gravedad MEDIA-ALTA · mensual, más en temporada · inconsistente en silencio.** LOGICA H7, decisión **ABIERTA** (`ESTADO.md` L5).

### 1.8 Dólares: la OC en USD entra al kardex sin convertir, y la venta en USD se captura como si fueran pesos
- **Qué pasa hoy (compras, nuevo).** `createPurchase` acepta `fxRate` con `default(1)` (`src/lib/azagro.ts:1093-1160`) y `receivePurchase` manda al kardex `unitCost: Number(line.unit_price)` tal cual (`:1166-1230`). Una OC de 100 USD entra al promedio móvil como 100 pesos: el costo promedio de ese producto queda ×1/18 y contamina precio, margen y utilidad de todo lo que sigue (`src/lib/erp/stock.ts:17`, `:109`).
- **Qué pasa hoy (ventas, LOGICA H14).** El precio se guarda en pesos y los dólares se derivan dividiendo (`azagro.ts:1440`, `:1495`); la pantalla muestra "$" sin decir moneda.
- **Gravedad ALTA en cuanto se compre o venda en USD · raro hoy, diario cuando abran USD · inconsistente en silencio.** El lado de compras es hallazgo nuevo.

### Los siete caminos raros de LOGICA.md: gravedad, frecuencia y qué hace hoy

| Camino | Gravedad | Frecuencia | Qué hace hoy el sistema |
|---|---|---|---|
| Corregir un error de captura (pedido, OC, pago) | ALTA | semanal | **No se puede.** Sin cancelar ni revertir (§ 1.1). |
| Entrega a medias | ALTA | semanal | **No se puede.** Todo o nada (§ 1.2). |
| Devolución de cliente | MEDIA | mensual | **Funciona con límite.** Solo con pedido entregado (`azagro.ts:1556`); entra al promedio de hoy (H9); no baja el interés facturado (H11); sale como PAG sin banco (20.4). |
| Cancelar a medio camino | ALTA | semanal | **No se puede** (§ 1.1). La FP nacida con la OC se queda viva (H16). |
| Pago mal aplicado | ALTA | semanal | **No se puede** revertir (H8). El de más se pierde (§ 1.7). |
| Dos unidades (litro / tambo) | MEDIA | diario según producto | **Inconsistente en silencio.** `products.uom` existe pero `stock_moves` no tiene unidad (`migrations/0002_azagro.sql:72-84`); no hay conversión, se captura a mano. |
| Un flete para varios productos | BAJA | semanal | **Funciona.** Se prorratea al costo puesto (`DECISIONES.md:34`); no entra al kardex (H18). |

---

## 2. LO QUE ESTORBA (se opera, pero con rodeo o riesgo)

### 2.1 Dos verdades del costo: el que se captura a mano y el que dicta el kardex
`saveProduct` acepta `cost: z.number()` y hace `update products set … cost = ${data.cost}` (`src/lib/azagro.ts:656-720`); el kardex escribe la misma columna con el promedio móvil en cada movimiento (`src/lib/erp/stock.ts:109`). Lo capturado a mano manda hasta el siguiente movimiento y luego desaparece sin aviso; mientras tanto `resolveCost` lo usa para cotizar. **MEDIA · semanal · inconsistente en silencio.** Hallazgo nuevo.

### 2.2 Litros y tambos a mano
Ver tabla § 1. `products.uom` es texto libre; el kardex, el precio y la cotización no saben de unidad. **MEDIA · diario según producto.**

### 2.3 Las OC directas (brokeraje / vía ASR) nunca cierran
El único lugar que pone `purchase_orders.state = 'done'` es `receivePurchase` (`src/lib/azagro.ts:1200`), y esa misma función rechaza las OC directas ("no se recibe en bodega"). Quedan "confirmadas" para siempre y la lista de compras se llena de pendientes que no lo son. **MEDIA · semanal · inconsistente en silencio.** Hallazgo nuevo.

### 2.4 La FP nace al capturar la OC, no al recibir
`azagro.ts:1146-1152`: la cuenta por pagar y su vencimiento se cuentan desde el día de la OC. `receivePurchase` solo la crearía si no existiera (`:1201-1203`), cosa que nunca pasa. **MEDIA · semanal · funciona así.** LOGICA H16, decisión **ABIERTA** (L6).

### 2.5 "Enviar" no envía nada: abre el correo o WhatsApp de la persona
`src/components/send-doc.tsx:140-142` arma un `mailto:` o `wa.me`; el sistema no guarda copia ni constancia de que salió. La RFQ "enviada" al proveedor (`sendVendorRfq`, `requests.ts:564`) solo crea el SC-#### y sus renglones: no manda correo y no deja bitácora. **MEDIA · diario · funciona con límite.** Hallazgo nuevo en la parte de la RFQ.

### 2.6 Un código repetido saca el error crudo de Postgres
`humanError` (`src/lib/utils.ts:110-122`) no traduce la violación de índice único. Al capturar un cliente con código repetido, o cuando dos personas facturan al mismo tiempo (índices de `migrations/0015_folios_unicos.sql:6-10`), la pantalla enseña `duplicate key value violates unique constraint …`. **BAJA · semanal · truena con mensaje ilegible.** Hallazgo nuevo.

### 2.7 "Solo sus clientes" filtra la lista de clientes y el estado de cuenta, nada más
`own_only` se aplica en `listPartners` (`src/lib/azagro.ts:433`, `:457`) y en el estado de cuenta (`src/lib/erp/ops.ts:2017`); no en pedidos, cotizaciones ni solicitudes (no hay más ocurrencias en `src/lib`). Y en las dos consultas `seller_id is null` deja ver a todos los clientes sin vendedor asignado. Un vendedor con candado ve las cotizaciones de los demás. **MEDIA cuando se repartan roles · diario · inconsistente en silencio.** Hallazgo nuevo.

### 2.8 No se puede desactivar un cliente, proveedor ni producto
`products` no tiene columna `active` (columnas: `id company_id code name category uom cost list_price min_stock unique product_type ref_cost`), no hay borrado ni baja para socios ni productos (grep vacío). El catálogo crece con las capturas equivocadas y todas aparecen en los selectores. **MEDIA · mensual · no se puede.** Hallazgo nuevo.

### 2.9 Gastos: se capturan y ya
`createExpense` (`src/lib/erp/expenses.ts:140-196`) no lleva `writeAudit`, no va en `withTx`, y para efectivo inserta un movimiento de banco (`:177`) que queda huérfano si lo demás falla. No hay editar ni borrar gasto. **MEDIA · semanal · inconsistente en silencio.** Hallazgo nuevo.

### 2.10 Las alertas de vencimiento salen cuando alguien abre la app
`sendDueAlerts` se dispara al montar la pantalla (`src/components/app-shell.tsx:145`) y con un botón (`:424-425`); no hay cron. Además `resendReady` solo mira la variable de entorno (`src/lib/erp/alerts.ts:125`) mientras el envío real también lee `company_settings.resend_key` (`:201`): la pantalla puede decir "sin correo" con el correo configurado en Ajustes. **BAJA · diario · funciona con límite.** Hallazgo nuevo en lo de `resendReady`.

### 2.11 Cobrar se detiene si la tabla de TIIE o la política no cubren la fecha
La mora se emite dentro del cobro sin `try/catch` (`src/lib/erp/ops.ts:1711`) y truena con `missingChargesMessage` (`:2444`): el cobro completo se revierte. Es lo correcto por la regla 9, pero para cobranza significa "ve a Ajustes, captura la TIIE, regresa". **BAJA · mensual · truena con mensaje.** LOGICA 20.1, hoy ya no es silenciosa.

### 2.12 La numeración salta y el folio no corresponde al pedido
FV-#### cuenta todas las facturas de cliente incluidas FI y NC (`azagro.ts:1433`), FI cuenta todas las facturas (`ops.ts:2504`). **BAJA · diario · cosmético.** LOGICA 20.3, ya anotado en `DECISIONES.md:74`.

---

## 3. LO QUE FALTA (no existe y se va a necesitar)

| # | Qué falta | Dónde se nota | Decisión pendiente |
|---|---|---|---|
| 3.1 | Cancelar y revertir: pedido, OC, cotización, pago, FV | § 1.1 | `ESTADO.md` H4a, H4b (ABIERTAS) |
| 3.2 | Recepción y entrega parciales; facturar por parte | § 1.2 | H4d (ABIERTA) |
| 3.3 | Puente con Compaq: folio/UUID del CFDI en la FV y en la FI; folio de la factura del proveedor en la FP | § 1.3 | ninguna, nadie lo ha pedido |
| 3.4 | Anticipos y saldo a favor (pago de más, NC contra factura pagada) | § 1.7, LOGICA H10 | L5, L3c (ABIERTAS) |
| 3.5 | Devolución a proveedor y NC de proveedor | LOGICA H15 | H4c (ABIERTA) |
| 3.6 | Alta, edición y baja de cuentas de banco | § 1.6 | ninguna |
| 3.7 | Reactivar o extender una cotización vencida o rechazada; validez editable | § 1.4 | ninguna |
| 3.8 | Baja / inactivo de clientes, proveedores y productos | § 2.8 | ninguna |
| 3.9 | Editar y borrar gastos | § 2.9 | ninguna |
| 3.10 | Unidad de medida en el kardex y conversión (L ↔ tambo) | § 2.2 | `CLAUDE.md` lo tiene como "Después" |
| 3.11 | Tipo de cambio real en la OC en dólares (costo al kardex convertido) | § 1.8 | ninguna |
| 3.12 | Restaurar un respaldo: existe `exportBackup` (`src/lib/erp/cutover.ts:46`) y no existe restaurar (`grep -rn "restoreBackup\|importBackup\|restaurar" src` vacío) | día que haga falta | ninguna |
| 3.13 | Importar saldos de banco al corte: `cutover.ts` solo conoce `kind: customer / supplier` (`:85-86`), `grep bank cutover.ts` vacío | corte | `CLAUDE.md` § Siguiente 1 |
| 3.14 | Borrar un archivo adjunto; archivos de más de 4 MB (`src/lib/erp/files.ts:65`, se guardan en base64 en una columna de texto) | diario | ninguna |
| 3.15 | Reloj propio para alertas (cron) | § 2.10 | ninguna |
| 3.16 | P&L que descuente devoluciones (`src/lib/erp/reports.ts:155`, `:174`; `qty_returned` no aparece en `reports.ts`) | mensual | LOGICA 20.5 |
| 3.17 | Bitácora completa (ver § 5.2) | auditoría | ninguna |

---

## 4. LO QUE SOBRA (honesto)

Todo esto se verificó con referencias en cero o con lectura directa.

**Funciones de servidor que ninguna pantalla llama** (0 archivos en `src/routes` y `src/components` los importan):
`createSale` (`src/lib/azagro.ts:1295`), `listSales` (`:1237`), `getStatement` (`:1779`), `applyLateInterest` (`:1767`), `joinCompany` (`:253`), `getWorkspace` (`:202`), `listDocuments` (`src/lib/erp/ops.ts:2572`). Las cuatro de `azagro.ts` son la primera versión de venta y cartera, ya reemplazadas por `orders.ts` y `ops.ts`; confunden a quien lee.

**Columnas que se leen y nunca se escriben:**
- `invoices.late_amount` (`migrations/0002_azagro.sql:140`): 5 referencias, ningún `set late_amount` (`azagro.ts:1708`, `:1812` lo leen).
- `customer_pos.fx_rate` (`src/lib/erp/cpo.ts:31`).
- `partners.late_rate`, "Mora anual % (informativa)" (`src/components/partner-form.tsx:160`): se captura, el motor no la lee (la mora sale de TIIE + spread de Ajustes). O se quita el campo o se decide para qué es.

**217 `alter table … add column if not exists` en caliente dentro de `src/lib`** (conteo de hoy). En Neon las migraciones corren en el `build` (`package.json:11-12`, `db:migrate`) y en PGLite al arrancar (`src/lib/db.ts:141-158`), así que los alters en caliente son cinturón y tirantes: `getOrder` ejecuta 13 por llamada (`src/lib/erp/orders.ts:158-176`), `listQuotes` 7, y `saveGuia` repite los de `getOrder` (`orders.ts:796-799` vs `:171-174`). Cada uno es un viaje a la base por pantalla abierta.

**Plataforma de vista previa que no es del ERP:** `src/lib/multiplayer` (28 K, 0 referencias fuera de sí mismo); `PreviewHostBridge` montado en `src/routes/__root.tsx:3`, `:41`; `/cotizador` que solo redirige (`src/routes/cotizador.tsx:4`); ocho scripts de plataforma (`grok-pwa-plugin.mjs`, `brand-check.mjs`, `browser-smoke*`, `preview-thumbnail.mjs`, `install-page.html`); `og/site.json`; `trail.ts lastPath()` sin lector.

**Script de una sola vez:** `scripts/erp-precios-reinterpretados.mjs`.

**Documentación desactualizada que hoy contradice al código:** `PROMPT-CLAUDE.md:6` no menciona `DISENO_FINANCIAMIENTO.md`, `ESTADO.md` ni `DECISIONES.md` (que `CLAUDE.md` exige leer primero); `AUDITORIA.md:13`, `:94` y `EXCEL_VS_SISTEMA.md` describen el motor anterior al paso 3; `ESTADO.md:487-488` lista `credit_policies.spread` y `fega_rate` como columnas sin uso y ya no existen.

**Componentes e imports sin uso:** `src/components/erp.tsx:84`, `:88`, `:96`, `:102`, `:170`, `:193`; `KindChips` en `partner-form.tsx:24`; imports muertos en `sales.index.tsx:8`, `vencimientos.tsx:6`, `azagro.ts:10`, `users.ts:14`, `app-shell.tsx:8`, `:29`.

**Lo que NO sobra aunque parezca:** `rememberTrade` (`src/lib/erp/links.ts:121`, escrito desde seis módulos) sí tiene lector, `listPartnerProducts` → panel del socio (`src/components/partner-products.tsx:5`). Y el panel de inventario sí muestra kardex por producto, diferencias kardex-existencia y exporta a Excel (`src/routes/inventory.tsx:85-101`, `:138`, `:479-486`).

---

## 5. HUECOS DE LÓGICA O TRAZABILIDAD

### 5.1 Producción puede caer a una base que se borra al reiniciar, sin aviso
`dbSource = databaseUrl ? "neon" : "pglite"` (`src/lib/db.ts:19`). Si un deploy pierde `DATABASE_URL`, la app arranca en PGLite, captura todo el día y lo pierde. Solo `/importar` lo enseña (`src/lib/erp/cutover.ts:41`); ninguna otra pantalla ni el arranque lo detienen. **ALTA si pasa · raro · inconsistente en silencio.** Hallazgo nuevo.

### 5.2 La bitácora no cubre todo lo que mueve dinero o catálogo
Sin `writeAudit`: gastos (`src/lib/erp/expenses.ts:140-196`), movimientos de banco no ligados a factura (`src/lib/erp/ops.ts:1929`, `:1936`), ganadores de RFQ (`src/lib/erp/rfq.ts:209`), envío de RFQ (`requests.ts:564`), borrado de ubicación (`locations.ts:82-110`). En `savePartner` solo se auditan los campos de crédito (`src/lib/azagro.ts:498-520`): un cambio de nombre, RFC, grupo o vendedor no deja rastro. **MEDIA · diario · inconsistente en silencio.** Hallazgo nuevo.

### 5.3 El costo tiene dos dueños (§ 2.1) y el kardex no tiene moneda ni unidad (§ 1.8, § 2.2)
Consecuencia de trazabilidad: no se puede reconstruir de dónde salió un promedio si en medio hubo una captura a mano o una OC en dólares.

### 5.4 Numeración por conteo + índice único = truena en concurrencia
Los folios se calculan contando renglones (`azagro.ts:1433`, `ops.ts:2504`) y el índice único (`migrations/0015_folios_unicos.sql:6-10`) evita el duplicado. Dos personas facturando a la vez: la segunda ve el error crudo de § 2.6 y vuelve a intentar. **BAJA · raro · truena con mensaje.**

### 5.5 El inventario se repara solo y en silencio
`listInventory` llama `seedOpeningLedger(...).catch(() => undefined)` (`src/lib/azagro.ts:805`): si el kardex y la existencia no cuadran, la pantalla postea movimientos "Saldo inicial" a nombre de quien abrió (`src/lib/erp/stock.ts:236-246`), y si falla no dice nada. **BAJA con datos limpios, MEDIA si el corte deja diferencias · raro.** LOGICA 20.6.

### 5.6 Estado de los 20 hallazgos de LOGICA.md (re-verificado hoy)

| # | Hallazgo | Hoy | Gravedad | Frecuencia | Qué hace |
|---|---|---|---|---|---|
| 1 | Abono Compaq se borra al cobrar | **Corregido** (`cutover.ts:200`, `stock.ts:262`) | — | diario | funciona |
| 2 | 2ª FI cobra de menos | **Corregido** (`credit.ts:434-435`, `ops.ts:2521-2522`) | — | mensual | funciona |
| 3 | Pago parcial sin tramos | **Disuelto**: interés siempre sobre el cargo (`credit.ts:402`, `DECISIONES.md:16`) | BAJA | — | funciona |
| 4 | Mora desde `due_date` | **Corregido** (`ops.ts:2408`, `:2101`) | — | diario | funciona |
| 5 | Bancos se salta la mora | **Corregido** (`ops.ts:1900-1903` dentro de `withTx` `:1897`) | — | diario | funciona |
| 6 | P&L: mora en $0 | **Corregido** (`ops.ts:2513`, `reports.ts:311`) | — | mensual | funciona |
| 7 | Pago > saldo | **Sigue** (`ops.ts:1687-1688`) | MEDIA-ALTA | mensual | inconsistente en silencio |
| 8 | Sin reversa de pagos | **Sigue** | ALTA | semanal | no se puede |
| 9 | Devolución al promedio de hoy | **Sigue** (`azagro.ts:1582-1591` sin `unitCost`, `stock.ts:186-188`) | MEDIA | mensual | funciona con costo de hoy |
| 10 | NC contra FV pagada | **Sigue**, con una fuga tapada: ya no se esfuma por Bancos (`ops.ts:1662`) | MEDIA | mensual | NC abierta para siempre |
| 11 | Devolución no ajusta mora | **Sigue** (`returnSale` no toca `interest_invoiced` ni el cargo) | MEDIA | raro | inconsistente en silencio |
| 12 | Cargo (pantalla) vs saldo (FI) | **Corregido**: las dos sobre el cargo (`ops.ts:2182`, `:2449`) | — | diario | funciona |
| 13 | Nadie captura el TC del pago | **Corregido** (`credit.tsx:457`, `ops.ts:1675`, `:1785`) | — | según USD | truena si falta TC |
| 14 | Moneda de captura USD | **Sigue** (`azagro.ts:1440`, `:1495`) | ALTA en USD | raro → diario | inconsistente en silencio |
| 15 | Sin cancelaciones | **Sigue** | ALTA | semanal | no se puede |
| 16 | FP nace con la OC | **Sigue** (`azagro.ts:1146-1152`) | MEDIA | semanal | funciona así |
| 17 | Sin parciales | **Sigue** (`azagro.ts:1198`, `:1427`) | ALTA | semanal | no se puede |
| 18 | Ajuste sin costo / flete al kardex | **Sigue** el ajuste (`azagro.ts:981-987`); flete **decidido** fuera del kardex (`DECISIONES.md:34`) | BAJA | mensual | funciona (promedio) |
| 19 | Pronto pago / FI retroactiva | **Corregido** el pronto pago (`ops.ts:1820-1841`, solo si el resto cabe en la bonificación); la FI de más **no se corrige** | BAJA | mensual | funciona / no se corrige |
| 20.1 | FI silenciosa | **Corregido**: sin `catch` (`ops.ts:1711`), truena y revierte | — | mensual | truena con mensaje |
| 20.2 | Mismo producto en dos renglones | **Sigue** (`azagro.ts:1575`, `:1614`) | BAJA | raro | inconsistente en silencio |
| 20.3 | Folios con huecos | **Parcial**: índice único sí, conteo sigue | BAJA | diario | huecos; duplicado truena |
| 20.4 | NC disfrazada de PAG | **Sigue** (`azagro.ts:1631-1634`) | BAJA | mensual | confunde al conciliar |
| 20.5 | P&L ignora devoluciones | **Sigue** (`reports.ts:155`, `:174`) | MEDIA | mensual | inconsistente en silencio |
| 20.6 | Inventario repara solo | **Sigue** (`azagro.ts:805`) | BAJA | raro | repara en silencio |
| 20.7 | Banco sin validar moneda | **Sigue** (`ops.ts:1690-1693` no trae `currency`) | MEDIA | raro | inconsistente en silencio |

Balance: 10 corregidos, 1 disuelto, 1 parcial, 14 siguen. Los que impiden el día: 8, 15, 17 y 14 (en USD); son la misma familia y las cuatro preguntas H4a–H4d de `ESTADO.md` siguen sin respuesta del dueño.

### 5.7 Un archivo de producción sin ignorar en el repo
`antes.json` (instantánea de precios de producción del paso 3) está en el árbol sin rastrear y **no** está en `.gitignore` (`git status` lo lista como `??`). Un `git add -A` lo sube. **MEDIA · una vez · riesgo.**

---

## 6. RECOMENDACIÓN

**Antes de la semana en paralelo, en este orden.** Son las cosas que cortan el día y que no dependen de una decisión del dueño:

1. **El puente con Compaq (§ 1.3).** Una columna de folio/UUID en FV, FI y FP, capturable desde la pantalla del pedido y de la OC, visible en el estado de cuenta. Sin esto la semana en paralelo no se puede cruzar. Pequeño.
2. **Permisos de la RFQ (§ 1.5) y "solo sus clientes" (§ 2.7).** Que ventas pueda enviar la RFQ desde su solicitud, que compras pueda abrir la solicitud a la que responde, y que el candado del vendedor cubra pedidos y cotizaciones. Pequeño; solo `acl.ts` y los candados.
3. **Cuentas de banco desde pantalla (§ 1.6).** Alta, edición, baja. Pequeño.
4. **Cotización vencida o rechazada (§ 1.4).** Extender validez y volver a cotizar la misma solicitud. Mediano.
5. **Mensajes legibles (§ 2.6)** y el aviso duro cuando producción corre en PGLite (§ 5.1). Chico.

**Lo que necesita al dueño primero** (preguntas ABIERTAS en `ESTADO.md`, sin las cuales construir es adivinar):
- Cancelar y revertir (H4a, H4b): qué se anula, quién puede, qué deja rastro. Es la familia entera de § 1.1 y de H8/H15.
- Parciales (H4d): si una FV por parte es aceptable, o si la entrega parcial vive sin factura hasta completar.
- Pago de más y NC contra factura pagada (L5, L3c): anticipo, saldo a favor o devolución.
- Cuándo nace la deuda con el proveedor (L6).
- Unidad de medida: si el tambo es un producto aparte o una conversión.

**Limpieza que no toca dinero y quita ruido** (una sola sesión, sin decisiones): las siete funciones muertas y las columnas que nadie escribe (§ 4), los 217 alters a una migración normal, `multiplayer` / `PreviewHostBridge` / scripts de plataforma, los cuatro documentos desactualizados, y `antes.json` al `.gitignore`.

**No ahora:** UOM completo, restaurar respaldo, cron de alertas, adjuntos grandes. Se anotan y se hacen cuando la operación los pida.
