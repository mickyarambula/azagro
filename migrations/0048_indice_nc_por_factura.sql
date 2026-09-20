-- 0048 — Índice para «cuánto se devolvió de esta factura» (L3b, 20-sep-2026).
--
-- `returnedOfInvoices` y la subconsulta de `listInvoices` caminan
-- `invoices.applies_to_id` (la NC apunta a la factura de la que salió,
-- migración 0036). No había índice: `invoices` solo tenía por `id`,
-- `(company_id, kind, state)`, `cutover_key`, folio y `(company_id, kind,
-- origin)`. La pantalla de Cartera resuelve esa subconsulta POR RENGLÓN sobre
-- todas las facturas de cliente de la empresa, así que sin índice son cientos
-- de barridos por carga.
create index if not exists inv_applies_to_idx on invoices (company_id, applies_to_id);
