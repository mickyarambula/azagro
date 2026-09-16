-- BLOQUE DE PARCIALES, paso 5 (Decisión 52): a CUÁL factura abonó una nota de
-- crédito de devolución. Hoy solo se sabe leyendo el memo del abono virtual
-- ("Devolución NC-x") — amarre por texto de bitácora, lo mismo que la Decisión
-- 42 corrigió para el kardex — y si la factura ya estaba pagada no hay abono,
-- así que no hay rastro. Sin esto no se puede saber cuánto de cada factura ya
-- se devolvió, que es lo que la Decisión 52 necesita para proponer la
-- siguiente. Nula en todo lo existente; solo las devoluciones nuevas la llenan.
-- Sin llave foránea, como `reverses_id` y `event_ref`.
alter table invoices add column if not exists applies_to_id integer;
