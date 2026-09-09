# BLOQUE DE DISEÑO — investigación de lectura

**Fecha:** 9-sep-2026 · **Base:** `main` en `787896f` + los dos documentos adoptados · **Alcance:** solo lectura. No se escribió código, no se corrió migración, no se propone solución.
**Método:** cada afirmación se verificó con `grep`/`sed` sobre el código de hoy y cita `archivo:línea`. Lo que no se pudo verificar está en § 6, no repartido por el documento como si fuera cierto. No se abrió la base de datos.

Los dos problemas que señaló el dueño, contra lo que hay:
- **"El inicio no es un tablero."** Las cifras *sí existen* (`getDashboard` calcula por cobrar, por pagar, caja, inventario y vencidos — § 3), pero en la pantalla van en **cuarto lugar**, después de 13 tarjetas de atajos, un diagrama de tres carriles y hasta cuatro avisos (§ 2). Y la lista "Existencia por bodega" lista **todas** las ubicaciones, tengan existencia o no (§ 2).
- **"El menú no convence."** Hay **dos taxonomías** que no coinciden: la del menú (`Favoritos / Pedidos / Almacén / Contactos / Finanzas / Ajustes`, `src/lib/nav.ts:16-110`) y la de permisos (`Tablero / Cotizaciones / Ventas / Compras / Inventario / Cartera / Gastos / Bancos / Estados de cuenta / Contactos / Productos / Configuración / Usuarios`, `src/lib/erp/acl.ts:23-37`). "Favoritos" tiene una sola sección, "Inicio" (`nav.ts:16-22`). Y hay pantallas archivadas donde encajaron, no donde se buscan (§ 1).

---

## 1. La navegación de hoy

### 1.1 Cómo se arma el menú

- El menú se declara en `src/lib/nav.ts:16-110`: seis módulos (`favorites`, `orders`, `warehouse`, `contacts`, `finance`, `settings`) con sus secciones, estrellas (`starred`) y pestañas.
- Qué ve cada persona lo decide `src/components/app-shell.tsx:208-216`: una sección se muestra si el **módulo de permisos** de su ruta (`pathModule`, `acl.ts:194-219`) no es `none` para esa persona. "Favoritos" se muestra si tiene `dashboard`; "Ajustes" si tiene `settings` **o** `users`.
- Las plantillas por rol viven en `acl.ts:99-200` (`templateAcl`). Ocho roles: `admin`, `gerencia`, `administracion`, `ventas`, `compras`, `almacen`, `cobranza`, `consulta` (`acl.ts:41-49`). El bloque final sin `if` (`acl.ts:168-183`) es el de `cobranza`.

### 1.2 Lista completa de rutas

Roles: **A** admin · **G** gerencia · **Ad** administración · **V** ventas · **C** compras · **Al** almacén · **Cb** cobranza · **Q** consulta. "(v)" = solo ver.

