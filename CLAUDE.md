# Azagro ERP — instrucciones para Claude

ERP operativo de **AZ Insumos Agrícolas (Azagro)**, Los Mochis. Reemplaza Compaq + Excel de cartera (Grupo SL / A. Premier / SL Agrícola), no el timbrado SAT.

Lee `HANDOFF.md` entero antes de tocar código. Producto en **español**. No preguntes de más: si el usuario dice “adelante”, implementa.

## Stack

- TanStack Start (file routes en `src/routes/`) + React + Tailwind
- Postgres: Neon si hay `DATABASE_URL`, si no PGLite embebido (`src/lib/db.ts`)
- better-auth
- Server functions: `createServerFn` + `authMiddleware`
- Schema: `migrations/*.sql` (0014 = bitácora, archivos, corte idempotente; 0016 = `products.ref_cost`; 0017 = dos márgenes/precios por partida, `accepted_offer`, plazo de la solicitud; 0018 = copia marcada del margen viejo y muerte del 12% por omisión; 0019 = sin valores por omisión de negocio: `company_settings` sin defaults ni NOT NULL, `fega_commission`, `early_pay_days`, sin `default_tiie`, `partners.payment_days` sin default, el 12% de migración pasa a "sin margen"; 0020 = escalera de plazos `company_settings.quote_terms`, sembrada 0/30/60/90/120/150; 0021 = `credit_policies.charge_commission` / `charge_fega`, nacen sin capturar y no se tocan las políticas que ya existían; 0022 = la decisión del dueño capturada: GRUPO_SL sí/sí, ESTANDAR no/no, NONE no/no, sin pisar lo que ya se contestó a mano)

## No romper

1. **Crédito Azagro** (`src/lib/erp/credit.ts`, `rules.ts`): días calendario exactos; interés **días/360**; TIIE + spread 9%; comisión 1% + FEGA 2.04% = 3.04% una vez. **Nada de eso nace antes del vencimiento**: con días vencidos ≤ 0 no hay interés, ni comisión, ni FEGA (nunca un interés negativo "a favor"). Lo que se le regresa al cliente por pagar antes es la bonificación de pronto pago, **a tasa de costo** (TIIE de la emisión + spread ASR), sujeta al umbral de Ajustes, y en el estado de cuenta va en su propia columna, etiquetada como estimación mientras el documento siga abierto. Comisión y FEGA se cobran solo si la política de cobro del documento lo dice (dos interruptores por política). La política **«Sin mora» (NONE) apaga el interés** del documento —y con él la comisión, el FEGA y la bonificación de pronto pago—; un documento *sin política capturada* no es "sin mora": se marca y se detiene. Los saldos del corte Compaq entran con la política que se elija en `/importar`, nunca por omisión de la columna. El estado de cuenta es el Excel de trabajo, **no** el export crudo de Compaq: el bloque "Por producto" muestra **saldo**, con el mismo filtro y el mismo total que la tabla de arriba.
2. **Kardex es la verdad** (`src/lib/erp/stock.ts`): `stock_moves` inmutable; `stock_quants` proyección; promedio móvil. Nunca una columna suelta de “existencia”.
3. **Compaq sigue timbrando.** No inventar PAC/CFDI ahora.
4. **No importar facturas ya liquidadas** ni P&L histórico. Solo saldos abiertos + existencias de corte (`src/lib/erp/cutover.ts`), clave única `cutover_key`.
5. **Pared de privacidad:** el cliente no ve al proveedor. Brokeraje/directo no recibe en bodega Azagro.
6. Folios existentes (SOL/SC/COT/PV/OC/FV/FP/NC/FI). No series nuevas salvo que lo pidan.
7. UI y copy en español. Sin emojis salvo que lo pidan.
8. **Precio = (costo puesto + financiamiento) ÷ (1 − margen %).** El flete se prorratea al costo del producto: **costo puesto = mercancía + flete + otros**, y esa es la base de todo — margen, financiamiento del precio y costo financiero de la tarjeta del pedido (`computeDealPnl`). Las dos cifras tienen que coincidir; hay prueba. El margen es **sobre el precio de venta**, no sobre el costo (hojas reales de la dirección, 3-sep-2026); con margen en $ fijo: costo puesto + financiamiento + monto. El financiamiento se suma al costo antes del margen. Dos márgenes: contado → columna de contado; crédito → todas las columnas a plazo. La escalera de plazos (`src/lib/erp/ladder.ts`, plazos de Ajustes) es interna: al cliente solo le salen contado y el plazo acordado.
9. **Nada de valores por omisión que decidan dinero. REGLA ÚNICA: todo número de negocio se lee de Ajustes o de su tabla; si no está, el sistema se detiene y avisa; nunca inventa un número.** Sin margen capturado la pantalla dice “Sin margen” y no cotiza; igual que sin costo. Sin renglón de TIIE en la tabla no se cotiza a crédito ni se factura interés. Sin renglón completo de Ajustes, `policy()` truena. Sin TC en la tabla no se guarda nada en dólares. No reponer el 12%, el TC 18, el 7.06%, los 90/30 días ni un 0% “para que calcule”. `scripts/erp-sin-numeros.test.mjs` barre `src/` y falla si vuelve un número de negocio al código; la TIIE viene de `nearestRate(tabla, fecha)` (2 argumentos, sin respaldo). La lista inicial de la escalera vive en la migración 0020, no en el código.

