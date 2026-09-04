-- Comisión y FEGA capturados en las tres políticas de cobro (3-sep-2026).
--
-- La 0021 dejó los dos interruptores nacidos SIN capturar a propósito: el
-- sistema no inventa un valor que decida dinero. Esta migración no inventa
-- nada — escribe la decisión del dueño, tomada el 3-sep-2026 sobre las tres
-- políticas que existen (la app no permite crear más):
--
--   GRUPO_SL  comisión sí · FEGA sí   — su etiqueta ya decía "spread y comisión
--                                       + FEGA"; es el caso del Excel de Grupo SL.
--   ESTANDAR  comisión no · FEGA no   — su etiqueta solo dice "TIIE + spread".
--   NONE      comisión no · FEGA no   — "Sin mora": no cobra nada.
--
-- Solo toca las que siguen sin capturar: si alguien ya las contestó en
-- Ajustes → Políticas de cobro, su captura manda y no se pisa.
update credit_policies set charge_commission = true, charge_fega = true
where code = 'GRUPO_SL' and (charge_commission is null or charge_fega is null);

update credit_policies set charge_commission = false, charge_fega = false
where code in ('ESTANDAR', 'NONE') and (charge_commission is null or charge_fega is null);