| Ruta (`src/routes/`) | Menú: módulo → sección (`nav.ts`) | Módulo de permiso (`acl.ts:194-219`) | Quién la ve |
|---|---|---|---|
| `/` `index.tsx` | Favoritos → Inicio (`:21`) | `dashboard` | todos (los 8 tienen `dashboard`) |
| `/sales` `sales.index.tsx` | Pedidos → Pedidos de venta (`:29`) | `sales` | A, G, Ad(v), V, Al, Cb(v), Q(v) |
| `/sales/nuevo`, `/sales/$orderId` | pestaña "Nuevo" (`:34`) / sin entrada | `sales` | igual |
| `/purchases` `purchases.tsx` | Pedidos → Pedidos de compra (`:38`) | `purchases` | A, G, Ad(v), C, Al, Q(v) |
| `/solicitudes` (+`/nuevo`, `/$id`) | Pedidos → Solicitudes (`:46`) | `quotes` | A, G, Ad(v), V, Q(v) |
| `/quotes` `quotes.tsx` | Pedidos → Cotizaciones (`:47`) | `quotes` | A, G, Ad(v), V, Q(v) |
| `/rfq` (+`/nuevo`, `/$rfqId`) | Pedidos → Cotizar proveedores (`:48`) | `purchases` | A, G, Ad(v), C, Al, Q(v) |
| `/cpo` `cpo.tsx` | Pedidos → OC del cliente (`:49`) | `sales` | como `/sales` |
| `/cotizador` `cotizador.tsx` | **sin entrada** — es un redirect a `/purchases?tab=new` (`cotizador.tsx:3-5`) | `quotes` | — |
| `/inventory` `inventory.tsx` | Almacén → Inventario (`:57`) | `inventory` | A, G, Ad(v), V(v), C, Al, Q(v) |
| `/bodegas?tab=bodegas` `bodegas.tsx` | Almacén → Bodegas (`:58`) | `inventory` | igual |
| `/bodegas?tab=destinos` | Almacén → Destinos (`:59`) | `inventory` | igual |
| `/products` (+`/nuevo`, `/$productId`) | Almacén → Productos (`:60`) | `products` | todos (C edita; Q ve) |
| `/partners?tab=clientes` (+`/nuevo`, `/$partnerId`) | Contactos → Clientes (`:68-73`) | `partners` | todos (Ad, V, C editan; Al, Cb, Q ven) |
| `/partners?tab=proveedores` | Contactos → Proveedores (`:74-79`) | `partners` | igual |
| `/credit?lado=cobrar` `credit.tsx` | Finanzas → Por cobrar (`:87`) | `credit` | A, G, Ad, V(v), C(v), Cb, Q(v) |
| `/credit?lado=pagar` | Finanzas → Por pagar (`:88`) | `credit` | igual |
| `/vencimientos` | Finanzas → Vencimientos (`:89`) | `credit` | igual |
| `/cadena` | Finanzas → Cadena de crédito (`:90`) | `credit` | igual |
| `/statements` | Finanzas → Estados de cuenta (`:91`) | `statements` | A, G, Ad, V(v), Cb, Q(v) |
| `/banks` | Finanzas → Bancos (`:92`) | `banks` | A, G, Ad, Cb, Q(v) |
| `/gastos` | Finanzas → Gastos (`:93`) | `gastos` | A, G, Ad, V(v), C, Cb(v), Q(v) |
| `/reportes` | Finanzas → Utilidad (`:94`) | `credit` **y además** `canSeeMargins` (`index.tsx:62`; `reports.ts` exige márgenes) | A, G, Ad |
| `/settings` | Ajustes → **Empresa** (`:102`) **y** Ajustes → **Reglas** (`:104`) | `settings` | A, G, Ad(v) |
| `/users` | Ajustes → Equipo (`:103`) | `users` | A, G(v) |
| `/importar` | Ajustes → Importar / corte (`:105`) | `settings` | A, G, Ad(v) |
| `/bitacora` | Ajustes → Bitácora (`:106`) | `settings` | A, G, Ad(v) |
| `/ayuda` | Ajustes → Cómo se usa (`:107`) | `dashboard` | todos |
| `/login`, `/api/auth` | — | — | — |

### 1.3 Lo que está archivado donde encajó, no donde se busca (patrón D)

Criterio del patrón D (`PATRONES-DISENO.md:191-195`): *la pantalla vive donde el usuario la busca, no donde encajó al construirla; cuando sirve a dos módulos, se decide por dónde la busca quien la usa todos los días.*

1. **Destinos** (puntos de entrega del cliente) vive en **Almacén → Destinos** (`nav.ts:59`). Es un dato del cliente: el propio código lo trata así — para borrar un destino, `deleteLocation` pide permiso de **Contactos** (`src/lib/erp/locations.ts`, bloque `if (loc[0]?.loc_type === "customer") { assertCan(..., "partners", "edit") ... }`). Quien lo usa todos los días es ventas, que tiene `partners: edit` y `inventory: view` (`acl.ts` plantilla `ventas`). Está bajo el uso equivocado. **Debería vivir en Contactos → Clientes** (en la ficha del cliente), por la misma razón que el ejemplo de Cosecha.
2. **Bodegas se crean en dos lugares**: `inventory.tsx:128` ("Nueva bodega", `saveLocation` en `:336`) y `bodegas.tsx:88` ("Nueva bodega", `saveLocation` en `:132`). Mismo catálogo, dos pantallas. Debería haber una.
3. **"Empresa" y "Reglas"** son dos entradas del menú (`nav.ts:102`, `:104`) que abren **la misma página** sin distinguirse: `/settings` no tiene `validateSearch` ni pestañas (`settings.tsx`, verificado por ausencia). La segunda entrada no lleva a nada distinto.
4. **"Cómo se usa"** (`/ayuda`, un manual: `ayuda.tsx:10` "Cómo se trabaja Azagro") vive bajo **Ajustes** (`nav.ts:107`). Un manual no es un ajuste; nadie lo busca ahí.
5. **"Favoritos"** es un módulo con una sola sección, "Inicio" (`nav.ts:16-22`), y en la pantalla de inicio hay 13 tarjetas fijas también llamadas "Favoritos" (`index.tsx:26-40`, `:72`). Dos cosas con el mismo nombre y distinto contenido.
6. **Solicitudes y Cotizaciones** viven en el menú bajo **Pedidos** (`nav.ts:46-47`) pero su módulo de permiso se llama **Cotizaciones** (`acl.ts:25`); **Cotizar proveedores** (`/rfq`) vive bajo Pedidos con permiso de **Compras** (`acl.ts:198`); la sección **Pedidos** mezcla el lado de venta (SOL, COT, PV, OC del cliente) con el lado de compra (OC, RFQ). En la pantalla de permisos (`/users`) la persona ve "Cotizaciones / Ventas / Compras"; en el menú ve "Pedidos". Son dos mapas del mismo territorio.
7. **Utilidad** (`/reportes`) está bajo Finanzas pero su permiso es el de **Cartera** más márgenes (`acl.ts:209`, `index.tsx:62`): no hay módulo "Reportes". Funciona, pero un rol con Cartera y sin márgenes ve la entrada… — no verificado en pantalla; ver § 6.

