-- Observaciones de la guía de carga.

alter table sales_orders add column if not exists guia_obs text not null default '';
