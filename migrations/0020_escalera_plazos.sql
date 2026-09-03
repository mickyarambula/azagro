-- Escalera de plazos de la cotización interna (3-sep-2026).
--
-- La hoja real de cotización de la dirección tiene seis columnas de precio:
-- contado, 30, 60, 90, 120 y 150 días. La pantalla interna (solicitud y panel
-- de la cotización) muestra esa escalera completa por partida, con precio,
-- financiamiento y utilidad por columna. Al cliente le siguen llegando SOLO
-- dos precios: contado y el del plazo acordado.
--
-- Los plazos de la escalera se leen de Ajustes (company_settings.quote_terms,
-- lista de días separados por coma; 0 = contado) y se editan ahí. Esta es la
-- lista inicial que pidió el dueño; es una lista de COLUMNAS a mostrar, no un
-- número que decida dinero: cada columna se calcula con el margen capturado,
-- la TIIE de la tabla y el spread/comisión de Ajustes. Por eso sí lleva valor
-- inicial, a diferencia de las tasas y plazos de cartera (migración 0019).
alter table company_settings add column if not exists quote_terms text;
alter table company_settings alter column quote_terms set default '0,30,60,90,120,150';
update company_settings set quote_terms = '0,30,60,90,120,150' where quote_terms is null;
