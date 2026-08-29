alter table quotes add column if not exists tiie numeric(8,6) not null default 0;
alter table quotes add column if not exists spread numeric(8,6) not null default 0;
alter table quotes add column if not exists credit_days integer not null default 0;
alter table quote_lines add column if not exists cost numeric(14,4) not null default 0;
alter table quote_lines add column if not exists freight numeric(14,4) not null default 0;
alter table quote_lines add column if not exists other_cost numeric(14,4) not null default 0;
alter table quote_lines add column if not exists margin_pct numeric(8,4) not null default 0;

create table if not exists vendor_rfqs (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  name text not null,
  quote_id integer references quotes(id) on delete set null,
  notes text not null default '',
  state text not null default 'open',
  created_at timestamptz not null default now()
);

create table if not exists vendor_rfq_suppliers (
  rfq_id integer not null references vendor_rfqs(id) on delete cascade,
  partner_id integer not null references partners(id) on delete cascade,
  primary key (rfq_id, partner_id)
);

create table if not exists vendor_rfq_lines (
  id serial primary key,
  rfq_id integer not null references vendor_rfqs(id) on delete cascade,
  product_id integer not null references products(id),
  qty numeric(14,3) not null,
  uom text not null default ''
);

create table if not exists vendor_rfq_bids (
  id serial primary key,
  rfq_id integer not null references vendor_rfqs(id) on delete cascade,
  partner_id integer not null references partners(id),
  product_id integer not null references products(id),
  unit_price numeric(14,4) not null default 0,
  unique (rfq_id, partner_id, product_id)
);
