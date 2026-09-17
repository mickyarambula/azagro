-- 0038: saldo inicial de bancos por el corte (Decisión 63, 16-sep-2026).
-- El importador de /importar escribe el saldo inicial como un movimiento
-- de banco con fecha y rastro, idempotente por cutover_key, en vez del
-- campo banks.opening que se pisa a mano y sin fecha. Solo aditivo.
alter table bank_moves add column if not exists cutover_key text;
create unique index if not exists bank_moves_cutover_key_uq
  on bank_moves (company_id, cutover_key) where cutover_key is not null;