## Mapa

| Qué | Dónde |
|---|---|
| Recibir / entregar / devolver / cobrar | `src/lib/azagro.ts` — van en `withTx()` |
| Kardex + promedio móvil | `src/lib/erp/stock.ts` |
| Mora / estado de cuenta | `src/lib/erp/credit.ts` |
| Expediente (cadena SOL→…→FV) | `src/lib/erp/deal.ts` |
| Catálogos Compaq (CL/PV/productos/almacenes) | `src/lib/erp/catalog.ts` + `compaq.ts` |
| Corte / importar / respaldo | `src/lib/erp/cutover.ts`, ruta `/importar` |
| Bitácora | `src/lib/erp/audit.ts`, ruta `/bitacora` |
| Archivos del folio | `src/lib/erp/files.ts` |
| RFQ sin pedido de cliente | `src/lib/erp/rfq.ts`, `/rfq/nuevo` |
| Dos márgenes (contado/crédito), **margen sobre el precio**, precio↔margen, **sin margen por omisión** | `src/lib/erp/margins.ts` |
| Escalera de plazos (Ajustes `quote_terms`), documento con dos precios | `src/lib/erp/ladder.ts`, `/quotes` panel "Ver" |
| Candado de solicitud ya cotizada | `src/lib/erp/request-lock.ts` |
| Interruptores de comisión / FEGA por política de cobro | `credit_policies`, `chargeRates` en `credit.ts`, panel en `/settings` |
| «Sin mora» apaga el interés | `NO_MORA_POLICY` / `policyChargesInterest` en `credit.ts` |
| Bloque "Por producto" del estado de cuenta (saldo, no venta) | `src/lib/erp/statement-products.ts`, `/statements` |
| Reglas de negocio (texto UI) | `src/lib/erp/rules.ts` |
| Fórmulas testeadas | `scripts/erp-formulas.test.mjs` |
| Barrido: ningún número de negocio en código | `scripts/erp-sin-numeros.test.mjs` |
| Margen sobre precio + escalera (casos del dueño) | `scripts/erp-escalera.test.mjs` |
| Estado de cuenta antes del vencimiento + pronto pago | `scripts/erp-estado-cuenta.test.mjs` |
| Comisión / FEGA opcionales por política, «Sin mora», política del corte | `scripts/erp-politica-cobro.test.mjs` |
| "Por producto" cuadra con la tabla de arriba | `scripts/erp-por-producto.test.mjs` |
| ¿Factura duplicada? (solo lectura, con `DATABASE_URL`) | `scripts/erp-facturas-repetidas.mjs` |

Movimientos de stock y cobros: **transacción + `FOR UPDATE`**. Alter table **fuera** de `withTx`.

## Correr

```bash
npm install
npm run dev          # preview local
npm test             # incluye fórmulas de cartera
npx tsc --noEmit
```

Producción: `DATABASE_URL` (Neon). Sin eso es PGLite y se pierde al reiniciar.

## Siguiente (producto, no arquitectura)

1. Pegar CSV de saldos abiertos Compaq + existencias + bancos.
2. Semana en paralelo: operación nueva aquí, Compaq timbra.
3. Después: lotes/caducidad, UOM L↔tambo, CFDI.

No reescribir en ERPNext/Odoo. No microservicios. Extender este modelo.
