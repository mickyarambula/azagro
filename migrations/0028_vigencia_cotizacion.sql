-- Recotizar (hallazgo 4, SESIÓN D, 7-sep-2026): la vigencia de la cotización
-- nace de Ajustes, no del código (regla 9 — nunca un número de negocio
-- escrito en src/). Sin capturar, la pantalla se detiene igual que sin
-- margen o sin TIIE; el valor se copia a quotes.valid_until al cotizar y de
-- ahí nunca se vuelve a leer Ajustes (misma foto congelada que TIIE/spread).
alter table company_settings add column if not exists quote_validity_days integer;
