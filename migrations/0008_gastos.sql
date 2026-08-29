-- Gastos operativos / sobre pedido / financieros + tipos de movimiento bancario

create table if not exists expense_categories (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  code text not null,
  name text not null,
  class text not null default 'operativo',
  unique (company_id, code)
);

create table if not exists expenses (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  name text not null,
  date date not null default current_date,
  class text not null default 'operativo',
  category_id integer references expense_categories(id),
  amount numeric(14,2) not null,
  partner_id integer references partners(id),
  so_id integer references sales_orders(id),
  po_id integer references purchase_orders(id),
  invoice_ref text not null default '',
  pay_kind text not null default 'cash',
  bank_id integer references banks(id),
  bank_move_id integer references bank_moves(id),
  notes text not null default '',
  created_by text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists exp_co_idx on expenses (company_id, date);
create index if not exists exp_so_idx on expenses (so_id);
create index if not exists exp_po_idx on expenses (po_id);

alter table bank_moves add column if not exists kind text not null default 'ajuste';
alter table bank_moves add column if not exists expense_id integer references expenses(id);
alter table bank_moves add column if not exists so_id integer references sales_orders(id);
alter table bank_moves add column if not exists po_id integer references purchase_orders(id);
alter table bank_moves add column if not exists invoice_id integer references invoices(id);
