-- 0041: folios de los documentos de dinero por serie (AUDITORIA.md § 3 grupo
-- C, 17-sep-2026). FV, FP, NC, FI, ATC y PAG dejan de numerarse con
-- count(*)+1 (cada sitio contaba con un filtro distinto — la FI contaba TODAS
-- las facturas — y dos peticiones simultáneas podían leer el mismo conteo;
-- el índice único de la 0015 era el único respaldo) y pasan a folio_counters
-- (0033): una serie por prefijo, +1 atómico dentro de la transacción del
-- documento (`nextDocFolio`, src/lib/erp/folios.ts).
--
-- Aditiva: no crea tablas ni columnas. Solo siembra el máximo real por
-- (empresa, serie) desde los nombres que ya existen, como la 0033 con
-- stock_moves. Nada se renumera: lo emitido se queda como está; cada serie
-- sigue desde su último número. Sobre una base sin documentos no inserta
-- nada y la serie nace en 0001 la primera vez que se pida. Idempotente
-- (greatest). Los saldos del corte tienen folio de Compaq, no de estas
-- series, y quedan fuera del patrón.
insert into folio_counters (company_id, series, last_number)
select company_id, split_part(name, '-', 1), max(split_part(name, '-', 2)::int)
  from invoices
 where name ~ '^(FV|FP|NC|FI|ATC)-[0-9]{4,}$'
 group by company_id, split_part(name, '-', 1)
union all
select company_id, 'PAG', max(split_part(name, '-', 2)::int)
  from payments
 where name ~ '^PAG-[0-9]{4,}$'
 group by company_id
on conflict (company_id, series) do update
  set last_number = greatest(folio_counters.last_number, excluded.last_number);
