-- BLOQUE C4 — Borrado de datos de prueba, paso 1 (BORRADO-PRUEBAS.md § 2,
-- "Hueco encontrado"). Aditiva. Nada se borra aquí.
--
-- El SQL del borrado (scripts/purge-plan.mjs) nombra SEIS cosas que hasta hoy
-- solo nacían en tiempo de ejecución (un `create table` / `alter table` dentro
-- de una pantalla) y en ninguna migración: en una base construida solo con
-- migraciones — la PGlite de las pruebas, o un Neon donde nunca se abrió esa
-- pantalla — el borrado tronaría. Solo esas seis entran aquí (corrección del
-- dueño, 15-sep-2026); las demás columnas que también nacen por `alter` en
-- runtime y el borrado NO nombra quedan para el bloque de columnas huérfanas.
-- Definiciones copiadas letra por letra de donde nacen hoy, para que sobre
-- producción (donde ya existen) cada sentencia sea un no-op.
--
-- Más la séptima, nueva: `company_settings.live_since`, el candado de arranque
-- (§ 4.2). Nula = todavía en pruebas. Nace nula en todas las empresas: nadie
-- ha declarado que arrancó la operación real; eso lo hace un administrador
-- desde la pantalla (paso 4), nunca una migración.

-- 1. alerts.ts `ensureAlerts`
create table if not exists notifications (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  kind text not null default 'due',
  title text not null,
  body text not null default '',
  payload jsonb not null default '{}',
  read_at timestamptz,
  created_at timestamptz not null default now()
);

-- 2. cutover.ts `applyOpenInvoices` / stock.ts `refreshInvoiceResidual`
alter table invoices add column if not exists opening_paid numeric(14,2) not null default 0;
-- 3-4. azagro.ts `registerPayment` / reports.ts
alter table invoices add column if not exists fx_result numeric(14,2) not null default 0;
alter table invoices add column if not exists fx_treatment text not null default '';
-- 5-6. stock.ts `ensureStock`
alter table stock_moves add column if not exists unit_cost numeric(14,4) not null default 0;
alter table stock_quants add column if not exists avg_cost numeric(14,4) not null default 0;

-- 7. Candado de arranque (nuevo). Nula en todas: en pruebas.
alter table company_settings add column if not exists live_since timestamptz;
