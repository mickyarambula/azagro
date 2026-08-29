-- Azagro ERP v2: catalogs, FX, credit policy, quotes, banks, invoice lines, documents

alter table companies add column if not exists legal_name text not null default 'AZ INSUMOS AGRICOLAS SA DE CV';
alter table companies add column if not exists rfc text not null default '';

alter table partners add column if not exists group_name text not null default '';
alter table partners add column if not exists legal_name text not null default '';
alter table partners add column if not exists address text not null default '';
alter table partners add column if not exists partner_kind text not null default 'trade';

alter table products add column if not exists product_type text not null default 'SOLUBLE';
alter table products add column if not exists notes text not null default '';

alter table locations add column if not exists address text not null default '';

alter table sales_orders add column if not exists currency text not null default 'MXN';
alter table sales_orders add column if not exists fx_rate numeric(12,6) not null default 1;
alter table sales_orders add column if not exists quote_id integer;
alter table sales_orders add column if not exists delivery_to text not null default '';

alter table purchase_orders add column if not exists currency text not null default 'MXN';
alter table purchase_orders add column if not exists fx_rate numeric(12,6) not null default 1;

alter table invoices add column if not exists currency text not null default 'MXN';
alter table invoices add column if not exists amount_fx numeric(14,4) not null default 0;
alter table invoices add column if not exists fx_agreed numeric(12,6) not null default 1;
alter table invoices add column if not exists fx_paid numeric(12,6);
alter table invoices add column if not exists inv_class text not null default 'product';
alter table invoices add column if not exists fega_charged boolean not null default false;
alter table invoices add column if not exists interest_invoiced numeric(14,2) not null default 0;
alter table invoices add column if not exists fx_invoiced numeric(14,2) not null default 0;
alter table invoices add column if not exists paid_date date;
alter table invoices add column if not exists order_id integer;

alter table payments add column if not exists bank_id integer;
alter table payments add column if not exists currency text not null default 'MXN';
alter table payments add column if not exists fx_rate numeric(12,6) not null default 1;

create table if not exists company_settings (
  company_id integer primary key references companies(id) on delete cascade,
  legal_name text not null default 'AZ INSUMOS AGRICOLAS SA DE CV',
  rfc text not null default '',
  credit_days integer not null default 150,
  invoice_days integer not null default 120,
  fega_rate numeric(8,4) not null default 0.0304,
  collection_spread numeric(8,4) not null default 0.09,
  asr_commission numeric(8,4) not null default 0.01,
  asr_spread numeric(8,4) not null default 0.04,
  default_tiie numeric(8,4) not null default 0.0706,
  email_from text not null default '',
  phone text not null default ''
);

create table if not exists partner_contacts (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  partner_id integer not null references partners(id) on delete cascade,
  name text not null,
  role text not null default '',
  email text not null default '',
  phone text not null default '',
  is_billing boolean not null default false
);

create table if not exists banks (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  name text not null,
  account text not null default '',
  currency text not null default 'MXN',
  opening numeric(14,2) not null default 0
);

create table if not exists bank_moves (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  bank_id integer not null references banks(id) on delete cascade,
  date date not null default current_date,
  amount numeric(14,2) not null,
  memo text not null default '',
  partner_id integer references partners(id),
  payment_id integer references payments(id),
  reconciled boolean not null default false,
  created_by text not null default ''
);

create table if not exists fx_rates (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  date date not null,
  usd_mxn numeric(12,6) not null,
  unique (company_id, date)
);

create table if not exists tiie_rates (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  date date not null,
  rate numeric(8,4) not null,
  unique (company_id, date)
);

create table if not exists quotes (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  name text not null,
  partner_id integer not null references partners(id),
  date date not null default current_date,
  valid_until date not null default current_date,
  currency text not null default 'USD',
  fx_rate numeric(12,6) not null default 1,
  state text not null default 'draft',
  notes text not null default '',
  delivery_to text not null default '',
  total numeric(14,2) not null default 0
);

create table if not exists quote_lines (
  id serial primary key,
  quote_id integer not null references quotes(id) on delete cascade,
  product_id integer not null references products(id),
  qty numeric(14,3) not null,
  unit_price numeric(14,4) not null
);

create table if not exists invoice_lines (
  id serial primary key,
  invoice_id integer not null references invoices(id) on delete cascade,
  product_id integer references products(id),
  description text not null default '',
  qty numeric(14,3) not null default 1,
  unit_price numeric(14,4) not null default 0,
  amount numeric(14,2) not null default 0
);

create table if not exists documents (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  kind text not null,
  title text not null,
  partner_id integer references partners(id),
  body text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists partner_contacts_partner_idx on partner_contacts (partner_id);
create index if not exists invoice_lines_inv_idx on invoice_lines (invoice_id);
create index if not exists bank_moves_bank_idx on bank_moves (bank_id, date);
create index if not exists quotes_company_idx on quotes (company_id, state);
