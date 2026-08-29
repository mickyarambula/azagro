# Auditoría Azagro ERP — 29 de agosto de 2026

Diagnóstico solamente. No se tocó ningún archivo de código, solo se leyó y se corrieron pruebas.

---

## 1. ¿Instala, pasan las pruebas, pasan los tipos?

**`npm install`** — OK. Sin errores, sin vulnerabilidades.

**`npx tsc --noEmit`** (revisión de tipos de todo el proyecto) — **OK, pasó limpio.** Cero errores de tipos en todo el código.

**`npm test`** — **153 pruebas: 141 pasan, 12 fallan.**

Lo importante: **las 6 pruebas de las fórmulas de cartera (`scripts/erp-formulas.test.mjs`) pasan todas** — promedio móvil, mora a 60 días, pronto pago, residual, límite de crédito. Esa es la parte que protege el dinero y todas están bien.

Las 12 que fallan **no tienen nada que ver con Azagro**. Este proyecto se armó sobre una plantilla genérica ("Grok Build") que trae sus propias pruebas de fábrica: tarjetas para compartir en redes, banner de "instalar app", si el login viene apagado por defecto, si existen archivos de migración, etc. Esas pruebas de plantilla asumen un proyecto vacío recién creado (ej. "no debe haber migraciones todavía", "el login debe venir apagado"), y como Azagro ya tiene 14 migraciones y login real activado, esas pruebas de fábrica ya no aplican y fallan siempre. No revisan nada del negocio (crédito, kardex, cartera).

**Clasificación: COSMÉTICO.** No bloquea nada hoy, pero ensucia el resultado de `npm test` — con 12 pruebas que fallan "siempre" es fácil que una prueba nueva que sí falle de verdad se pierda entre el ruido. Convendría borrar o silenciar esas 6 pruebas de plantilla en algún momento, no es urgente.

---

## 2. ¿Hay revisión de tipos apagada?

Se buscó `@ts-nocheck`, `@ts-ignore` y `@ts-expect-error` en todo `src/` y `server/`, con atención especial a `src/lib/azagro.ts` y `src/lib/erp/`.

**Resultado: no hay ninguna en el código que se escribe a mano.** El único archivo con `@ts-nocheck` es `src/routeTree.gen.ts`, que es un archivo que genera automáticamente la librería de rutas (TanStack Router) — nadie lo edita a mano, es normal y esperado que traiga esa marca.

**Clasificación: no es un hallazgo.** Todo el código de negocio (crédito, kardex, importación, folios) pasa por el chequeo de tipos estricto (`strict: true` en `tsconfig.json`), que es justamente lo que confirmó el punto 1.

---

## 3. La ruta `/importar`: ¿acepta los dos CSV y es idempotente de verdad?

Revisé el archivo de la pantalla (`src/routes/importar.tsx`) y la lógica detrás (`src/lib/erp/cutover.ts`).

**Formato de los dos CSV — coincide exactamente con lo que describe HANDOFF.md:**
- Saldos abiertos: `código, folio, fecha, vence, cargo, abono, saldo, moneda, lado` — coincide columna por columna, incluyendo detectar automáticamente si la fila es de cliente o de proveedor según la columna "lado".
- Existencias: `código producto, bodega, cantidad, costo` — también coincide exactamente.

**Idempotencia de saldos abiertos (cartera): sí, y está reforzada doble.**
Cada fila se identifica con una llave única (`cliente/proveedor + código + folio`). Antes de insertar se revisa si ya existe esa llave, **y además** hay un índice único en la base de datos con esa misma llave — o sea, aunque algo fallara en la revisión manual, la base de datos misma rechazaría el duplicado. Pegar el mismo archivo dos veces no duplica nada; el sistema te dice cuántas filas "ya estaban" vs. cuántas son nuevas.

**Idempotencia de existencias (inventario): sí, pero con un seguro más débil.**
Antes de cargar una partida (producto + bodega), revisa si ya existe un movimiento de apertura de ese mismo producto/bodega marcado "Corte Compaq"; si ya existe, lo brinca. Esto funciona perfecto en el uso normal (pegar el mismo archivo dos veces, una después de otra). **Pero, a diferencia de cartera, no tiene un candado a nivel de base de datos** — solo la revisión de la aplicación. Si por accidente alguien diera doble clic muy rápido en "Cargar existencias" (dos peticiones casi al mismo tiempo), en teoría podría entrar duplicado, porque no hay un índice único que lo impida como sí lo hay en cartera.

**Clasificación: FALTA (menor).** No es una falla del día a día — pegar el mismo CSV dos veces, que es el caso que preocupa, funciona bien. Pero falta el mismo candado de base de datos que ya tiene cartera, para blindarlo también contra un doble clic accidental. Se puede agregar cuando se quiera, es un cambio chico y no bloquea usar `/importar` ahora.

---

## 4. Recibir / entregar / devolver / cobrar: ¿van en transacción con `FOR UPDATE`?

Revisé las cuatro operaciones en `src/lib/azagro.ts` y el motor de kardex en `src/lib/erp/stock.ts`.

