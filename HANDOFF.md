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

Todo lo anterior quedó con pruebas automáticas (`npm test`, más de 200 hoy)
y pasa `npx tsc --noEmit` limpio.

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
- Interés de mora = Cargo original × (TIIE al plazo financiero + 9%) ×
  días vencidos desde el día 150 / **360**. Con signo en el estado de
  cuenta: negativo = pronto pago.
- Comisión 1% + FEGA 2.04% = **3.04%** una sola vez sobre el cargo, cuando
  ya venció.
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
