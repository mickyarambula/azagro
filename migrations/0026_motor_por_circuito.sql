-- PASO 3 del catálogo de circuitos (5-sep-2026): el motor lee el circuito.
-- Ver DECISIONES.md (Decisiones 1, 4, 6), ESTADO.md § 6 y § 7,
-- DISENO_FINANCIAMIENTO.md § 5.
--
-- 1. La comisión de apertura se CONGELA en la cotización, junto a la TIIE y
--    el spread que ya lo estaban (cierra el hallazgo de ESTADO.md § 6: hoy
--    una cotización vieja cambiaba de precio al revisarla si alguien movía la
--    comisión en Ajustes). Lo existente se congela con el valor que la lectura
--    en vivo habría dado: la comisión del Circuito ASR del catálogo, que la
--    0024 copió de Ajustes. Así todo lo que corre por ASR sale idéntico al
--    centavo.
-- 2. Las dos tasas del lineal (tasa de costo / tasa de cobro, Decisión 1)
--    también se congelan en la cotización. Nulas en todo lo existente: nada
--    ha corrido por el lineal.
-- 3. Lo que el financiador desembolsa por partida (disbursed_unit): en el
--    lineal es la factura de Azagro a Santa Rosa (costo + margen). Nulo en lo
--    existente: se escribe al cotizar de aquí en adelante.
-- 4. "Comisión ASR" sale de Ajustes: un solo lugar decide cada número, y ese
--    lugar es el catálogo de circuitos. Antes de tirar la columna se vuelve a
--    copiar por si algún catálogo quedó sin ella.
-- 5. Línea Santa Rosa: la comisión es 0 ESCRITA (Decisión 6: la línea no la
--    cobra), no "sin capturar". Un nulo en un circuito que financia significa
--    "sin capturar" y el motor se detiene: no se inventa un cero.

alter table quotes add column if not exists commission_rate numeric(8,6);
alter table quotes add column if not exists cost_rate numeric(8,6);
alter table quotes add column if not exists collection_rate numeric(8,6);
alter table quote_lines add column if not exists disbursed_unit numeric(14,4);

update credit_circuits c
set commission_rate = cs.asr_commission
from company_settings cs
where cs.company_id = c.company_id and c.code = 'ASR'
  and c.commission_rate is null and cs.asr_commission is not null;

update credit_circuits
set commission_rate = 0
where code = 'SANTA_ROSA' and commission_rate is null;

update quotes q
set commission_rate = c.commission_rate
from credit_circuits c
where c.company_id = q.company_id and c.code = 'ASR'
  and q.commission_rate is null and c.commission_rate is not null;

alter table company_settings drop column if exists asr_commission;
