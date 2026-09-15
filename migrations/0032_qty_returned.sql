-- Cantidad devuelta por partida de venta: returnSale la suma, reverseReturn la
-- resta. Nacía por `alter table` en tiempo de ejecución dentro de returnSale
-- (azagro.ts) y getOrder (orders.ts) — PARCIALES.md § 10, paso 0 del bloque de
-- parciales. Misma definición que ya corre en producción, byte a byte, y la
-- misma que su hermana qty_delivered (0002_azagro.sql). Aditiva e idempotente:
-- sobre una base que ya la tiene es un no-op; sobre una vacía la crea en 0.
alter table sales_lines add column if not exists qty_returned numeric(14,3) not null default 0;
