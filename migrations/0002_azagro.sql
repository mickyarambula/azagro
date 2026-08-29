-- Azagro ERP schema (company-scoped; membership via user_id)

create table if not exists companies (
  id serial primary key,
  name text not null,
  join_code text not null unique,
  created_by text not null,
  created_at timestamptz not null default now()
);

create table if not exists members (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  user_id text not null,
  role text not null default 'operator',
  display_name text,
  created_at timestamptz not null default now(),
  unique (company_id, user_id)
);
create index if not exists members_user_id_idx on members (user_id);

create table if not exists partners (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  code text not null,
  name text not null,
  rfc text not null default '',
  is_customer boolean not null default false,
  is_supplier boolean not null default false,
  credit_limit numeric(14,2) not null default 0,
  payment_days integer not null default 30,
  late_rate numeric(6,3) not null default 0,
  email text not null default '',
  phone text not null default '',
  city text not null default '',
  notes text not null default '',
  unique (company_id, code)
);

create table if not exists products (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  code text not null,
  name text not null,
  category text not null default 'Insumos',
  uom text not null default 'SAC',
  cost numeric(14,4) not null default 0,
  list_price numeric(14,4) not null default 0,
  min_stock numeric(14,3) not null default 0,
  unique (company_id, code)
);

create table if not exists locations (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  code text not null,
  name text not null,
  loc_type text not null default 'internal',
  partner_id integer references partners(id) on delete set null,
  unique (company_id, code)
);

create table if not exists stock_quants (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  product_id integer not null references products(id) on delete cascade,
  location_id integer not null references locations(id) on delete cascade,
  quantity numeric(14,3) not null default 0,
  unique (company_id, product_id, location_id)
);

create table if not exists stock_moves (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  ref text not null,
  move_type text not null,
  date date not null default current_date,
  origin text not null default '',
  location_from integer references locations(id),
  location_to integer references locations(id),
  product_id integer not null references products(id),
  quantity numeric(14,3) not null,
  created_by text not null
);

create table if not exists purchase_orders (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  name text not null,
  partner_id integer not null references partners(id),
  date date not null default current_date,
  state text not null default 'draft',
  location_id integer not null references locations(id),
  notes text not null default '',
  total numeric(14,2) not null default 0
);

create table if not exists purchase_lines (
  id serial primary key,
  po_id integer not null references purchase_orders(id) on delete cascade,
  product_id integer not null references products(id),
  qty numeric(14,3) not null,
  qty_received numeric(14,3) not null default 0,
  unit_price numeric(14,4) not null
);

create table if not exists sales_orders (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  name text not null,
  partner_id integer not null references partners(id),
  date date not null default current_date,
  state text not null default 'draft',
  location_id integer not null references locations(id),
  notes text not null default '',
  total numeric(14,2) not null default 0
);

create table if not exists sales_lines (
  id serial primary key,
  so_id integer not null references sales_orders(id) on delete cascade,
  product_id integer not null references products(id),
  qty numeric(14,3) not null,
  qty_delivered numeric(14,3) not null default 0,
  unit_price numeric(14,4) not null
);

create table if not exists invoices (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  kind text not null,
  name text not null,
  partner_id integer not null references partners(id),
  date date not null default current_date,
  due_date date not null,
  state text not null default 'open',
  amount numeric(14,2) not null,
  residual numeric(14,2) not null,
  origin text not null default '',
  late_amount numeric(14,2) not null default 0
);

create table if not exists payments (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  kind text not null,
  name text not null,
  partner_id integer not null references partners(id),
  date date not null default current_date,
  amount numeric(14,2) not null,
  memo text not null default '',
  created_by text not null
);

create table if not exists payment_allocs (
  id serial primary key,
  payment_id integer not null references payments(id) on delete cascade,
  invoice_id integer not null references invoices(id) on delete cascade,
  amount numeric(14,2) not null
);

create index if not exists invoices_company_idx on invoices (company_id, kind, state);
create index if not exists stock_quants_company_idx on stock_quants (company_id);
