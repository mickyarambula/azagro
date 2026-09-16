# C4 — Borrar datos de prueba: diagnóstico y plan

**Fecha:** 15-sep-2026 · **Base:** `main` en `b8b6576`+ · **Alcance:** diagnóstico y plan.

**Estado (15-sep-2026):** **bloque C4 completo, pasos 1-6** — `migrations/0034_datos_de_prueba.sql`, `scripts/purge-plan.mjs`, `scripts/erp-borrado-pruebas.test.mjs`, `scripts/erp-tablas-clasificadas.test.mjs`, `src/lib/erp/purge.ts` + `scripts/erp-borrado-servidor.test.mjs` (paso 4), la pantalla en `/importar` + etiquetas en `/bitacora` + `scripts/erp-borrado-pantalla.test.mjs` (paso 5), y la documentación — `DECISIONES.md` (Decisiones 57-60), `PATRONES-DISENO.md` (C4 cumplido), `ESTADO.md` § 4.15 cerrada y sus conteos corregidos (paso 6).
- **npm test:** 588 → 599 (pasos 1-3) → 610 (paso 4) → 618 (paso 5: 8 pruebas de texto sobre la pantalla; ninguna existente cambió). `tsc --noEmit` limpio.
- **Paso 5 — nota de método (primera vez en el proyecto: pantalla probada en el navegador de verdad, no solo por tipos).** `scripts/erp-borrado-pantalla.test.mjs` solo comprueba el cableado por texto — qué se llama, en qué orden, qué candado envuelve qué —, no que un clic real haga lo que dice. Para eso se corrió la pantalla completa: `npm run dev` (sin `DATABASE_URL` ⇒ PGLite fresco en memoria) + Playwright headless (ya está como dependencia del repo, `chromium-1234` en caché — no hay que instalar nada) contra `http://localhost:8080`, con un guion real de usuario, no mocks:
  1. Alta de cuenta por correo en `/login` (modo "Crear cuenta").
  2. Onboarding de primera empresa (0 empresas en la base ⇒ `canCreate`; el alta queda admin) — `/importar` → "Cargar / actualizar catálogos" (clientes y productos reales del catálogo Compaq, para tener con qué capturar algo).
  3. Una solicitud real desde `/solicitudes/nuevo` (dato de prueba de verdad, no una fila insertada a mano).
  4. En `/importar`: el preview cuenta "1 fila" y avisa que es una foto, no un número exacto; nombre tecleado incorrecto deja "Borrar datos de prueba" deshabilitado (verificado con `isDisabled()`, no leyendo el JSX); el nombre exacto lo habilita y el borrado corre — mensaje "Borrado en «Empresa»: Solicitudes: 1" y el preview vuelve a "no hay nada que borrar".
  5. "Arrancó la operación real" pinta el banner rojo y queda en `/bitacora`; "Regresar a pruebas" exige nombre + la frase exacta `REGRESAR A PRUEBAS` + motivo y devuelve la sección a la normalidad.
  Cada paso se comprobó con una captura de pantalla real (`page.screenshot`) y se vigiló la consola del navegador por errores — una pantalla puede renderizar su cascarón mientras cada fetch de datos truena, y eso no se ve leyendo el código. Un detalle real que esto encontró y el texto no habría visto: "1 filas" en vez de "1 fila" (ya corregido). Gotcha de PGLite: vive en memoria del proceso del dev server, así que una empresa creada en una corrida sigue viva en la siguiente si no se reinicia el servidor entre corridas — y eso rompe el onboarding ("primera empresa" deja de aplicar con `canCreate: false`), así que cada corrida independiente mata el puerto 8080 y relanza `npm run dev` antes de empezar. **Vale la pena repetir este método — dev server + Playwright headless + un guion de alta/onboarding real, con capturas — la próxima vez que una pantalla nueva necesite probarse como la ve un usuario, no solo por tipos ni por texto.**
