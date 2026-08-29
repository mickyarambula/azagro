-- Firma de quien recibe en la guía del fletero.

alter table sales_orders add column if not exists guia_sign text not null default '';
alter table sales_orders add column if not exists guia_sign_name text not null default '';
alter table sales_orders add column if not exists guia_sign_at timestamptz;
