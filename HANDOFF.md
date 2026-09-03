# Handoff Azagro — 1 de septiembre de 2026

Documento para quien continúa (Claude Code, Claude.ai, u otro). El ERP se
construyó primero en Grok Build; desde finales de agosto vive en este repo de
GitHub y todo el trabajo posterior se hizo aquí, con Claude Code.

## Qué es

Azagro vende agroquímicos/fertilizantes a productores (crédito agrícola
largo). Hoy operan Compaq + Excel para cartera. Este sistema es el
**circuito operativo + cartera**, no un Compaq 2 ni una contabilidad — Compaq
sigue timbrando.

Empresa: AZ Insumos Agrícolas SA de CV. Grupos de clientes: Grupo SL,
Fertisem, Santa Rosa, Varios. Reportes Compaq de referencia: A. Premier,
SL Agrícola, Grupo SL.

Dueño del producto: Miguel Arambula (`mickyarambula`). Habla en español,
quiere que se implemente sin preguntar de más, "aplica en todo el sistema".

## Circuito que ya corre

```
Solicitud (SOL) → RFQ/SC a proveedores → Cotización (COT) → Pedido venta (PV)
  → OC al ganador (o Pedido de compra / RFQ sin cliente para inventariar)
  → Recibir (solo inventario; brokeraje va en camino al cliente)
  → Entregar → FV → cobro/pago → estado de cuenta (TIIE, FEGA, días exactos)
```

También: devolución cliente (NC + kardex reverse), expediente clickeable por
folio, destinos de entrega, auto-vínculo partner↔producto al comprar/vender,
límite de crédito (con autorización de administrador si se excede), usuarios
con roles y permisos por módulo, y bitácora con filtros.

**Un pedido confirmado ya no es de barro**: cliente y moneda quedan fijos
después de confirmar (evita romper la cadena con la cotización y el tipo de
cambio pactado). Precio, cantidades y fechas se siguen pudiendo corregir,
pero cada cambio queda en bitácora con el valor anterior y el nuevo.

## Qué se hizo esta semana (28 ago – 1 sep), en orden

1. **Migración a Neon con `DATABASE_URL`.** El sistema ya no corre sobre
   PGLite embebido: en producción usa Postgres real (Neon). Sin
   `DATABASE_URL` sigue cayendo a PGLite para preview local — eso no cambió,
   pero ahora la base real está conectada y es la que manda.
2. **Arreglo del login.** Se quitó el broker de autenticación que traía Grok
   Build (incluía inicio de sesión con X/Twitter) y se puso Google OAuth
   propio de Azagro.
3. **Auditoría de código** (`AUDITORIA.md`): revisión de instalación, tipos,
   el importador de corte, las transacciones de kardex/cartera con
   `FOR UPDATE`, y las fórmulas de `credit.ts` contra las reglas del negocio.
   Sin hallazgos graves; dos candados de concurrencia menores señalados
   (doble clic en importar existencias, dos pagos simultáneos al mismo
   banco) y limpieza de pruebas de plantilla que no aplicaban a Azagro.
4. **Auditoría de seguridad y permisos** (`SEGURIDAD.md`) — y sus
   correcciones: muchas operaciones de dinero (cobrar, pagar, recibir,
   entregar, crear OC, facturar mora) solo revisaban que el usuario fuera
   "de la empresa", sin mirar su rol ni si estaba activo. Se conectó la
   validación de rol y estado activo en todo el sistema, se cerró la puerta
   trasera del código de equipo (ya no da acceso directo, deja solicitud
   pendiente), se separó qué ve cada rol (almacén sin precios/cartera,
   ventas sin costos, contabilidad sin kardex, costos y márgenes solo
   administración), y se agregaron los candados de "nadie edita su propio
   rol" y "la empresa no se queda sin administrador".