- **Paso 4, lo que quedó en el plan y no en el servidor (regla "el servidor no escribe SQL propia"):** `previewCounts` (el conteo del preview sale de la MISMA sentencia de cada paso convertida a `count(*)` — la prueba compara conteo-antes = borrado-después paso por paso), `runPurge(run, id, { expectName })` (el nombre tecleado se compara ANTES de la primera sentencia), `purgeState` (lectura sin `for update` para el preview), `PREVIEW.productCost` (cuántos productos cambian de costo), `LIVE` (`set` con `on conflict … where live_since is null` — crea el renglón de Ajustes si falta y nunca pisa una marca puesta; `clear`; `docs` por tabla del grupo A; `audit`), `setLive` / `clearLive` / `liveBlockers` / `LIVE_HARMLESS_ACTIONS` (acciones de bitácora que NO escriben documentos; lo desconocido bloquea). **Fechas de negocio: estrictamente un día después de la marca** (lo del mismo día es ambiguo y de eso se encarga la bitácora, con reloj de la base y `>` al instante). `purge.ts` solo decide quién/cuándo/con qué confirmación y deja rastro; `borrado-rechazado` cubre también los rechazos de fijar/quitar la marca (el detalle dice cuál).
- **Corrección del dueño al construir:** **el plan mismo valida `$1`** (`purgeGuard`: la empresa existe con `for update` en `companies` y `company_settings`, se niega si `live_since` está fijado nombrando «Regresar a pruebas», y devuelve el nombre para que el paso 4 lo exija tecleado). 
- **Aclaración (15-sep-2026, insertada en § 4 línea 1):** una empresa **sin renglón en `company_settings`** no tiene obstáculo para el borrado: se trata como "en pruebas". La marca de arranque (`live_since` fijado) solo la prende un administrador a propósito; que falte un renglón de configuración no significa operación arrancada.
- **Paso 6 — documentación (15-sep-2026).** `ESTADO.md` § 4.15 cerrada, citando las Decisiones 55-60 y los tres commits del bloque (`0c16c18`, `262bc95`, `4c8b2ca`); conteo de preguntas abiertas corregido en § 2 (sin cambio: verificado que ninguna de las 9 es de C4), § 4 (el "9" venía del 5-sep-2026 sin recontar; era 11, ahora 10) y § 5 (misma corrección). `DECISIONES.md` recibió cuatro decisiones que quedaron tomadas al construir los pasos 4 y 5 y no estaban escritas: el candado `live_since` con salida — difícil y con rastro, patrón B3 (Decisión 57); un documento del mismo día no bloquea "Regresar a pruebas", lo cubre la bitácora con reloj propio (Decisión 58); una empresa sin renglón de Ajustes se trata como "en pruebas" (Decisión 59); el preview es una foto, la protección real es el nombre tecleado (Decisión 60). `PATRONES-DISENO.md` C4 marcado cumplido, citando que la prueba "ninguna tabla olvidada" es la regla del patrón ("se actualiza en el mismo bloque que crea la tabla") hecha código.

**Decisiones del dueño ya tomadas en esta sesión:** la bitácora se **conserva completa**; se borra **solo lo operativo** (catálogos, ajustes y personas se quedan); lo del corte de Compaq **siempre sobrevive**.

## Contexto

Es lo último antes del bloque de parciales (`PARCIALES.md` § 6: "C4 antes de la prueba en producción de cualquiera"). Hoy no existe ninguna forma de limpiar lo que se prueba en el sitio (`ESTADO.md` § 4.15); los dos pedidos de referencia PV-0003/PV-0004 siguen en producción desde el 5-sep porque la decisión fue "no se borran a mano; con un script de limpieza dedicado" (`DECISIONES.md:76`). Parciales genera por cada caso de prueba dos FV, N FP y N movimientos de kardex — sin borrado, producción se llena de basura antes de arrancar.

El principio del sistema es "no se borra, se agregan movimientos contrarios" (`DESHACER.md:4`, Decisiones 15 y 16). Este bloque construye **la única excepción**, y la confina: solo antes de arrancar la operación real, solo administrador, solo lo que no es del corte, con preview, confirmación escrita, rastro y candado de una sola vía.