---

## 2. El inicio de hoy

`src/routes/index.tsx`, en el orden en que se pinta:

| # | Bloque | Dónde | De dónde sale | Observación |
|---|---|---|---|---|
| 1 | Título "Favoritos" + **13 tarjetas** de atajo | `:72`, `:26-40`, `:80-98` | lista fija `FAVORITES`, filtrada por permiso (`:60-64`) | Ocupa la primera pantalla. Son ligas, no datos. |
| 2 | "Seguir donde te quedaste" | `:74-78` | `prevPath()` | Chico. |
| 3 | **Diagrama del flujo** (`FlujoAzagro compact`) | `:100-102`; `src/components/flujo.tsx:29-85` | texto fijo | Tres carriles ("Venta al cliente", "Reponer bodega", "Devolución del cliente", `flujo.tsx:38,61,70`) que se pintan **siempre**; `compact` solo esconde el encabezado (`:33`). Es un manual. |
| 4 | Avisos (hasta 4): clientes sin vendedor, NC sin timbrar, NC pendientes ante el SAT, FP de mercancía no recibida | `:106-146` | `getDashboard` (`azagro.ts:400-430`) | Derivados. Aparecen solo si el conteo > 0. |
| 5 | **Cifras**: Caja, Por cobrar (con "N vencidas"), Por pagar, Inventario Azagro (proveedor y tránsito) | `:148-163` | `getDashboard` (`azagro.ts:310-335`, `:389-396`) | **Aquí está "cuánto le deben y cuánto debe"**, en cuarto lugar, y solo si el rol ve cartera/bancos/costos (`:65-67`). |
| 6 | Tres tarjetas: Antigüedad CxC (4 cubetas), Cola operativa (pedidos y OC pendientes), **Existencia por bodega** | `:165-` | `aging` (`azagro.ts:342-355`), `pending` (`:384-388`), `locStock` (`:372-382`) | `locStock` consulta `from locations l left join stock_quants` — **lista todas las ubicaciones, con o sin existencia** (`:376-381`). De ahí las "bodegas en cero". |
| 7 | Tabla de facturas recientes | después de `:256` | `recentInv` (`azagro.ts:356-370`) | Lista, no cifra. |

Qué ocupa más de lo que merece, con evidencia: los bloques 1 y 3 son fijos y no dependen de ningún dato; el 6c lista ubicaciones vacías por construcción de la consulta. Las cifras (5) existen pero llegan después de todo eso.

---

## 3. Qué cifras puede calcular el sistema hoy, sin construir nada

Lista real, con la función que ya la calcula. "Guarda" = a quién se la muestra el servidor.

### 3.1 `getDashboard` — `src/lib/azagro.ts:302-460`
| Cifra | Campo | Cómo se calcula | Guarda |
|---|---|---|---|
| Por cobrar (total) | `ar` | Σ `residual` de facturas de cliente `open` (`:310-315`) | `credit` |
| Por cobrar vencido | `arOverdue` | misma consulta, `due_date < hoy` (`:312`) | `credit` |
| Por pagar | `ap` | Σ `residual` de facturas de proveedor `open` (`:316-320`) | `credit` |
| Valor del inventario: total, Azagro, en proveedor, en tránsito | `stockValue`, `stockOwn`, `stockSupplier`, `stockTransit` | Σ `quantity × avg_cost` (o `products.cost`) por `loc_type` (`:322-331`) | `canSeeCosts` |
| Caja | `cash` | Σ por banco de `opening` + movimientos (`:389-396`) | `banks` |
| Productos bajo mínimo | `lowStock` | conteo de productos con Σ existencia `< min_stock` (`:332-341`) | — |
| Pedidos / OC pendientes | `pendingSo`, `pendingPo` | conteo por estado `not in ('done','cancelled')` (`:384-388`) | — |
| Facturas vencidas (n) | `overdueN` | conteo de FV `open` con `due_date < hoy` (`:388`) | `credit` |
| Antigüedad CxC | `aging` | cubetas Por vencer / 1-30 / 31-60 / 61+ sobre `residual` (`:342-355`) | `credit` |
| Existencia y valor por bodega | `locStock` | por ubicación (`:372-382`) | — |
| Facturas recientes | `recentInv` | últimas N (`:356-370`) | `credit` |
| Clientes sin vendedor; FP de mercancía no recibida; NC sin timbrar; NC pendientes ante el SAT | `orphanCustomers`, `fpSinRecibir`, `ncSinTimbrar`, `ncPendientesSat` | conteos derivados (`:400-430`) | `partners` / `credit` |

