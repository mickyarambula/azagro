-- Contador de folio por serie de kardex (bloque A4, opción C aprobada).
-- Hoy `nextRef` (stock.ts) cuenta TODA la tabla stock_moves de la empresa,
-- así que los siete tipos comparten un solo contador: dentro de cada serie
-- los números saltan, y dos clics simultáneos de tipos distintos pueden
-- producir el mismo número en dos series (radiografía real, 15-sep-2026:
-- scripts/erp-folios-kardex.mjs — 0 movimientos hoy, nada que corregir, pero
-- la semilla se calcula de todos modos desde stock_moves, no a mano, para
-- que funcione igual el día que haya historia).
--
-- Aditiva: tabla nueva, stock_moves no se toca. Nada se renumera: los refs
-- ya emitidos se quedan exactamente como están; esta tabla solo dice desde
-- dónde sigue CADA serie de aquí en adelante. El índice stock_moves_ref_uq
-- (0015) se queda de respaldo.
--
-- Dos comportamientos, a propósito, no un descuido:
-- (a) Una serie sin movimientos previos arranca en 0001 aunque otras series
--     de la misma empresa vayan más altas — cada serie es independiente; ya
--     no hay "el folio 42" compartido entre tipos.
-- (b) El +1 vive DENTRO de la misma transacción que el resto de la
--     operación (nextRef corre con la misma conexión que postStock recibe
--     de withTx). Si esa transacción se revierte, el +1 se revierte con
--     ella: el contador vuelve a donde estaba y el SIGUIENTE pedido
--     reutiliza el mismo número. Es autocorregible, exactamente igual que
--     el count(*) de hoy — nunca se pierde un folio por una operación que
--     nunca pasó. Lo que SÍ cambia es la garantía bajo concurrencia real:
--     dos peticiones simultáneas de la MISMA serie toman el candado de fila
--     de folio_counters una a la vez y nunca pueden llevarse el mismo
--     número (scripts/erp-folio-counters.test.mjs lo fija con N peticiones
--     en paralelo).
create table if not exists folio_counters (
  company_id  integer not null references companies(id) on delete cascade,
  series      text    not null,
  last_number integer not null default 0,
  primary key (company_id, series)
);

-- Semilla: el máximo real por (empresa, serie), leído de los refs que ya
-- existen — no cero a mano. Sobre una base vacía no inserta nada (no hay
-- refs que agrupar); cada serie nace la primera vez que se pide (nextRef la
-- crea sola, en 0). Sobre una base con historia, arranca donde se quedó
-- cada serie, no desde 1.
insert into folio_counters (company_id, series, last_number)
select company_id, split_part(ref, '/', 1), max(split_part(ref, '/', 2)::int)
from stock_moves
where ref ~ '^(REC|ENT|TR|AJ|INI|DEV|REV)/[0-9]{4,}$'
group by company_id, split_part(ref, '/', 1)
on conflict (company_id, series) do update
  set last_number = greatest(folio_counters.last_number, excluded.last_number);
