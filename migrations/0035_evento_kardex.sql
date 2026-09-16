-- BLOQUE DE PARCIALES, paso 0(b) (PARCIALES.md § 5, § 8): la liga que hoy no
-- existe entre un movimiento de kardex (o una factura) y CUÁL recepción o
-- entrega lo generó. Hoy `origin` guarda el folio de la OC/pedido, compartido
-- por TODAS sus recepciones/entregas (una OC con dos recepciones no tiene
-- forma de saber cuál movimiento vino de cuál). Amarre por texto, el mismo
-- estilo que ya usa la Decisión 42 (el movimiento `return` lleva en `origin`
-- el folio de la NC que lo causó) — sin tabla ni llave foránea nueva.
--
-- Nula en todo lo existente: nada de lo capturado hasta hoy tiene evento
-- (todo es "la única" recepción/entrega). Solo el paso 1 (recepción parcial)
-- empieza a llenarla, con la serie de folio nueva `RCP` (vía `folio_counters`,
-- A4). El lado de entrega (paso 3, todavía no se construye) se queda con la
-- columna lista pero sin usar.
alter table stock_moves add column if not exists event_ref text;
alter table invoices add column if not exists event_ref text;