### 3.2 `getCompanyPnl` — `src/lib/erp/reports.ts:527`, por periodo `from`/`to`
Ventas del periodo (n y monto), compras (FP del periodo), gastos por clase (operativo, de pedido, financiero), mora facturada, utilidad bruta / operativa / neta, **cobrado** y **pagado** del periodo (`reports.ts:574-583`, claves `collected`, `paidOut`). Guarda: `credit` + márgenes.

### 3.3 `getPanorama` — `reports.ts:618`
Por cliente y por grupo: venta, mora, TC, costo, comisión, descuento, financiamiento Santa Rosa, protección, utilidad, realizada, caja, proporcional, pedidos excluidos; totales. Más cobranza: facturado y pendiente (capital), mora total y pendiente, TC por cobrar y por devolver (`reports.ts:710-730`). Guarda: márgenes.

### 3.4 `listDealPnl` / `computeDealPnl` — `reports.ts:434`, `:29`
Utilidad **por pedido** (venta, costo, flete, comisión, financiamiento, descuento, TC, margen y margen %, días excedidos, protección) y totales del periodo con los excluidos y sus motivos.

### 3.5 `getUpcomingDue` — `reports.ts:763`
Vencido hoy y **proyección por mes** de lo por cobrar (solo facturas de cliente de producto, `reports.ts:785-786`), con el spread de cobro.

### 3.6 `getLiveStatement` — `src/lib/erp/ops.ts` (estado de cuenta en vivo)
Por cliente o proveedor: cada factura con saldo, días vencidos, mora viva, TC vivo, **lo que debe hoy** (`dueNow`); totales `ar`, `ap`, y por moneda cargo/abono/saldo/interés (`ops.ts:2626-2645`).

### 3.7 Por socio, por banco, por factura
- `listPartners` (`azagro.ts:481-494`): por cliente/proveedor, `ar`, `ap` y límite de crédito.
- `listBanks` (`ops.ts:1809-1810`): por banco, saldo inicial y movimientos.
- `listInvoices` (`azagro.ts:1836-1900`): por factura, `days_overdue`, `days_left`, y las marcas derivadas (mercancía no recibida, sin timbrar, pendiente SAT, último abono).
- `buildDigest` (`src/lib/erp/alerts.ts`): lo que vence en N días, por cobrar y por pagar, con los días de aviso de Ajustes.
- Inventario (`azagro.ts:877-986`): existencias, kardex, **por recibir** y **por entregar** por cantidad (`:922-951`), y el cuadre kardex-vs-existencia (`:954-986`).
- Límite de crédito contra saldo abierto: se calcula al confirmar un pedido (`orders.ts:545-556`); la cifra por cliente es la misma `ar` de `listPartners`.

---

## 4. Qué no se puede calcular hoy (haría falta construir)

Dicho aunque implique construir; no es propuesta, es inventario de huecos.

1. **Entregado sin facturar.** No hay dato: entregar y facturar es un solo acto (`azagro.ts:1463-1600`). Cualquier cifra sería cero por construcción hasta el bloque de parciales, que está en pausa.
2. **Vencido por cliente como cifra del servidor.** `listPartners` da `ar` total por cliente (`azagro.ts:493`), no cuánto de eso está vencido; hoy se obtendría sumando `listInvoices` en pantalla. No hay función.
3. **Proyección de lo por pagar por mes.** `getUpcomingDue` solo mira facturas de cliente (`reports.ts:785`). Para proveedores no hay proyección.
4. **Comparativo contra el periodo anterior.** `getCompanyPnl` acepta un periodo (`reports.ts:527`); no hay función que devuelva dos ni la variación. Se podría llamar dos veces desde pantalla, pero no existe hoy.
5. **Historia del valor del inventario** (cómo estaba hace un mes). No hay instantáneas de `stock_quants`; solo el valor de ahora (`azagro.ts:322-331`).
6. **Días promedio de cobro / rotación de inventario.** No hay función.
7. **Lista de productos bajo mínimo.** Existe el conteo (`lowStock`, `azagro.ts:332-341`), no la lista con nombres.
8. **Cuadre "todo lo recibido se rinde" por orden o por pedido** (patrón A6). No existe; solo el cuadre kardex-vs-existencia (`azagro.ts:954-986`). Ver § 5.
9. **Pendientes por entregar con fecha comprometida.** La consulta de por entregar existe por cantidad (`azagro.ts:943-951`); si el pedido guarda una fecha de entrega comprometida no lo verifiqué (§ 6).

