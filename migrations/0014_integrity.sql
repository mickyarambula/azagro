create table if not exists audit_log (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  user_id text not null default '',
  action text not null,
  entity text not null,
  entity_id integer,
  name text not null default '',
  detail text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists audit_log_company_idx on audit_log (company_id, created_at desc);

create table if not exists doc_files (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  kind text not null,
  entity_id integer not null default 0,
  filename text not null,
  mime text not null default 'application/octet-stream',
  content text not null,
  created_by text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists doc_files_entity_idx on doc_files (company_id, kind, entity_id);

alter table invoices add column if not exists cutover_key text;
create unique index if not exists invoices_cutover_key_uq on invoices (company_id, cutover_key) where cutover_key is not null;
