-- Puente con Compaq (SESIÓN D, hallazgo 3, 6-sep-2026): la FV/FI del sistema
-- no sabían qué CFDI las timbró Compaq, ni la FP el folio que dio el
-- proveedor. Se capturan DESPUÉS de emitido el documento -- Compaq timbra más
-- tarde -- así que las tres nacen vacías y vacío no es error, nunca bloquea
-- nada (ver src/lib/azagro.ts saveInvoiceReference). Solo texto: no se valida
-- contra un formato ni se inventa un patrón de folio/UUID.

alter table invoices add column if not exists folio_fiscal text not null default '';
alter table invoices add column if not exists uuid_fiscal text not null default '';
alter table invoices add column if not exists supplier_folio text not null default '';
