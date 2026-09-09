-- Favoritos del menú por persona (bloque de diseño, parte 1, 9-sep-2026).
-- Cada renglón = un miembro marcó una sección (nav.ts SectionDef.key).
-- Nace vacía: no hay favoritos por omisión, ni en código ni por rol.
create table if not exists member_favorites (
  member_id   integer     not null references members(id) on delete cascade,
  section_key text        not null,
  created_at  timestamptz not null default now(),
  primary key (member_id, section_key)
);