5. **Auditoría de lógica de negocio** (`LOGICA.md`): se siguieron a mano
   escenarios de devoluciones, cobros, cancelaciones, kardex y cartera.
   Salieron errores reales (el más grave: un abono de una factura importada
   de Compaq se borraba al registrar un pago nuevo) y varias preguntas de
   negocio abiertas sobre cómo debía calcularse el interés.
6. **Cruce contra el Excel real** (`EXCEL_VS_SISTEMA.md`): se compararon los
   dos Excel con los que Azagro opera de verdad (utilidad y ventas a SL
   Agrícola) contra el sistema, fórmula por fórmula. Esto resolvió las
   preguntas abiertas de `LOGICA.md` y reveló que el sistema no calculaba el
   costo financiero propio de Azagro (el circuito con la empresa hermana).
7. **Bloque 1 de corrección financiera**: la mora empieza a correr el día
   150 (no el 120), el interés se calcula siempre sobre el cargo original de
   la factura, el interés y el FEGA se acumulan por separado (antes la
   segunda factura de mora cobraba de menos), y cobrar desde Bancos o desde
   Cartera ahora pasa por el mismo camino con el mismo resultado. Se corrigió
   también el abono de facturas importadas de Compaq.
8. **Bloque 2**: se agregó el costo financiero propio de Azagro (comisión +
   Capa 1 + Capa 2, como en el Excel) y una utilidad real por operación que
   los resta. La bonificación por pronto pago pasó de ser solo informativa a
   aplicarse de verdad como descuento al cobrar.
9. **Bloque 3**: el tipo de cambio del día del pago ahora se captura y genera
   ajuste (por cobrar o por devolver) contra el tipo de cambio pactado; se
   agregaron las cuatro visiones de utilidad (devengada, realizada, en caja,
   proporcional), la vista de saldos por vencer por mes, y el panorama
   consolidado por razón social / grupo.
10. **Auditoría de trazabilidad** (`TRAZABILIDAD.md`) — y dos rondas de
    corrección: editar un pedido ya confirmado ahora deja rastro completo
    (antes no dejaba ninguno); cada factura de mora guarda su cálculo
    completo (TIIE, días, tasa, capital) en vez de solo el resultado; la
    bitácora tiene filtros por folio, usuario, fecha y tipo; se agregó
    registro de lo que NO pasó (intentos sin permiso, rechazos por límite de
    crédito, importaciones fallidas); folios con candado de unicidad;
    recordatorios de cobro registrados; y el estado de cuenta a una fecha
    pasada ahora reconstruye el estado real de ese día en vez de mezclar
    saldos de hoy con intereses de ayer.
11. **Corrección de fondo del costo financiero en el precio**: el sistema
    tenía el cálculo al revés — cotizaba un precio sin financiamiento y
    luego le restaba el costo financiero a la utilidad, como si Azagro lo
    absorbiera. Se corrigió para que el financiamiento se cobre al cliente
    **dentro del precio** (ver decisión de negocio abajo). Antes de este
    arreglo, una operación con 8% de margen elegido terminaba mostrando
    ~1-2% de utilidad; ahora queda cerca del margen elegido.
12. Un par de arreglos de interfaz sueltos: el filtro de fechas de la
    Bitácora tronaba, la columna de cantidad en Solicitudes no se veía
    alineada con su campo, y la renegociación de precios en Cotizaciones no
    dejaba claro cuándo se guardaba una revisión nueva (ahora muestra la
    revisión actual, un aviso de cambios sin guardar, y un botón explícito).
13. Fecha de operación en hora de Los Mochis. Antes el servidor decidía
    "hoy" en UTC (`new Date().toISOString()`) o dejaba que Postgres lo
    pusiera con `current_date` (también UTC en Neon): desde las 5:00 p.m. las
    facturas, vencimientos por plazo, pagos de devolución, movimientos de
    kardex y cortes por omisión quedaban fechados al día siguiente. Ahora hay
    UNA función, `todayMx()` en `src/lib/utils.ts`, que es el único lugar que
    decide qué día es (America/Mazatlan, UTC-7 sin horario de verano), y
    todos los inserts a tablas con `date` la mandan explícita. Los sellos de
    auditoría (`created_at`, bitácora) siguen en UTC y solo se convierten al
    mostrar con `dateTimeMx()`.
