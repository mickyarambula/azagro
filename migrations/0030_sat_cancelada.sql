-- BLOQUE DE DESHACER, paso 8 (Decisión 41): cuándo se canceló ante el SAT un
-- CFDI que este sistema revirtió. Aplica a la NC de una devolución revertida
-- (no tiene documento contrario: en el SAT se CANCELA el CFDI de egreso desde
-- Compaq). Este sistema no cancela ante el SAT (regla 3): registra el hecho
-- cuando alguien lo captura en el mismo puente donde captura el folio fiscal.
-- Nula = pendiente. Con fecha, la marca y el conteo del tablero se limpian
-- solos: quien captura registra un hecho, no apaga un aviso.
alter table invoices add column if not exists sat_cancelled_at date;
