-- Pedido: condiciones comerciales por documento (no por cliente / empresa)

alter table sales_orders add column if not exists term_kind text not null default 'credit_days';
alter table sales_orders add column if not exists invoice_days integer not null default 0;
alter table sales_orders add column if not exists credit_days integer not null default 0;
alter table sales_orders add column if not exists invoice_due date;
alter table sales_orders add column if not exists credit_due date;
alter table sales_orders add column if not exists route_kind text not null default 'own';
alter table sales_orders add column if not exists asr_partner_id integer references partners(id);
alter table sales_orders add column if not exists policy_code text not null default 'NONE';
alter table sales_orders add column if not exists oc_cliente text not null default '';
alter table sales_orders add column if not exists price_mode text not null default 'custom';

alter table sales_lines add column if not exists uom text not null default '';

alter table invoices add column if not exists credit_due date;
alter table invoices add column if not exists invoice_days integer;
alter table invoices add column if not exists credit_days integer;
alter table invoices add column if not exists policy_code text not null default 'NONE';

create table if not exists credit_policies (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  code text not null,
  name text not null,
  spread numeric(8,4) not null default 0,
  fega_rate numeric(8,4) not null default 0,
  unique (company_id, code)
);

create index if not exists sales_orders_partner_idx on sales_orders (company_id, partner_id, state);