14. **Dos precios por partida, solicitud bloqueada y plazo heredado**
    (2-sep, migración `0017_dos_precios.sql`, lógica en
    `src/lib/erp/margins.ts` y `request-lock.ts`, pruebas en
    `scripts/erp-dos-precios.test.mjs`):
    - Cada partida lleva **dos márgenes independientes**: contado y crédito,
      cada uno % o $ fijo (`margin_cash_*` / `margin_credit_*` en
      `customer_request_lines` y `quote_lines`). Precio contado = costo
      puesto + margen contado, sin financiamiento ni comisión. Precio crédito
      = costo puesto + margen crédito + financiamiento (fórmula intacta).
    - **Captura inversa** en la cotización (`/quotes`, panel "Ver"): se
      escribe el precio, la utilidad o el margen % de cualquiera de las dos
      columnas y lo demás se despeja; al guardar la revisión, el margen
      guardado de la partida se recalcula (`marginFromPrice`). Utilidad
      negativa: aviso en rojo, no candado.
    - La cotización guarda **cuál precio aceptó el cliente**
      (`quotes.accepted_offer`, copiado a `sales_orders.accepted_offer`); el
      pedido lee costo/margen/financiamiento de `quote_lines` por
      `quote_id + product_id` (no hay columnas nuevas en `sales_lines`).
    - Bitácora: "margen contado" / "margen crédito" por separado, anterior →
      nuevo, al salir del campo (`onCommit`), nunca por tecla.
    - **La solicitud que ya generó cotización se bloquea**
      (`assertRequestOpen` en todas las escrituras de `requests.ts`,
      `assertRfqOpen` en las ofertas del RFQ). La pantalla muestra
      "Generó COT-… → PV-…" con ligas (`/quotes?ver=<id>`); los cambios se
      hacen desde la cotización (revisión).
    - Bug corregido: los **días de crédito, moneda y TC de la solicitud**
      vivían solo en memoria del navegador (`useState` sin columna) y se
      perdían al salir. Ahora se guardan al salir del campo
      (`saveRequestTerms`, bitácora `plazo-solicitud`) en
      `customer_requests.credit_days/currency/fx_rate`. Era el único dato de
      la pantalla con ese patrón; márgenes, ofertas y flete ya persistían.
    - **El pedido hereda el plazo de la cotización** y lo muestra como dato
      heredado con origen; los campos de días quedan apagados. Cambiarlo es
      una acción explícita ("Cambiar plazo") que avisa que el precio ya no
      corresponde, rehace precio por partida (costo + margen crédito +
      financiamiento a los días nuevos con la TIIE/spread de la COT; a 0
      días vuelve al precio de contado), recalcula vencimientos y deja
      bitácora `cambiar-plazo-pedido`. Solo en borrador.
    - Valores por omisión del pedido al aceptar: días factura = "plazo
      factura" de Ajustes sin pasar del plazo de la COT, plazo financiero =
      días de la COT, política de mora = GRUPO_SL si el cliente es del grupo,
      si no ESTANDAR; de contado NONE.

