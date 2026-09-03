-- Sin valores por omisión de negocio en la base (regla del dueño, 2-sep-2026):
-- todo número de negocio se lee de Ajustes o de su tabla; si no está, el
-- sistema se detiene y avisa. Nunca inventa un número.
--
-- 1) MÁRGENES DEL 12%. La columna vieja margin_pct traía `default 12` y la
--    0018 copió ese 12 a las dos columnas nuevas marcado 'migracion'. Nadie
--    eligió ese número: esas partidas pasan a "sin margen". Se identifican por
--    la firma exacta del default (origen migración, modo %, 12 exacto, sin
--    nominal). Un margen capturado a mano (otro %, nominal, u origen
--    'captura') no se toca.
update customer_request_lines
set margin_cash_mode = null, margin_cash_pct = null, margin_cash_nominal = null, margin_cash_source = null
where margin_cash_source = 'migracion'
  and margin_cash_mode = 'pct'
  and margin_cash_pct = 12
  and coalesce(margin_cash_nominal, 0) = 0;

update customer_request_lines
set margin_credit_mode = null, margin_credit_pct = null, margin_credit_nominal = null, margin_credit_source = null
where margin_credit_source = 'migracion'
  and margin_credit_mode = 'pct'
  and margin_credit_pct = 12
  and coalesce(margin_credit_nominal, 0) = 0;

-- El margen único viejo (columna margin_pct) también traía el 12 del default:
-- se limpia para que no lo vuelva a copiar nadie.
update customer_request_lines
set margin_pct = null, margin_mode = null, margin_nominal = null
where margin_pct = 12 and coalesce(margin_nominal, 0) = 0;

-- 2) AJUSTES (company_settings). Los parámetros de cartera dejan de tener
--    default y dejan de ser NOT NULL: un renglón nuevo nace vacío y la
--    pantalla de Ajustes pide capturarlos. Los valores ya guardados se
--    conservan tal cual. La "TIIE por omisión" desaparece: la TIIE siempre
--    sale de la tabla tiie_rates (renglón vigente en la fecha que toque).
alter table company_settings add column if not exists early_pay_days integer;
alter table company_settings add column if not exists fega_commission numeric(8,4);
alter table company_settings alter column credit_days drop default;
alter table company_settings alter column credit_days drop not null;
alter table company_settings alter column invoice_days drop default;
alter table company_settings alter column invoice_days drop not null;
alter table company_settings alter column fega_rate drop default;
alter table company_settings alter column fega_rate drop not null;
alter table company_settings alter column collection_spread drop default;
alter table company_settings alter column collection_spread drop not null;
alter table company_settings alter column asr_commission drop default;
alter table company_settings alter column asr_commission drop not null;
alter table company_settings alter column asr_spread drop default;
alter table company_settings alter column asr_spread drop not null;
alter table company_settings alter column early_pay_days drop default;
alter table company_settings alter column early_pay_days drop not null;
alter table company_settings drop column if exists default_tiie;

-- 3) PLAZO DE PAGO DEL SOCIO. `default 30` era un plazo que nadie eligió: se
--    quita. Sigue siendo NOT NULL: quien da de alta un socio captura su plazo
--    (0 = contado).
alter table partners alter column payment_days drop default;
