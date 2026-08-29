-- Catálogos editables: unidades, tipos de producto, grupos de clientes

create table if not exists uoms (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  code text not null,
  name text not null default '',
  unique (company_id, code)
);

create table if not exists product_kinds (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  code text not null,
  name text not null default '',
  unique (company_id, code)
);

create table if not exists partner_groups (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  code text not null,
  name text not null default '',
  unique (company_id, code)
);
