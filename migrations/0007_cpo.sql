-- OC del cliente (la que nos mandan) y UoM en partidas de cotización/compra

alter table quote_lines add column if not exists uom text not null default '';
alter table purchase_lines add column if not exists uom text not null default '';

create table if not exists customer_pos (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  partner_id integer not null references partners(id),
  name text not null,
  customer_po_number text not null default '',
  po_date date not null default current_date,
  currency text not null default 'USD',
  fx_rate numeric(12,6) not null default 1,
  notes text not null default '',
  status text not null default 'open',
  so_id integer references sales_orders(id),
  total numeric(14,2) not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists customer_po_lines (
  id serial primary key,
  cpo_id integer not null references customer_pos(id) on delete cascade,
  product_id integer not null references products(id),
  qty numeric(14,4) not null,
  uom text not null default '',
  unit_price numeric(14,4) not null default 0
);

create index if not exists customer_pos_company_idx on customer_pos (company_id, status);