15. **Márgenes migrados, muerte del 12% por omisión y "agregar partida"**
    (2-sep, migración `0018_margen_migrado.sql`):
    - **Los márgenes que ya existían se copiaron** a las dos columnas nuevas
      (contado y crédito) y quedaron marcados `margin_*_source = 'migracion'`,
      para distinguirlos de uno capturado a mano (`'captura'`). La pantalla lo
      dice con un asterisco y la nota "de la migración". En las cotizaciones
      solo se copió donde había un margen mayor que cero: la columna vieja era
      `default 0` y copiar ese 0 sería afirmar "esta venta no dejó utilidad",
      que no es lo mismo que "no sabemos cuál fue".
    - **Ya no existe el margen por omisión de 12%.** Se fue de la base (la
      columna vieja perdió su `default 12` y su NOT NULL), de las consultas
      (`coalesce(margin_pct, 12)`) y del código (`marginOf` devolvía 12% cuando
      no había nada). Ahora una partida sin margen **dice "Sin margen"**: el
      campo va vacío con borde ámbar, el precio queda en "—", el botón de
      cotizar se apaga y el servidor rechaza con "Captura el margen antes de
      cotizar: …". Pasar por el campo sin escribir nada tampoco lo convierte
      en 0%. Al cambiar el plazo de un pedido, una partida sin margen conserva
      su precio y la bitácora dice "sin margen: precio sin recalcular" — no se
      inventa un margen para poder recalcular. Un 0% capturado a propósito
      (vender al costo) sí es un margen y se respeta.
    - **"Agregar partida", tres comportamientos** (punto C3):
      1. *Pedido en borrador que vino de cotización*: el botón dice "Agregar
         partida en COT-…" y lleva a la cotización. Ahí se agrega el producto,
         se le captura el precio, y al guardar la revisión pasa por costo
         (kardex → referencia), margen (despejado del precio) y financiamiento.
         El pedido se actualiza solo: entra la partida nueva, los precios de
         las que ya tenía se ponen al día, se rehace el total y queda en
         bitácora (`actualizar-pedido-por-revision`). La cantidad de una
         partida que el cliente aceptó parcial no se toca, y una partida que
         quedó fuera de esa aceptación no se revive.
      2. *Pedido confirmado*: no se agregan partidas — mensaje "levanta un
         pedido nuevo", y el servidor tampoco deja revisar esa cotización.
      3. *Pedido capturado directo (sin cotización)*: igual que siempre.

