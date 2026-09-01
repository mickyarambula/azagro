-- Candado de unicidad de folios: dos capturas en el mismo instante ya no
-- pueden producir dos documentos con el mismo folio (TRAZABILIDAD.md h13).
-- Las facturas importadas de Compaq quedan fuera (folios de terceros que
-- pueden repetirse entre proveedores); su unicidad la da cutover_key.
alter table invoices add column if not exists cutover_key text;
create unique index if not exists invoices_folio_uq on invoices (company_id, name) where cutover_key is null;
create unique index if not exists sales_orders_folio_uq on sales_orders (company_id, name);
create unique index if not exists purchase_orders_folio_uq on purchase_orders (company_id, name);
create unique index if not exists quotes_folio_uq on quotes (company_id, name);
create unique index if not exists payments_folio_uq on payments (company_id, name);
create unique index if not exists stock_moves_ref_uq on stock_moves (company_id, ref);
