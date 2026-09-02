# Azagro ERP — instrucciones para Claude

ERP operativo de **AZ Insumos Agrícolas (Azagro)**, Los Mochis. Reemplaza Compaq + Excel de cartera (Grupo SL / A. Premier / SL Agrícola), no el timbrado SAT.

Lee `HANDOFF.md` entero antes de tocar código. Producto en **español**. No preguntes de más: si el usuario dice “adelante”, implementa.

## Stack

- TanStack Start (file routes en `src/routes/`) + React + Tailwind
- Postgres: Neon si hay `DATABASE_URL`, si no PGLite embebido (`src/lib/db.ts`)
- better-auth
- Server functions: `createServerFn` + `authMiddleware`
- Schema: `migrations/*.sql` (0014 = bitácora, archivos, corte idempotente; 0016 = `products.ref_cost`; 0017 = dos márgenes/precios por partida, `accepted_offer`, plazo de la solicitud — columnas nulas, sin rellenar)

## No romper

1. **Crédito Azagro** (`src/lib/erp/credit.ts`, `rules.ts`): días calendario exactos; interés **días/360**; TIIE + spread 9%; comisión 1% + FEGA 2.04% = 3.04% una vez; interés con signo (negativo = pronto pago). El estado de cuenta es el Excel de trabajo, **no** el export crudo de Compaq.
2. **Kardex es la verdad** (`src/lib/erp/stock.ts`): `stock_moves` inmutable; `stock_quants` proyección; promedio móvil. Nunca una columna suelta de “existencia”.
3. **Compaq sigue timbrando.** No inventar PAC/CFDI ahora.
4. **No importar facturas ya liquidadas** ni P&L histórico. Solo saldos abiertos + existencias de corte (`src/lib/erp/cutover.ts`), clave única `cutover_key`.
5. **Pared de privacidad:** el cliente no ve al proveedor. Brokeraje/directo no recibe en bodega Azagro.
6. Folios existentes (SOL/SC/COT/PV/OC/FV/FP/NC/FI). No series nuevas salvo que lo pidan.
7. UI y copy en español. Sin emojis salvo que lo pidan.

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
| Dos márgenes (contado/crédito), precio↔margen | `src/lib/erp/margins.ts` |
| Candado de solicitud ya cotizada | `src/lib/erp/request-lock.ts` |
| Reglas de negocio (texto UI) | `src/lib/erp/rules.ts` |
| Fórmulas testeadas | `scripts/erp-formulas.test.mjs` |

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
