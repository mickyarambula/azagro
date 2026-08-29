# Handoff Azagro — 29 ago 2026

Documento para quien continúa (Claude Code, Claude.ai, u otro). El ERP se construyó en Grok Build; **el código no estaba en GitHub** hasta este repo.

## Qué es

Azagro vende agroquímicos/fertilizantes a productores (crédito agrícola largo). Hoy operan Compaq + Excel. Este sistema es el **circuito operativo + cartera** con la calidad de Cosecha/Plein Produce, no un Compaq 2.

Empresa: AZ Insumos Agrícolas SA de CV. Grupos de clientes: Grupo SL, Fertisem, Santa Rosa, Varios. Reportes Compaq de referencia: A. Premier, SL Agrícola, Grupo SL.

Dueño del producto: Miguel Arambula (`mickyarambula`). Habla en español, quiere que se implemente sin preguntar de más, “aplica en todo el sistema”.

## Circuito que ya corre

```
Solicitud (SOL) → RFQ/SC a proveedores → Cotización (COT) → Pedido venta (PV)
  → OC al ganador (o Pedido de compra / RFQ sin cliente para inventariar)
  → Recibir (solo inventario; brokeraje va en camino al cliente)
  → Entregar → FV → cobro/pago → estado de cuenta (TIIE, FEGA, días exactos)
```

También: devolución cliente (NC + kardex reverse), expediente clickeable por folio, destinos de entrega, auto-vínculo partner↔producto al comprar/vender, límite de crédito, usuarios/ACL.

## Lo que Compaq no trae y Azagro sí (el foso)

Compaq exporta: código, serie, folio, fechas, cargo, abono, saldo, ut. cambiaria.

El Excel de trabajo (Grupo SL) agrega: plazo, fecha de pago, días vence, **días vencidos**, interés s/ días, comisión+FEGA, total. MXN y USD aparte; consolidado por grupo.

Fórmulas (no negociable):

- Días **calendario exactos**, no meses de 30.
- Interés = Cargo × (TIIE al vencimiento + 9%) × días / **360**. Con signo: negativo = pronto pago.
- Comisión 1% + FEGA 2.04% = **3.04%** una sola vez sobre el cargo.
- FI (mora) solo si ya venció; no se mete al precio del producto.
- Costo de línea en precio (si hay crédito): TIIE mes + spread ~4.5%. Eso no es mora.

## Inventario (lección ERPNext que sí se copió)

Kardex inmutable (`stock_moves`) + valuación promedio móvil. Quants son proyección. Recibir/entregar/devolver/ajustar/trasladar van en transacción con `FOR UPDATE`.

No se copió aún: lotes con caducidad, factores UOM, Pricing Rule.

## Corte (para operar de verdad)

Catálogos Compaq **sí** se cargan (Ajustes → Importar / corte): clientes CL0001–CL0034, proveedores PV001–PV017, productos, almacenes 001–016/999, RFC, límite.

**No** se pegaron importes 2024–2026. El importador de **saldos abiertos** y **existencias** ya existe y es idempotente (`cutover_key` / origen `Corte Compaq`). Falta que Azagro pegue el CSV del día de corte:

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

## Técnico ya hecho (ago 25)

- `withTx()` Neon + PGLite
- Bitácora `/bitacora`
- Archivos en el folio (CFDI/guía)
- Respaldo JSON
- Tests `scripts/erp-formulas.test.mjs` (promedio móvil, mora 60d, pronto pago, residual, límite)

Producción necesita `DATABASE_URL` (Postgres/Neon). El preview sin eso es PGLite y no es la empresa.

## Qué no hacer

- Reescribir en ERPNext/Odoo.
- Meter CFDI/PAC, contabilidad de pólizas, nómina, lotes — hasta que el corte cuadre.
- Duplicar cartera histórica.
- Preguntar puertos/paths al usuario: él no tiene terminal; si estás en Claude Code, sí tienes repo.

## Cómo dárselo a Claude

1. **Claude Code (recomendado):** `claude` en el clone de este repo. Lee `CLAUDE.md` solo.
2. **claude.ai proyecto:** pega `CLAUDE.md` + `HANDOFF.md` en las instrucciones del proyecto y sube el zip del repo (sin `node_modules`).
3. **Chat suelto:** primer mensaje = contenido de `HANDOFF.md` + “el código está en github.com/mickyarambula/azagro”.

Compaq Excel originales y pantallas **no** van en el repo (datos de clientes). Siguen en el workspace Grok si se necesitan de referencia.
