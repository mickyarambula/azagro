-- BLOQUE DE PARCIALES, paso 7 (PARCIALES.md § 5, Decisiones 49 y 50): la
-- casilla `cerrada_corta` de la identidad del cuadre — la cantidad de una
-- partida que YA NUNCA va a llegar (OC) o a salir (pedido), cerrada a mano
-- con motivo obligatorio. Con ella, pendiente = qty − recibida/entregada −
-- cerrada_corta, y el documento puede pasar a `done` sin que haya llegado
-- todo. Por partida (cada producto puede cerrarse en distinta cantidad),
-- hermana de qty_received / qty_delivered / qty_returned. Nace en 0.
alter table purchase_lines add column if not exists qty_closed_short numeric(14,3) not null default 0;
alter table sales_lines    add column if not exists qty_closed_short numeric(14,3) not null default 0;

-- Quién, cuándo y por qué, en el documento mismo — mismo trío que
-- cancelled_at / cancelled_by / cancel_reason (0029). Un motivo por cierre,
-- no por partida. Nulos hasta que alguien cierre corto.
alter table purchase_orders add column if not exists closed_short_at     timestamptz;
alter table purchase_orders add column if not exists closed_short_by     text;
alter table purchase_orders add column if not exists closed_short_reason text;
alter table sales_orders    add column if not exists closed_short_at     timestamptz;
alter table sales_orders    add column if not exists closed_short_by     text;
alter table sales_orders    add column if not exists closed_short_reason text;
