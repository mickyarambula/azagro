-- 0039: el plazo de pago del socio admite VACÍO (Decisión 67, 16-sep-2026;
-- aplica la Decisión 30: vacío no es cero). Hasta hoy la columna era not null
-- y el catálogo sembraba 0 = contado a todo proveedor nuevo: un valor por
-- omisión que decidía cuándo vence la deuda. Los renglones existentes NO se
-- tocan (un 0 ya capturado puede ser contado a propósito); solo los socios
-- nuevos nacen sin plazo. No borra ni cambia datos ni tipo: quita una
-- restricción. Ningún lector se rompe: bornSupplierDebt / cpo.ts ya tratan
-- null como "falta el plazo" y se detienen.
alter table partners alter column payment_days drop not null;