---

## Las cinco respuestas, contra el código

### 1. ¿Qué es "dato de prueba" y se puede distinguir de uno real?

**No hay marca "es de prueba" en ninguna tabla.** Lo único que el sistema sabe distinguir es **lo que entró por el corte de Compaq** de lo que se capturó en la app:
- Facturas del corte: `invoices.cutover_key` (índice único) + `origin = 'Corte Compaq'` + `opening_paid` (`src/lib/erp/cutover.ts:151-226`).
- Existencias del corte: `stock_moves.move_type = 'opening'` + `origin = 'Corte Compaq'` (`cutover.ts:272-337`).
- **Nada marca** pagos, movimientos de banco, gastos, socios ni productos (`migrations/0002:22-49,143-152`, `0003:74-87`).

Eso cambia todo, en este sentido: **la única definición posible es "dato de prueba = todo lo capturado en la app que no es del corte"**, y esa definición **solo es verdad mientras no haya arrancado la operación real**. El día que se capture la primera venta de verdad, será indistinguible de una de prueba. Por eso el diseño lleva un candado de una sola vía (§ 4): el dueño declara "arrancó la operación real" y desde ese momento el botón se niega para siempre. Hoy la base real tiene 0 movimientos de kardex y 1 empresa (radiografía del 15-sep): todo lo que hay es prueba.

Limitación honesta que el preview debe decir: socios, productos, bodegas o bancos **creados durante una prueba** no tienen marca y se quedan. El preview puede listar los que no están en el catálogo de Compaq (comparando `code` contra `PARTNER_CATALOG`/`PRODUCT_CATALOG`, `src/lib/erp/compaq.ts`) para que el administrador los revise a mano.

### 2. Qué tablas y en qué orden

Todas las tablas de negocio cuelgan de `companies` con `on delete cascade`; pero **dentro** de la empresa muchas ligas son sin cascada (`stock_moves.product_id`, `*.partner_id`, `expenses.*`, `bank_moves.*`, los `reverses_id` de las reversas), y hay un **ciclo**: `bank_moves.expense_id` ↔ `expenses.bank_move_id` (`migrations/0008_gastos.sql:26,37`). Postgres (y PGlite 0.5.4 = Postgres 17) verifica esas ligas **al final de cada sentencia**, así que el orden importa y el ciclo hay que romperlo primero.