---

## 5. Azagro contra `PATRONES-DISENO.md`, patrón por patrón

Veredictos: **cumple** / **a medias** / **no cumple**, con la evidencia.

### A. Datos

**A1 Congelado vs vivo — a medias.**
- Cumple en facturas y cotizaciones: la FV guarda `params_snap` con TIIE, comisión, plazo y circuito al emitir (`azagro.ts:1579-1592`); la cotización congela `tiie/spread/commission_rate/cost_rate/collection_rate` (migraciones 0026, `CLAUDE.md:13`); el papel de la FV lee `invoice_lines` (renglones congelados) y el expediente (`credit.tsx:7, 306`).
- El estado de cuenta es **vivo a propósito** (mora al día): pantalla y papel salen de la misma fila calculada (`statements.tsx:43-65`, `statementPaperRow` en `doc-text.ts`). Es la regla 7 de `CLAUDE.md` ("dos versiones de cada documento"), consistente.
- **Donde no cumple:** la cotización se **revisa en sitio** (`reviseQuote` sobreescribe `quote_lines` y sube `revision`, `ops.ts:1436-1447`) y el papel imprime `data.lines` (`quotes.tsx:294, 657`): reimprimir una cotización después de una revisión **no devuelve lo mismo**; los precios anteriores quedan solo en bitácora. Es el error que A1 describe.

**A2 Documento padre y documentos hijos — a medias.**
- Cumple: la NC de devolución cuelga del pedido (`order_id`, `origin`, `azagro.ts:1730-1738`) con **tope** (`qty_delivered − qty_returned`, `:1699`); no se revierte una entrega con NC viva (`delivery-reversal.ts:96-104`); la NC tiene su propia reversa (paso 8, `return-reversal.ts`). La NC contraria de una reversa cuelga por `reverses_id`.
- No cumple: el folio del hijo **no se deriva del padre** (`NC-0007`, contador propio, `azagro.ts:1726-1727`), A2 pide `LIQ-004-C1`.

**A3 Marcar, nunca borrar — a medias.**
- Cumple en documentos: `cancelled_at/by/reason`, estados `cancelled`/`reversed` (migración 0029; pasos 0-8), y el único borrado duro que había (`deleteRequest`) se sustituyó por `cancelRequest` (`requests.ts:527`).
- **No cumple en catálogos:** no existe `is_active` ni "archivado" en ninguna tabla ni migración (verificado por ausencia: `grep is_active|archived` en `migrations/` y `src/lib` no devuelve nada). Una ubicación **se borra de verdad** (`locations.ts`, `deleteLocation`, `delete from locations`), con candado solo de existencia. Productos y socios no tienen borrado ni archivado: se quedan para siempre en los selectores.
- La decisión "qué lectura filtra lo cancelado" está tomada por lectura (pasos 0, 4, 7) y probada por texto (`scripts/erp-cancelar.test.mjs`), que es lo que A3 pide.

**A4 Series de folio — no cumple.**
- Cumple: prefijos fijos y únicos por serie (`migrations/0015_folios_unicos.sql`), regla 6 de `CLAUDE.md`.
- **No cumple en el contador:** varias series comparten contador. `FV-####` se numera contando **todas** las facturas de cliente (`azagro.ts:1519`, `kind = 'customer'`: incluye FI, ATC y NC); `FI-####` cuenta **todas** las facturas de la empresa (`ops.ts:2803`, sin filtro); `PAG-####` cuenta todos los pagos, incluidos contra-pagos y pronto pago; y **los siete tipos de movimiento de kardex comparten un solo contador** (`stock.ts:102-105`, `nextRef` cuenta `stock_moves` completo): `REC/0041` y `ENT/0042` son consecutivos. Es exactamente el "contador global" que A4 llama el error clásico. Solo `NC` cuenta su propia serie (`name like 'NC-%'`, `azagro.ts:1726`). `scripts/erp-facturas-repetidas.mjs` ya lo documenta como "los folios saltan".