16. **Sin valores por omisión de negocio** (3-sep, migración
    `0019_sin_valores_por_omision.sql`, prueba `scripts/erp-sin-numeros.test.mjs`).
    REGLA ÚNICA del dueño: *todo número de negocio se lee de Ajustes o de su
    tabla; si no está, el sistema se detiene y avisa; nunca inventa un número.*
    - **Márgenes**: las partidas que la 0018 dejó en 12% con origen
      `migracion` (la firma exacta del `default 12` viejo: modo %, 12 exacto,
      sin nominal) pasan a "sin margen". Un 12% capturado a mano (origen
      `captura`), o con nominal, se queda.
    - **Tipo de cambio**: ya no existe el 18. Pedido, cotización y solicitud
      proponen el renglón más reciente de la tabla `fx_rates` y dicen de qué
      fecha es ("TC tabla 18.60 (2026-09-01)"). Tabla vacía y nada capturado =
      el servidor no guarda un documento en dólares (`orders.ts`, `createQuote`,
      `cpo.ts` al convertir una OC en USD). En la solicitud el TC pactado manda
      sobre la propuesta de la tabla.
    - **TIIE**: siempre el renglón de `tiie_rates` con fecha igual o anterior
      a la fecha que toque (`nearestRate(tabla, fecha)` → renglón o `null`;
      `requireRate` truena con "No hay TIIE en la tabla con fecha igual o
      anterior al …"). La pantalla muestra cuál usó y de qué fecha: "TIIE 6.90%
      (tabla, 01/09/2026)". Se fueron el 7.06 del código y la "TIIE por
      omisión" de Ajustes (columna `default_tiie`). Sin renglón: no se cotiza a
      crédito, no se emite factura de interés, el estado de cuenta marca "sin
      TIIE" en esa fila y los reportes dicen "sin TIIE" en vez de estimar.
      `createQuote` toma la TIIE de la tabla en el servidor y rechaza si la
      pantalla mandó otra ("La TIIE de la tabla cambió desde que abriste la
      pantalla").
    - **Ajustes obligatorio**: `company_settings` perdió todos los defaults
      y NOT NULL de negocio (plazo factura, plazo crédito, umbral de pronto
      pago `early_pay_days`, comisión + FEGA `fega_rate`, comisión sola
      `fega_commission`, spread de mora, comisión ASR, spread ASR). Si falta
      un renglón, `policy()` truena con "Ajustes incompletos: falta …" en
      servidor, y la pantalla lo muestra en Ajustes, Cotizaciones, Solicitud,
      Cartera y Estado de cuenta en lugar de operar con números del código.
      `DEFAULT_POLICY` ya no existe. **Una base que ya existía tiene que
      capturar `fega_commission` y `early_pay_days` en Ajustes** antes de
      volver a cotizar/cobrar (la pantalla lo pide).
    - **Plazos**: 90/30 del código se fueron; salen de Ajustes (plazo factura
      / plazo crédito). `partners.payment_days` perdió su `default 30` (sigue
      obligatorio: quien da de alta captura el plazo, 0 = contado; convertir
      una OC de cliente sin plazo se detiene).
    - **Reportes**: una partida sin costo se etiqueta "sin costo", queda
      **fuera** del cálculo de utilidad (antes entraba como 100% de ganancia)
      y se cuenta aparte con su motivo (Panorama, por razón, por pedido y el
      P&L del pedido).
    - **Extras del barrido**: la mora "16.06%" fija en el alta de socio y en
      la importación Compaq (ahora `late_rate` es informativa y vale 0); el
      "+ 9%" fijo en estado de cuenta, solicitud y ayuda; las etiquetas de
      política de cobro (`CREDIT_POLICY_CATALOG`) ya no llevan "9% / 1% /
      2.04%" (solo son un nombre; `credit_policies.spread/fega_rate` no las
      lee nadie); la comisión ASR editable de la solicitud (el servidor la
      ignoraba) pasó a solo lectura desde Ajustes; CPO→PV grababa TC 1 y plazo
      0/0 fijos.
    - **Prueba de barrido**: `erp-sin-numeros.test.mjs` recorre `src/` (sin
      comentarios, exenta solo `catalog.ts` como semilla de tabla) y falla ante
      `useState(18)`, `?? 18`, `0.0706`, `16.06`, `?? 0.09`, `spread: 0.04`,
      `0.0304`, `?? 90`, `default 30`, `default 12`, `DEFAULT_POLICY`,
      `default_tiie`, `nearestRate` con tercer argumento, etc. También vigila
      que las semillas de `catalog.ts` solo las importe el sembrado.
    - Lo que sí queda en código y **no** es configuración: 360 días del año
      (fórmula), las semillas de `TIIE_SEED` (van a la tabla), los placeholders
      "p. ej. 18.60" de los inputs, y `reports.ts` "× 30 / 360" como unidad
      del reporte mensual.

Todo lo anterior quedó con pruebas automáticas (`npm test`, casi 290 hoy,
incluidas las migraciones aplicadas de cero sobre un Postgres real) y pasa
`npx tsc --noEmit` limpio.

## Decisiones de negocio confirmadas por el dueño

- **Tasa de cobro al cliente: TIIE + 9%.** No el 18% fijo que traía una
  versión vieja del Excel.
- **El interés se calcula sobre el cargo original, no sobre el saldo.**
  Aunque haya abonos parciales. Razón: el costo con la empresa hermana corre
  sobre la operación completa, no sobre lo que quede pendiente.
- **La mora empieza a correr el día 150**, contado desde la fecha de la
  factura. El día 120 es solo el vencimiento que se le muestra al cliente
  (para gestión de cobranza); son dos fechas distintas y el sistema las
  maneja separadas (`due_date` = 120, `credit_due` = 150).
- **Bonificación por pronto pago**: solo aplica si el cliente paga antes del
  día 120, y bonifica los días entre el pago y el día 150, a la tasa de
  **costo** (TIIE del mes de emisión + spread de costo), no a la de cobro.
- **El tipo de cambio pactado manda.** Si el cliente paga a un tipo de
  cambio distinto, el cliente asume el riesgo cambiario: la diferencia se
  ajusta contra él (documento "por cobrar" o "por devolver"), o se puede
  dejar como utilidad/pérdida del día — se decide pago por pago.
- **El costo financiero se le cobra al cliente dentro del precio, no lo
  absorbe Azagro.** Al cotizar: costo de mercancía, más el margen que elige
  el usuario, más el financiamiento (comisión + Capa 1) encima, calculado
  con los días de crédito de ESE pedido — no un plazo fijo.
- **Después de confirmar un pedido, cliente y moneda quedan fijos.** Precios
  y fechas se siguen pudiendo corregir, siempre con rastro en bitácora.
- **Todo parametrizable desde Ajustes, nada quemado en el código**: tasa de
  cobro (TIIE + spread), spread de costo, comisión, FEGA, días de
  vencimiento visible (120), días de plazo financiero (150), y el umbral de
  pronto pago (120). Cambiarlos exige ser administrador y queda en bitácora
  con el valor anterior y el nuevo.

## El circuito con la empresa hermana (ASR)

Azagro no financia solo: cuando vende a crédito, el capital de esa operación
lo pone una empresa hermana (ASR / Santa Rosa), a través de un circuito de
facturación: Azagro le factura a la hermana (costo + 1% de comisión), la
hermana adelanta el dinero, y luego le refactura a Azagro el costo más el
interés del plazo (TIIE del mes + 4% de spread).

Para el sistema, hoy ese circuito se resume matemáticamente en dos números:
**comisión 1% y spread de costo 4%** — son los parámetros que alimentan el
costo financiero que se le cobra al cliente dentro del precio (ver arriba).

**No se construyó el circuito documental** (las facturas de ida y vuelta
entre Azagro y la hermana, con sus propias cuentas por cobrar/pagar). El
dueño está por cambiar ese esquema, así que no tenía caso construir algo que
va a cambiar pronto. Si se decide mantenerlo, es el siguiente candidato
natural de trabajo grande.

## Qué falta

- **Valores por omisión**: cerrados el 3-sep (punto 16 de la bitácora de
  arriba). No volver a escribir un número de negocio en el código: lo vigila
  `scripts/erp-sin-numeros.test.mjs`. Pendiente operativo, no de código: en
  una base que ya existía hay que capturar `fega_commission` y
  `early_pay_days` en Ajustes (la pantalla lo pide y todo se detiene hasta
  entonces).
- Columnas sin uso que quedaron por no romper nada: `credit_policies.spread`
  y `fega_rate` (nadie las lee; la mora sale de Ajustes) y
  `customer_pos.fx_rate default 1` (nadie la lee; la OC convertida toma el TC
  de la tabla). Quitarlas cuando toque una limpieza de esquema.
- **Sesión D pendiente**: un barrido de uso real, simplificación de
  pantallas y detección de huecos operativos — no se ha hecho todavía.
- **INCOMPLETOS de `LOGICA.md` sin tocar**: no hay forma de revertir un pago
  capturado por error; no hay cancelaciones (de pedido entregado, de OC
  recibida, de factura cobrada); no existe devolución a proveedor ni nota de
  crédito de proveedor; las recepciones y entregas son siempre completas (no
  hay recepción ni entrega parcial). Todo esto sigue como estaba, señalado
  pero no corregido.
- **Lotes y caducidad**: no existen en el kardex.
- **Unidades de medida (UOM)**: no hay factores de conversión entre unidades
  (kg↔tambo↔litro); cada producto tiene una sola unidad.
- **Flete prorrateado entre productos de un mismo viaje**: hoy el flete se
  captura por partida de cotización, no se reparte automáticamente entre
  varios productos que viajan juntos.
- **El corte con números reales de Compaq**: los catálogos (clientes,
  proveedores, productos, almacenes) ya están cargados, pero los saldos
  abiertos y existencias reales del día de corte todavía no se han pegado.
  El importador existe y es idempotente; falta que Azagro entregue los CSV.

## Los dos hallazgos menores que quedan abiertos de `TRAZABILIDAD.md`

- **La tabla de TIIE se puede sobreescribir** (capturar de nuevo la tasa de
  una fecha reemplaza la anterior). Mitigado: cada factura de mora ya guarda
  su propia TIIE usada en el momento, así que sobreescribir la tabla después
  no cambia lo ya facturado — pero la tabla en sí no lleva historial de sus
  propios cambios.
- **Los movimientos de banco sueltos** (ajustes, transferencias sin ligar a
  factura) llevan autor y fecha en su propia fila, pero no aparecen en la
  vista de Bitácora junto con el resto de los movimientos — quedan
  repartidos en dos pantallas.

## Fórmulas vigentes (confirmadas, no negociables sin decisión del dueño)

- Días **calendario exactos**, no meses de 30.
- Interés de mora = Cargo original × (TIIE al plazo financiero, renglón de
  la tabla + spread de mora de Ajustes; hoy 9%) × días vencidos desde el
  plazo financiero (Ajustes; hoy 150) / **360**. Con signo en el estado de
  cuenta: negativo = pronto pago.
- Comisión + FEGA (Ajustes; hoy 1% + 2.04% = **3.04%**) una sola vez sobre
  el cargo, cuando ya venció.
- Precio al cliente = costo de mercancía + margen elegido + financiamiento
  por unidad: costo × comisión ASR 1% (una sola vez, no depende de los días)
  + costo × **1.01** × (TIIE vigente al cotizar + spread ASR 4%) × días de
  crédito del pedido / 360. El 1.01 es la columna AN del Excel operativo
  (hoja DIF_TC_SL_AGRICOLA: `AN = AL*(1+0.01)*W/360*150`): la línea adelanta
  costo + comisión, así que la comisión se cobra una vez **y además** genera
  interés; la utilidad resta la comisión aparte (columna AO). **No quitarlo**
  — se quitó por error el 1-sep-2026 y se regresó el 2-sep con el Excel a la
  vista. Al contado (0 días) el financiamiento es $0, comisión incluida.
  Ejemplo: costo $10,000, TIIE 6.9%, 150 días → $100 + $458.71 = $558.71. Ya
  no existe el "spread de línea 4.5%": era un legado del primer commit sin
  comisión. Pruebas en `scripts/erp-financiamiento-precio.test.mjs`.
- El financiamiento lo calcula el **servidor** con el costo real, para
  cualquier rol: el precio no depende de quién cotiza. A Ventas se le
  esconden costo y flete, no el cálculo.
- **Costo del producto, orden único** (`src/lib/erp/cost.ts`, migración 0016):
  1) promedio móvil del kardex si es > 0; 2) si no, costo de referencia
  (`products.ref_cost`, solo administrador lo ve y lo captura, con bitácora);
  3) si no, el producto no tiene costo y el servidor **no deja guardar una
  cotización a crédito** con esa partida (de contado sí: no hay nada que
  financiar). El costo de referencia existe para brokeraje/directo, que por
  regla nunca entra a bodega y por lo tanto nunca genera promedio móvil.
  La ruta de solicitud con RFQ no usa nada de esto: ahí el costo es el
  precio del proveedor ganador.
