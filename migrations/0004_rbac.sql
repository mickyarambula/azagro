-- Roles, permisos por módulo y solicitudes de acceso

alter table members add column if not exists email text not null default '';
alter table members add column if not exists status text not null default 'active';
alter table members add column if not exists own_only boolean not null default false;

update members set role = 'administracion' where role = 'operator';

create table if not exists member_acl (
  id serial primary key,
  member_id integer not null references members(id) on delete cascade,
  module text not null,
  level text not null default 'none',
  unique (member_id, module)
);

create table if not exists access_requests (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  user_id text not null,
  email text not null default '',
  name text not null default '',
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create index if not exists access_requests_user_idx on access_requests (user_id, status);

alter table partners add column if not exists seller_id text;
alter table quotes add column if not exists owner_id text;
alter table sales_orders add column if not exists owner_id text;