**A5 Quién absorbe — a medias.**
- Cumple: motivo **obligatorio** en cancelar y revertir (`z.string().trim().min(1)`, pasos 1-8); sin valor por omisión de negocio (regla 9 de `CLAUDE.md`); el monto se congela.
- No cumple: la devolución acepta motivo **vacío** y pone un texto por omisión (`azagro.ts:1637`, `:1741`); el tratamiento del diferencial cambiario tiene default `"utilidad"` cuando no se elige (`ops.ts:2035`), y A5 dice sin default cuando varía caso por caso.

**A6 Todo lo recibido se rinde — a medias (el cuadre que existe no es éste).**
- Existe **un** cuadre: kardex contra existencia proyectada, por producto y bodega, con aviso en pantalla (`azagro.ts:954-986` `rawMismatch`/`mismatches`; `inventory.tsx:137-142` "El kardex y la existencia no cuadran en N partidas"). Y la conciliación bancaria por movimiento (`ops.ts:2215-2237`).
- **No existe** el cuadre A6 propiamente: `recibidas = vendidas + devueltas + … + pendientes` por orden, ni el candado "si quedan unidades sin clasificar no se emite". Las cantidades sí están (`qty`, `qty_received`, `qty_delivered`, `qty_returned`), nadie las cierra en una identidad.

**A7 Linaje y falla visible — cumple en lo verificado.**
- El expediente sube la cadena resolviendo por id y por nombre (`src/lib/erp/deal.ts:26-44`, `pushUnique`).
- Cuando el linaje no se resuelve, **se avisa, no se inventa**: costo de salida no encontrado → entra al promedio de hoy y lo dice en pantalla y bitácora (Decisión 27, `azagro.ts` `returnSale`); movimiento de devolución que no cuadra → se bloquea diciéndolo (Decisión 42, `return-reversal.ts`).
- Tope de saltos y detección de ciclos: **no verificado** (§ 6).

**A8 Migraciones aditivas — a medias.**
- 30 migraciones; dos hacen `drop column`: `0019_sin_valores_por_omision.sql:52` (`default_tiie`) y `0026_motor_por_circuito.sql:46` (`asr_commission`). Las dos están razonadas en `DECISIONES.md`/`CLAUDE.md:13` ("TIRADA — la comisión vive solo en `credit_circuits`"), pero no siguen el procedimiento A8 (argumento, demostración con números, orden para fallar seguro, prueba del caso de falla). Sin `rename` ni cambio de tipo.

### B. Pantalla

**B1 Si un botón no hace algo real, no se pone — no determinado** (requiere ver la pantalla; § 6). Evidencia indirecta a favor: el paso 0 escondió botones que iban a truenar (`purchases.tsx:416`, `sales.$orderId.tsx:618`).

**B2 Los mensajes dicen qué pasó y qué hacer — a medias.**
- 175 `throw new Error` en `src/lib`; **82 son genéricos** ("no encontrado", "no disponible", "Sin permiso", "Sin empresa"), 47 %. Ejemplo: `"Orden no disponible"` (`azagro.ts:1281`), `"Pedido no disponible"` (`:1493`).
- Los mensajes nuevos sí cumplen: el bloque de deshacer nombra folio, número y el paso que hace falta (p. ej. `cancel.ts`, `reversal.ts`, `receipt-reversal.ts`); recibir sin plazo dice a quién pedirle (`azagro.ts` `bornSupplierDebt`, Decisión 30).

**B3 Candado con salida — cumple en lo nuevo, a medias en lo viejo, y la prueba solo verifica la mitad.**
- Cada bloqueo de los pasos 4-8 nombra el camino ("revierte primero PAG-0044", "primero el paso 5") y `deleteLocation` también ("hay existencia. Trasládala antes.").
- Las pruebas verifican **que el mensaje existe** (texto), no **que el camino funciona**; `METODOLOGIA-TRABAJO.md:169` y B3 piden las dos. `PRUEBAS.md` (guía del dueño) es la que podría cubrir la segunda; no verifiqué que lo haga para cada candado (§ 6).

**B4 Advertencia sin bloqueo cuando la decisión es del usuario — cumple.**
- Límite de crédito: aviso y `overrideCredit` con casilla, solo admin, con bitácora (`orders.ts:53, 556`).
- Devolución sin costo de salida: avisa y deja pasar (Decisión 27). FV timbrada al revertir: avisa y deja pasar (Decisión 39). Y "si no hay contra qué comparar, no hay aviso" se cumple en la TIIE: sin renglón se detiene, no estima (regla 9).