- Capa 2 (costo financiero de los días que el cliente se pasa del plazo) sí
  se resta de la utilidad — ese no estaba previsto en el precio.
- Kardex: promedio móvil, `stock_moves` inmutable, `stock_quants` proyección.

## Inventario (lección ERPNext que sí se copió)

Kardex inmutable (`stock_moves`) + valuación promedio móvil. Quants son
proyección. Recibir/entregar/devolver/ajustar/trasladar van en transacción
con `FOR UPDATE`. **No se tocó en ninguna de las sesiones de esta semana** —
sigue exactamente como estaba.

No se copió aún: lotes con caducidad, factores UOM, Pricing Rule.

## Corte (para operar de verdad)

Catálogos Compaq **sí** se cargan (Ajustes → Importar / corte): clientes
CL0001–CL0034, proveedores PV001–PV017, productos, almacenes 001–016/999,
RFC, límite.

**No** se han pegado los importes reales 2024–2026. El importador de
**saldos abiertos** y **existencias** existe, es idempotente
(`cutover_key` / origen `Corte Compaq`), y desde esta semana también
respeta el abono previo de cada factura y tiene candado de unicidad. Falta
que Azagro pegue el CSV del día de corte:

```
código, folio, fecha, vence, cargo, abono, saldo, moneda, lado
CL0001,A-292,2025-11-01,2026-04-01,150000,20000,130000,MXN,cliente
```

