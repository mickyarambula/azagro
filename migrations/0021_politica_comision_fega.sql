-- Comisión y FEGA opcionales por política de cobro (3-sep-2026).
--
-- La política de mora ya se elige por documento (y por omisión según el grupo
-- del cliente). Faltaba que esa política pudiera INCLUIR O NO la comisión y el
-- FEGA, porque se negocia distinto con cada cliente.
--
-- Dos interruptores por política: cobra comisión sí/no, cobra FEGA sí/no. Los
-- porcentajes siguen viniendo de Ajustes (fega_rate y la comisión que va
-- dentro, fega_commission): esto solo dice cuál de las dos mitades se cobra.
--
-- NACEN VACÍOS A PROPÓSITO. Igual que las tasas y los plazos de la migración
-- 0019: el sistema no inventa un valor por omisión que decida dinero. Mientras
-- una política no tenga capturados sus dos interruptores, el estado de cuenta
-- marca esos renglones y la factura de intereses se detiene con aviso. Se
-- capturan en Ajustes → Políticas de cobro, y cada cambio queda en bitácora.
alter table credit_policies add column if not exists charge_commission boolean;
alter table credit_policies add column if not exists charge_fega boolean;