**B5 Armar y confirmar en el mismo botón — no cumple (se resolvió con otro patrón).**
- No queda ningún `window.confirm` (verificado por ausencia). Todas las acciones grandes usan un **modal aparte** con motivo obligatorio (`src/components/cancel-doc.tsx`: `CancelButton`, `CancelChainButton`, `ReversalButton`, `ReceiptReversalButton`, `DeliveryReversalButton`, `ReturnReversalButton`; `send-doc.tsx`). B5 dice explícitamente "sin modal aparte". Es una diferencia de diseño, no un hueco de seguridad: los modales enseñan números y piden motivo.

**B6 Validación en servidor y en pantalla — cumple.** Es el patrón de los pasos 0-8 (`CLAUDE.md` regla 5c/5d) y hay prueba de cableado por acción (`scripts/erp-cancelar*.test.mjs`, `erp-revertir-*.test.mjs`).

**B7 Buscador cuando la lista es larga — a medias.**
- Existe `SearchSelect` (`src/components/search-select.tsx`) y se usa para socios, productos y ubicaciones en 14 archivos (gastos, inventario, bancos, RFQ, bodegas, cotizaciones, OC del cliente, compras, estados de cuenta, formularios de pedido/solicitud/destino).
- Quedan `<select>` nativos sobre listas que pueden ser largas: **unidad de medida** con **56 opciones escritas en código** (`fields.tsx:143-146` lee `UOM_CATALOG`, `catalog.ts:3`); bodega de recepción al aceptar una cotización (`quotes.tsx:1216`, todas las ubicaciones); proveedor ganador por partida en la RFQ (`rfq.$rfqId.tsx:124`, solo los invitados); cuenta de banco al cobrar (`credit.tsx:515`); `CatalogSelect` (`catalog-select.tsx:27`, usado en `products.index.tsx:90` y `partner-form.tsx:144`; tamaño de sus listas no verificado). Los demás `<select>` son enums cortos (moneda, tipo de entrega, tratamiento TC, rol).
- No verifiqué si `SearchSelect` filtra por código **y** nombre (§ 6).

**B8 El documento se lee solo — a medias.** El estado de cuenta lleva las dos fechas, notas y encabezado propio (`doc-text.ts`, regla 7). La FV y la cotización imprimen con membrete y referencia al expediente (`expedienteFor`). **La NC no tiene papel ni título propio**: `grep "Nota de cr"` en `doc-text.ts`, `print-doc.ts` y `credit.tsx` no devuelve nada; hoy se imprime, si acaso, con la plantilla de factura (no verificado en pantalla, § 6).

### C. Configuración

**C1 Ajustes de comportamiento — cumple.** Son pocos y viven en Ajustes: 8 números (`POLICY_FIELDS`, `ops.ts:73-82`: plazos, comisión + FEGA, spreads, umbral de pronto pago, vigencia de cotización), la escalera de plazos, razón social, RFC, correo, días de aviso (`ops.ts:88-100`). Ninguno con valor por omisión (regla 9).

**C2 Catálogos vivos — no cumple en cuatro puntos concretos.**
- Catálogos que sí viven en tabla y se editan en pantalla: productos, socios, ubicaciones, `uoms` (`migrations/0005_catalogs.sql:3`; `products.index.tsx:22` pestaña "unidades"), tipos de producto (`products.index.tsx:36`), categorías de gasto (`expenses.ts:24-25`), políticas de cobro (`credit_policies`), circuitos (`credit_circuits`), bancos.
- **Dos fuentes para la misma lista:** la unidad de medida se edita en tabla (`uoms`) pero el selector de pedidos, compras y cotizaciones lee **una constante de 56 renglones en código** (`src/lib/erp/catalog.ts:3` `UOM_CATALOG`; `fields.tsx:143`). Es el error que C2 describe: traducir o archivar una unidad en la tabla no cambia el selector.
- **Valores de catálogo reconocidos por literal en el código:** la política de cobro `"NONE"` está escrita en `azagro.ts:115, 122, 1604`, `cpo.ts:206`, `sales.nuevo.tsx:36` y `credit.ts` (`NO_MORA_POLICY = "NONE"`); el circuito `"SANTA_ROSA"` en `reports.ts:118`, `orders.ts:408`, `ops.ts:773, 1383`; y el financiero se localiza **por nombre**: `partner_kind = 'finance' or code = 'ASR' or name ilike '%santa rosa%'` (`orders.ts:95`). C2 pide tabla de mapeo, no literal.
- **La razón social está escrita a mano en 8 archivos** (`"AZ INSUMOS AGRICOLAS SA DE CV"` en `send-doc.tsx`, `azagro.ts`, `alerts.ts`, `credit.tsx`, `purchases.tsx`, `quotes.tsx`, `sales.$orderId.tsx`, `statements.tsx`) aunque Ajustes tiene `legalName` (`ops.ts:92`).
- Modos de entrega (`DELIVERY_MODES`, `requests.ts:22`; `REQUEST_MODES`, `request-form.tsx:9`; `MODE_LABEL`, `solicitudes.$solicitudId.tsx:39`), tipo de ruta, modo de embarque y clase de gasto son **enums de código** (`z.enum`, `requests.ts:409`, `orders.ts:64, 825`, `expenses.ts:145`). Llevan comportamiento, así que es defendible que no sean catálogo vivo — pero conviene decidirlo, no heredarlo.