```
código producto, bodega, cantidad, costo
ALB-10,001,25,18.5
```

Bancos: saldo inicial en Bancos. TIIE y dólar en Ajustes.

No importar facturas en ceros ni hojas de utilidad.

## Técnico

- `withTx()` funciona igual sobre Neon y PGLite; producción usa Neon con
  `DATABASE_URL` configurado.
- Fechas: fecha de negocio = `todayMx()` (`src/lib/utils.ts`), nunca
  `new Date().toISOString().slice(0,10)` ni `current_date` en SQL (hay
  pruebas que lo vigilan en `scripts/erp-fecha-operacion.test.mjs`). Sello
  de tiempo = `timestamptz default now()` en UTC, mostrado con
  `dateTimeMx()`.
- Bitácora `/bitacora`, ahora con filtros por folio/texto, tipo, usuario y
  fecha.
- Archivos en el folio (CFDI/guía). Respaldo JSON.
- Migraciones hasta `migrations/0015_folios_unicos.sql`.
- Pruebas: `npm test` corre más de 200 casos en varios archivos
  `scripts/erp-*.test.mjs` (fórmulas, permisos, cartera, utilidad,
  trazabilidad, precio). Todas deben pasar en verde, junto con
  `npx tsc --noEmit` limpio, antes de dar por hecho cualquier cambio.