**Se borra (grupo A), todo `where company_id = $1`, en este orden:**
1. `update expenses set bank_move_id = null` (rompe el ciclo)
2. `bank_moves`
3. `expenses`
4. `payments` (arrastra `payment_allocs`)
5. `invoices where cutover_key is null` (arrastra `invoice_lines`)
6. `customer_pos` (arrastra `customer_po_lines`)
7. `purchase_orders` (arrastra `purchase_lines`)
8. `sales_orders` (arrastra `sales_lines`)
9. `vendor_rfqs` (arrastra suppliers/lines/bids/**targets**)
10. `quotes` (arrastra `quote_lines`)
11. `customer_requests` (arrastra líneas)
12. `stock_moves where not (move_type = 'opening' and origin = 'Corte Compaq')` — incluye los `'Saldo inicial'` de `seedOpeningLedger` (`stock.ts:320-345`): se derivan de existencias y se regeneran solos; si sobrevivieran duplicarían el corte
13. `stock_quants` (todas; se reconstruyen)
14. `documents`, `doc_files where kind <> 'cutover'` (los CSV del corte se adjuntan como `doc_files` `kind='cutover'`, `src/routes/importar.tsx:206`), `notifications`
15. `folio_counters` (se re-siembra)

Los `reverses_id` (original y reversa en la misma sentencia) no estorban. Ninguna reversa puede apuntar a una fila del corte por los caminos de hoy (las tres reversas filtran `receipt/delivery/return` y `order_id`); si un día pasara, la llave foránea detiene el borrado entero — correcto.

**Se conserva:** `companies`, `company_settings`, `members`, `member_acl`, `member_favorites`, `access_requests`, auth (`user`/`session`/`account`/`verification`), `partners`, `partner_contacts`, `partner_groups`, `partner_products`, `products`, `product_kinds`, `uoms`, `locations`, `banks` (con su `opening`), `expense_categories`, `credit_policies`, `credit_circuits`, `tiie_rates`, `fx_rates`, `funding_rates`, `audit_log`, `_migrations`, y las facturas y existencias del corte.

**Hueco encontrado:** el SQL del borrado nombra **seis** cosas que hoy solo nacen en tiempo de ejecución y no en ninguna migración: la tabla `notifications` (`alerts.ts:20`) y las columnas `invoices.opening_paid` (`cutover.ts:157`), `invoices.fx_treatment` / `fx_result` (`azagro.ts:2034-2035`), `stock_moves.unit_cost` y `stock_quants.avg_cost` (`stock.ts:91-92`). En una base construida solo con migraciones (la PGlite de las pruebas, o un Neon donde nunca se abrió esa pantalla) el borrado truena. Solo esas seis van en 0034 (corrección del dueño, 15-sep). Las otras que también nacen por `alter` en runtime pero el borrado **no** nombra (`vendor_rfq_targets`, `invoices.created_by/calc/params_snap/int_part/fega_part`) se quedan para el bloque de las 35 columnas huérfanas (`PARCIALES.md` § 2 del reporte de A4).

### 3. Qué pasa con los contadores, la cartera y la bitácora

- **Contadores de kardex** (`folio_counters`): se re-siembran con la **misma consulta** de la migración 0033 (máximo por serie de los refs que sobreviven). Solo quedan los `INI/` del corte; REC/ENT/TR/AJ/DEV/REV nacen en 0001 la primera vez que se pidan.
- **Los otros doce contadores por `count(*)`** (PV, OC, COT, SOL, SC, GAS, PAG, NC, ATC): su base queda vacía → reinician en 0001. **FV, FP y FI siguen contando las del corte** (FV cuenta `kind='customer'`, `azagro.ts:1541`; FI cuenta todas, `ops.ts:2803`): arrancan en N+1 — exactamente como hoy, no es regresión. El índice único de folios (`0015`) excluye las del corte (`where cutover_key is null`), así que no hay choque.
- **Cartera:** las facturas del corte vuelven a su estado de importación: `residual = amount − opening_paid`, `state = 'open'`, y en cero todo lo que un cobro, una mora, un ajuste de TC o una reversa les hubieran escrito (`interest_invoiced`, `fega_charged`, `paid_date`, `fx_paid`, `fx_treatment`, `fx_invoiced`, `fx_result`, `cancelled_*`, `sat_cancelled_at`). `folio_fiscal`/`uuid_fiscal` se conservan (pueden ser dato real del puente). Bancos: sin movimientos, el saldo vuelve al `opening` capturado. Límite de crédito: solo consume el saldo del corte.
- **Existencias:** `stock_quants` se reconstruye con una sentencia desde los movimientos que sobreviven (Σ entradas − Σ salidas; promedio ponderado de las entradas). `products.cost` se recalcula con la misma fórmula de `refreshProductCost` (`stock.ts:191-206`) para los productos con existencia de corte, y **vuelve a 0 para los que no tienen existencia** (decisión del dueño: regresa al costo de catálogo — y el catálogo de Compaq no trae costo: lo inserta en 0 y nunca lo pisa, `compaq.ts:143-147`). `ref_cost` (0016, capturado a mano) no se toca: es ajuste, no proyección. Sin esto, un producto que solo se movió en pruebas conservaría el promedio que dejó la prueba, porque `refreshProductCost` no escribe cuando el promedio es 0.
- **Bitácora:** se conserva completa (decisión del dueño). Los renglones que hablan de documentos borrados quedan como texto; `listAudit` no hace join con documentos (`audit.ts:49-108`), no se rompe nada. Se agrega un renglón `borrado-de-pruebas` con conteo por tabla y lo conservado; los intentos rechazados quedan como `borrado-rechazado` **fuera** de la transacción (patrón de `cancel.ts` `auditRejected` y `acl.ts` `logDenied`).
- **Caché:** nada del servidor guarda datos de negocio en memoria (`db.ts` solo pool/instancia); la pantalla recarga después del borrado.

### 4. Candados

1. **Solo administrador** (`assertAdmin`, `acl.ts:271-275` — admin exacto, no gerencia). En pantalla la sección solo se dibuja con `role === 'admin'`; en servidor se exige igual (los dos candados, B6).
2. **Candado con salida (B3): `company_settings.live_since`** (fecha; nulo = todavía en pruebas). Lo fija un administrador con "Arrancó la operación real", tecleando el nombre de la empresa y un motivo, con bitácora `arranque-real`. Con `live_since` fijado, el borrado se niega y su mensaje **nombra la salida**: "Regresar a pruebas" en la misma pantalla.
   - **Aclaración:** una empresa cuyo renglón en `company_settings` no existe aún (o no tiene `live_since` capturado) se trata como "en pruebas" y **no tiene obstáculo** para el borrado. La marca de arranque no surge de ausencia, solo de asignación explícita de `live_since` por un administrador. Esa salida es difícil y deja rastro, no imposible: (a) solo administrador; (b) doble confirmación escrita — el nombre de la empresa y la frase `REGRESAR A PRUEBAS` — más motivo obligatorio; (c) bitácora `arranque-real-retirado` con quién, cuándo y motivo; y (d) **el sistema la niega si existe cualquier documento operativo fechado en o después de `live_since`** — factura, cobro, pago, movimiento de banco, gasto, movimiento de kardex, pedido, OC, cotización, solicitud, RFQ u OC del cliente (columnas `date` / `created_at` de cada tabla del grupo A) — o cualquier renglón de bitácora posterior a esa fecha que haya escrito un documento. Ese bloqueo también nombra su salida: "Cancela o revierte esos N documentos primero (bloque de deshacer); si son reales, la operación ya arrancó y no hay regreso." Así: si se prendió un día antes por error y no se capturó nada, se quita con la ceremonia; si se prendió antes de tiempo y se capturaron tres pruebas más, se cancelan/revierten esas tres y luego se quita; si ya hay documentos reales, no se quita — que es exactamente cuando no debe quitarse. Fijar, quitar y borrar toman `for update` sobre `company_settings` y releen `live_since` dentro de su transacción. Límite honesto: las fechas de negocio las captura la persona y se pueden antedatar; por eso el chequeo también mira la bitácora, que tiene reloj propio.
3. **Preview antes de preguntar** (patrón de `cancel-doc.tsx`): tabla por tabla cuántas filas se van, qué se conserva (corte, catálogos, ajustes, personas), los avisos (productos con costo de prueba, socios/productos fuera del catálogo Compaq), y los bloqueos: `live_since` fijado, rol distinto de admin, confirmación distinta del nombre de la empresa.
4. **Confirmación escrita:** el nombre exacto de la empresa, más motivo obligatorio (A5). Sin los dos, el servidor rechaza.
5. **Todo o nada:** una sola transacción; si una llave foránea detiene algo, no queda nada a medias (B3/25).
6. **Rastro:** el borrado y cada intento rechazado quedan en bitácora (el rechazado, fuera de la transacción).
7. **Respaldo honesto:** el "Descargar respaldo" de `/importar` solo exporta cabeceras de facturas, existencias y dos conteos (`cutover.ts:46-75`); la pantalla ya dice que "no sustituye el respaldo de Postgres". En este flujo se llama "foto de cartera y existencias" y se dice explícito que el respaldo real es la rama/punto de restauración de Neon, hecho antes. No se vende como red de seguridad lo que no lo es.
8. **Ninguna tabla se olvida:** una prueba escanea todos los `create table` de `migrations/` **y** de `src/` y exige que cada tabla esté clasificada en la lista SE BORRA / SE CONSERVA. Una tabla nueva sin clasificar pone `npm test` en rojo. Es el segundo párrafo de C4 hecho prueba.

### 5. ¿Hay algo mejor que borrar de verdad?

Se evaluaron tres, ninguna reemplaza al borrado:
- **Probar en otra base (rama de Neon + entorno de preview en Vercel).** Es la más limpia — producción nunca recibe basura — pero es configuración de plataforma con credenciales, y el método de trabajo es que el dueño prueba en el sitio desplegado (`METODOLOGIA` § 3 paso 5). Compatible con este plan más adelante, no lo sustituye hoy.
- **Una empresa de pruebas aparte y borrar la empresa entera** (la cascada desde `companies` hace todo el orden solo). Elegante, pero obliga a duplicar catálogos y ajustes para probar, y no permite probar con el corte real cargado.
- **No borrar: revertir todo con los pasos del bloque de deshacer.** Deja el doble de documentos (original + reversa), no cubre todo (candados sin salida, `DESHACER.md` § 7) y no es limpieza.

**Recomendación:** el borrado real, confinado como se describe en § 4. Es la única excepción al principio, se documenta como tal (igual que A3 documenta la lectura que "no filtra a propósito"), y muere sola el día que arranca la operación real.

---

## Plan de construcción

| Paso | Qué | Toca | Prueba que lo fija |
|---|---|---|---|
| **1** | **Migración `0034_datos_de_prueba.sql`** (aditiva, recortada a lo que el borrado nombra): tabla `notifications` byte-idéntica a `alerts.ts:20-30`; `invoices.opening_paid`, `fx_treatment`, `fx_result`; `stock_moves.unit_cost`; `stock_quants.avg_cost` (mismas definiciones que en runtime); y `company_settings.live_since timestamptz`. Nada más. | Esquema | Aplicar todas las migraciones dos veces en PGlite sin error; las 588 siguen verdes |
| **2** | **`scripts/purge-plan.mjs`** (JS plano, importable por la app y por las pruebas, como `migration-plan.mjs`): **el candado primero** (`purgeGuard`: empresa existente, `for update`, `live_since` nulo, nombre de la empresa de regreso), las listas `KEEP` / `PURGE` con la SQL literal del orden de § 2, la reconstrucción de existencias y costo (promedio del corte donde hay existencia, **0 donde no la hay**; `ref_cost` intacto), el reset de facturas de corte y la re-siembra de `folio_counters` (misma consulta que 0033). | Nuevo | **La central** (`scripts/erp-borrado-pruebas.test.mjs`, PGlite): grafo completo sembrado — catálogos, corte (FV/FP con `cutover_key`, `INI` 'Corte Compaq'), y capturados de todo tipo con reversas, NC/FI/ATC, gasto en efectivo (el ciclo), pronto pago, `doc_files` de los dos tipos, 'Saldo inicial' — se corre el plan y: sobrevive exactamente el corte y los catálogos; `Σ movimientos = existencias`; `products.cost` según fórmula; `folio_counters` = semilla 0033; facturas de corte `open` con `residual = amount − opening_paid` y acumuladores en cero; **idempotente** (segunda corrida: 0 filas); y el caso negativo: una fila de corte con `reverses_id` a una borrada → error y nada a medias |
| **3** | **Prueba "ninguna tabla olvidada"**: escanea `create table if not exists` en `migrations/*.sql` y `src/**/*.ts`; cada tabla está en `KEEP ∪ PURGE`; las sin `company_id` tienen padre en `PURGE` o están en `KEEP`. | Solo prueba | Ella misma |
| **4** | **`src/lib/erp/purge.ts`**: `purgePreview` (lectura: conteos desde el plan, lo conservado, avisos, bloqueos, `allowed`); `purgeTestData` (DDL de runtime fuera de la transacción → `withTx` → `assertAdmin` → `for update` en `company_settings` → releer `live_since` → nombre de empresa + motivo → iterar `PURGE` contando con `with d as (… returning 1) select count(*)` → reconstrucción → `writeAudit` `borrado-de-pruebas`); rechazo con conexión fresca, `borrado-rechazado`; `setLiveSince` (`arranque-real`) y `clearLiveSince` (`arranque-real-retirado`, doble confirmación, bloqueado si hay documentos o bitácora posteriores, con la salida nombrada) en el mismo módulo. | Servidor | Cableado por texto (`fnBody`): usa el plan y no SQL propia; `assertAdmin`; `withTx`; `for update`; relee `live_since`; y **no hay `delete from` de documentos fuera de `purge-plan.mjs`** en todo `src/` |
| **5** | **Pantalla en `/importar`** (Ajustes → Importar / corte): sección "Datos de prueba" solo admin, con preview (se borra / se conserva / avisos), nombre de empresa tecleado, motivo, el texto honesto del respaldo, e interruptor "Arrancó la operación real". Después del borrado, recarga. Etiquetas nuevas en `/bitacora` (`borrado-de-pruebas`, `borrado-rechazado`, `arranque-real`). | Pantalla | Texto: la sección existe, condicionada a admin, llama `purgePreview` antes de `purgeTestData` |
| **6** | **Documentos:** `DECISIONES.md` (la excepción a la 16, confinada, con candado de una vía); `PATRONES-DISENO.md` C4 con la regla "tabla nueva ⇒ entra a `purge-plan.mjs` en el mismo cambio; la prueba lo obliga"; `ESTADO.md` § 4.15 cerrada; `CLAUDE.md` mapa. | Docs | — |

**Dependencias:** 1 ✓ → 2 ✓ → 3 ✓ → 4 ✓ → 5 ✓ → 6 ✓. **Bloque C4 completo.** Los pasos 1-5 construidos y verificados (618/618, `tsc` limpio, y probados en el navegador); el paso 6 (documentación) cierra `ESTADO.md` § 4.15, corrige sus conteos de preguntas abiertas, agrega las Decisiones 57-60 y marca C4 cumplido en `PATRONES-DISENO.md`. Todo lo hecho es aditivo; ninguna prueba existente cambió.

**Decisiones del dueño cerradas para este bloque (15-sep-2026, `DECISIONES.md` 55 y 56):** la bitácora se conserva completa; solo lo operativo se borra; el costo de los productos sin existencia de corte regresa a 0 (el del catálogo) y `ref_cost` no se toca; el preview lista cuántos productos toca. Correcciones del dueño a la primera versión: 0034 solo con lo que el borrado nombra; el candado de arranque con salida (B3), difícil y con rastro, no imposible. La prueba del candado verifica las dos cosas (B3): que bloquea, y que la salida funciona.

## Verificación de punta a punta

1. `npm test`: 588 + las nuevas, ninguna existente cambia; `tsc --noEmit` limpio.
2. En preview local (PGlite): capturar un pedido, entregarlo, cobrarlo, devolver, revertir; cargar un corte pequeño; abrir Ajustes → Importar / corte → "Datos de prueba": el preview enseña los conteos; teclear el nombre de la empresa y un motivo; confirmar. Después: cartera solo con el corte, kardex solo con `INI/`, bitácora con el historial y el renglón nuevo, siguiente pedido `PV-0001`.
3. Fijar "Arrancó la operación real": la sección desaparece; un intento por la API se niega y queda `borrado-rechazado`.
4. En producción, después del deploy: el dueño prueba lo mismo con los PV-0003/PV-0004 de referencia; la guía de prueba se entrega con el bloque.

## Lo que no se verificó
- Contenido real de la base (solo la radiografía del 15-sep: 0 movimientos, 1 empresa).
- Si hay socios/productos capturados a mano fuera del catálogo Compaq (el preview lo dirá).
- Neon en concurrencia real: las pruebas corren en PGlite (una conexión); el `for update` es Postgres estándar.