**C3 Mapeos — cumple donde existe.** Categoría de gasto → clase (`expenses.ts:24-25`, en tabla); política → interruptores de comisión/FEGA (`credit_policies.charge_commission/charge_fega`, migración 0021); circuito → comisión y base (`credit_circuits`). Lo que se salta el mapeo es lo listado en C2 (`NONE`, `SANTA_ROSA`, `ASR` por nombre).

**C4 Datos de prueba borrables — no cumple.** No existe la función. `grep -i "datos de prueba|borrar todo|purge|reset|demo|restaurar"` en `src/lib` y `src/routes` no devuelve ninguna acción de borrado (solo `resetAcl` de permisos, `users.ts:258`). `/importar` es el corte de Compaq (`cutover.ts`), no un borrado. Sin esta función no se pueden verificar anclas después de probar, que es lo que `METODOLOGIA-TRABAJO.md:118, 170` pide.

**C5 Nombres — a medias.** UI en español y SQL/columnas en inglés (`qty_received`, `cancel_reason`, `reverses_id`). Pero el **código de servidor mezcla identificadores en español**: `fpSinRecibir`, `ncSinTimbrar`, `ncPendientesSat` (`azagro.ts:406-430`), `borradores`/`firme` (`ops.ts:1277-1283`), `sinSalida` (`azagro.ts` `returnSale`), `promedios` (`receipt-reversal.ts`). C5 pide código de servidor en inglés.

### D. Dónde poner cada cosa — no cumple (§ 1.3, siete casos con evidencia).

### E. Lo que no se hace
- **No se borra historia:** cumple en documentos (A3); no en ubicaciones (`deleteLocation`).
- **No se adivina:** cumple (regla 9; Decisiones 27, 35, 42).
- **No se inventan datos de catálogo y se dejan en producción:** no verificable sin la base (§ 6). Sí hay **texto de otro proyecto en la pantalla de Azagro**: "tu cuenta de siempre (ahora Plein Produce)" en `send-doc.tsx:182` y "Correos: Azagro vs Plein Produce" en `ayuda.tsx:47`.
- **No se pone un botón que no hace nada:** § 6.
- **No se mete mejora sin preguntar / no se cierra un camino sin abrir otro:** es el método de los pasos 0-8 (`DECISIONES.md`).

---

## 6. Lo que no pude determinar leyendo el código

1. **Cuántas ubicaciones hay y cuántas están en cero.** El dueño dice 25; la consulta lista todas (`azagro.ts:372-382`). No abrí la base.
2. **Con qué rol entra el dueño** y por tanto qué tarjetas y cifras ve exactamente en el inicio (`index.tsx:60-67` filtra por permiso).
3. **Si existen datos inventados de catálogo en producción** (patrón E): ubicaciones, destinos o socios de prueba. Es consulta a la base.
4. **Cómo se ve cada pantalla renderizada** (B1, B8, la NC impresa, si "Utilidad" aparece en el menú a un rol con Cartera y sin márgenes): no corrí el navegador en esta sesión.
5. **Si `SearchSelect` filtra por código y por nombre** (B7): no leí su implementación.
6. **Tamaño de las listas de `CatalogSelect`** (`products.index.tsx:90`, `partner-form.tsx:144`).
7. **Tope de saltos y ciclos en el expediente** (A7, `deal.ts`): no lo verifiqué.
8. **Si `PRUEBAS.md` prueba, para cada candado, que el camino de salida funciona** (B3, `METODOLOGIA:169`).
9. **Si el pedido guarda una fecha de entrega comprometida** (§ 4.9).
10. **Cuáles son las anclas numéricas de Azagro.** `METODOLOGIA-TRABAJO.md:115, 194` dice que es lo primero que hay que definir y que sin eso no hay red de seguridad. Hoy la red son las pruebas de identidad al centavo por bloque (`scripts/erp-circuito-lineal.test.mjs`, `erp-revertir-pago.test.mjs`, etc.) y el script contra producción `scripts/erp-circuitos-verificacion.mjs --guardar/--comparar`; no hay tres cifras declaradas que se verifiquen antes y después de cada bloque.
11. **Si hay miembros con los roles `cobranza` y `consulta`** en producción (las plantillas existen; el uso no).
