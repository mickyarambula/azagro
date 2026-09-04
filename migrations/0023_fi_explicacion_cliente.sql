-- La factura de intereses guarda, aparte de su cálculo interno (`calc`), lo que
-- se le explica al CLIENTE en el papel (4-sep-2026): la misma cuenta con
-- fórmula y cifras, sin decir de dónde sale la tasa ni qué política aplica.
-- Se escribe el día que se emite, para que se imprima igual aunque después
-- cambien las tasas. Las FI anteriores quedan vacías y el papel imprime solo
-- los importes que sí tienen guardados (interés y comisión/FEGA).
alter table invoices add column if not exists calc_client text not null default '';
