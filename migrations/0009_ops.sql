-- Bodegas: partner ya existe. Vínculo partner↔producto y columnas de cotizador.

create table if not exists partner_products (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  partner_id integer not null references partners(id) on delete cascade,
  product_id integer not null references products(id) on delete cascade,
  kind text not null default 'sell',
  unit_price numeric(14,4) not null default 0,
  notes text not null default '',
  unique (company_id, partner_id, product_id, kind)
);

alter table quotes add column if not exists cost_total numeric(14,2) not null default 0;
alter table quotes add column if not exists freight_total numeric(14,2) not null default 0;
alter table quotes add column if not exists finance_total numeric(14,2) not null default 0;
alter table quote_lines add column if not exists cost numeric(14,4) not null default 0;
alter table quote_lines add column if not exists freight numeric(14,4) not null default 0;