- Documentos de auditoría en la raíz del repo, todos vigentes:
  `AUDITORIA.md`, `SEGURIDAD.md`, `LOGICA.md`, `EXCEL_VS_SISTEMA.md`,
  `TRAZABILIDAD.md`. Léelos antes de tocar cartera, permisos o kardex — cada
  uno explica el porqué de una decisión que ya se tomó.

Sin `DATABASE_URL` el preview local sigue cayendo a PGLite y se pierde al
reiniciar — eso no es la empresa real.

## Qué no hacer

- Reescribir en ERPNext/Odoo.
- Meter CFDI/PAC, contabilidad de pólizas, nómina, lotes — hasta que el
  corte cuadre.
- Duplicar cartera histórica.
- Tocar el kardex o las fórmulas de cartera/precio sin que el dueño lo pida
  explícitamente — son las piezas más auditadas y más caras de romper.
- Construir el circuito documental con la empresa hermana (ASR) sin
  confirmar antes con el dueño: está por cambiar ese esquema.
- Preguntar puertos/paths al usuario: él no tiene terminal; si estás en
  Claude Code, sí tienes repo.

## Cómo dárselo a Claude

1. **Claude Code (recomendado):** `claude` en el clone de este repo. Lee
   `CLAUDE.md` primero; si vas a tocar cartera, permisos o kardex, lee
   también el documento de auditoría correspondiente de la lista de arriba.
2. **claude.ai proyecto:** pega `CLAUDE.md` + `HANDOFF.md` en las
   instrucciones del proyecto y sube el zip del repo (sin `node_modules`).
3. **Chat suelto:** primer mensaje = contenido de `HANDOFF.md` + "el código
   está en github.com/mickyarambula/azagro".

Compaq Excel originales y pantallas **no** van en el repo (datos de
clientes). Siguen en el workspace Grok / Escritorio si se necesitan de
referencia.
