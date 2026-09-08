-- BLOQUE DE DESHACER, paso 0 (DESHACER.md, Decisiones 15/16 y 17-25,
-- DECISIONES.md): cimientos, sin cambiar comportamiento. Ningún documento
-- se puede cancelar ni revertir todavía — eso empieza en el paso 1.
--
-- Estado nuevo: 'cancelled' en solicitud/cotización/pedido/OC (no movieron
-- nada, se marcan y se conservan); 'reversed' en facturas (sí movieron
-- cartera, llevan su contrario). Quién/cuándo/por qué en el documento mismo.
-- La liga original↔reversa para no adivinar qué nació de qué (DESHACER.md
-- § 4, caso 4).
alter table customer_requests add column if not exists cancelled_at timestamptz;
alter table customer_requests add column if not exists cancelled_by text;
alter table customer_requests add column if not exists cancel_reason text;

alter table quotes add column if not exists cancelled_at timestamptz;
alter table quotes add column if not exists cancelled_by text;
alter table quotes add column if not exists cancel_reason text;

alter table sales_orders add column if not exists cancelled_at timestamptz;
alter table sales_orders add column if not exists cancelled_by text;
alter table sales_orders add column if not exists cancel_reason text;

alter table purchase_orders add column if not exists cancelled_at timestamptz;
alter table purchase_orders add column if not exists cancelled_by text;
alter table purchase_orders add column if not exists cancel_reason text;

alter table invoices add column if not exists cancelled_at timestamptz;
alter table invoices add column if not exists cancelled_by text;
alter table invoices add column if not exists cancel_reason text;

alter table invoices add column if not exists reverses_id integer references invoices(id);
alter table payments add column if not exists reverses_id integer references payments(id);
alter table bank_moves add column if not exists reverses_id integer references bank_moves(id);
alter table stock_moves add column if not exists reverses_id integer references stock_moves(id);