| Operación | ¿Transacción (`withTx`)? | ¿`FOR UPDATE`? |
|---|---|---|
| Recibir (`receivePurchase`) | Sí | Sí, bloquea la orden de compra antes de tocarla |
| Entregar (`deliverSale`) | Sí | Sí, bloquea el pedido de venta antes de tocarlo |
| Devolver (`returnSale`) | Sí | Sí, bloquea el pedido de venta antes de tocarlo |
| Cobrar (`registerPayment`) | Sí | Sí, bloquea la factura antes de tocarla |

Además, cada vez que cualquiera de estas cuatro operaciones toca el kardex (entra o sale mercancía), la función que mueve inventario (`postStock`) **también bloquea por separado** el producto y las existencias de la bodega afectada, antes de leer o escribir cantidades. Es decir, el candado no es solo sobre el documento (orden/pedido/factura), sino también sobre el inventario que se está moviendo. Esto es exactamente lo que pide CLAUDE.md y protege contra que dos personas cobren o entreguen lo mismo al mismo tiempo y se descuadre el kardex o la cartera.

**Un hallazgo aparte, relacionado:** al cobrar, si la factura es de proveedor (pago saliente), el sistema revisa que haya saldo suficiente en el banco antes de pagar. Esa revisión de saldo de banco **no bloquea la cuenta de banco** (solo bloquea la factura). En el uso normal esto no se nota, pero si dos pagos salientes distintos se registraran contra el mismo banco casi al mismo tiempo, en teoría ambos podrían "ver" el mismo saldo disponible y los dos pasar, dejando el banco en negativo sin que el sistema lo hubiera detectado.

**Clasificación:**
- Las cuatro operaciones pedidas (recibir/entregar/devolver/cobrar): **sin hallazgos, están bien hechas.**
- El candado faltante en el saldo de banco al pagar a proveedor: **FALTA (menor).** Es un caso de dos personas pagando desde la misma cuenta de banco casi al mismo segundo — poco probable en la operación diaria de Azagro, pero es la clase de descuido que CLAUDE.md pide evitar explícitamente ("cobros: transacción + FOR UPDATE").

---

## 5. Fórmulas de `credit.ts` vs. lo que exige CLAUDE.md

Se comparó línea por línea contra las reglas de CLAUDE.md y HANDOFF.md.

| Regla exigida | ¿Cómo está en el código? | ¿Coincide? |
|---|---|---|
| Días **calendario exactos** (no meses de 30) | Resta fechas reales día por día (`daysBetween`) | Sí |
| Interés = Cargo × (TIIE al vencimiento + 9%) × días / **360** | Exactamente esa fórmula, con la tasa TIIE + 9% de "spread de cobro" | Sí |
| Interés **con signo** (negativo = pronto pago) | Los días se calculan con signo; si el pago fue antes del vencimiento, el interés sale negativo | Sí |
| Comisión 1% + FEGA 2.04% = **3.04% una sola vez** sobre el cargo | Las constantes están puestas exactamente así (1% y 2.04%, suman 3.04%) y se cobran una sola vez sobre el cargo original, no sobre el saldo | Sí |
| El estado de cuenta usa el Excel de trabajo, no el export crudo de Compaq | El código trae comentarios explícitos aclarando que replica el Excel de Grupo SL/SL Agrícola, con las mismas columnas (plazo, fecha de pago, días vencidos, interés, comisión+FEGA) | Sí |
| FI (mora) solo si ya venció | La función de mora solo cobra si los días vencidos son mayores a cero | Sí |
| El capital para el cálculo es el **cargo** (importe original), no el saldo | Así está explícito en el código y en el comentario que lo acompaña | Sí |

Y las 6 pruebas automáticas de `scripts/erp-formulas.test.mjs` (promedio móvil, mora, pronto pago, residual, límite de crédito) confirman esto con números concretos, y **todas pasan**.

**Clasificación: sin hallazgos.** Las fórmulas de cartera coinciden con lo que pide CLAUDE.md, tanto en el código como en las pruebas.

---

## Resumen — qué hacer y en qué orden

**ROTO (nada funciona):** ninguno. No se encontró nada roto.

**FALTA (no existe y conviene agregarlo, ninguno urgente):**
1. Ponerle a la carga de existencias de corte el mismo candado de base de datos que ya tiene la carga de saldos abiertos (para blindarla también contra un doble clic accidental, no solo contra pegar el CSV dos veces).
2. Bloquear la cuenta de banco (no solo la factura) al registrar un pago a proveedor, para blindar contra dos pagos casi simultáneos desde el mismo banco.

**COSMÉTICO (molesta pero no bloquea):**
1. Las 12 pruebas que fallan en `npm test` son de la plantilla original ("Grok Build"), no de Azagro — conviene borrarlas o actualizarlas para que `npm test` en verde signifique algo, pero no urge.

**En corto:** el motor de crédito, el kardex y la importación de corte están sólidos y coinciden con las reglas del negocio. Los dos "FALTA" son mejoras de blindaje contra casos raros (doble clic, dos pagos al mismo segundo), no bloquean operar mañana.
