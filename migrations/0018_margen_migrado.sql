-- Márgenes de las partidas que ya existían, y muerte del 12% por omisión.
--
-- 1) ORIGEN DEL MARGEN. margin_cash_source / margin_credit_source dicen de
--    dónde salió el número guardado:
--      'captura'   — alguien lo escribió (el margen, o el precio del que se
--                    despejó).
--      'migracion' — lo copió este archivo desde el margen único anterior.
--    Así un margen heredado nunca se confunde con uno elegido a mano.
--
-- 2) COPIA (decisión del dueño, 2-sep-2026). El margen único anterior de cada
--    partida de solicitud se copia TAL CUAL a las dos columnas nuevas
--    (contado y crédito) y queda marcado 'migracion'. Ojo: la columna vieja
--    traía `default 12`, así que las partidas que nadie tocó traen 12% — se
--    copian igual, pero marcadas, para que se vean y se corrijan.
--
-- 3) EN LAS COTIZACIONES solo se copia si hay un margen mayor que cero. La
--    columna vieja de quote_lines es `default 0` y en todo lo existente quedó
--    en 0: copiar ese 0 sería afirmar "esta venta no dejó utilidad", que es
--    distinto de "no sabemos cuál fue el margen". Las de 0 quedan sin margen.
--
-- 4) SE MATA EL 12%. La columna vieja deja de tener default y deja de ser NOT
--    NULL: una partida nueva nace SIN margen y la pantalla dice "sin margen"
--    hasta que alguien capture uno. Un margen por omisión escrito en el código
--    decide la utilidad sin que nadie lo haya elegido — mismo criterio que el
--    costo 0.

-- El margen único anterior nació en código (ensure() de requests.ts), no en una
-- migración: en una base nueva todavía no existe. Se declara aquí ya sin
-- default y sin NOT NULL, que es como debe quedar (punto 4).
alter table customer_request_lines add column if not exists margin_mode text;
alter table customer_request_lines add column if not exists margin_pct numeric(8,4);
alter table customer_request_lines add column if not exists margin_nominal numeric(14,4);

alter table customer_request_lines add column if not exists margin_cash_source text;
alter table customer_request_lines add column if not exists margin_credit_source text;
alter table quote_lines add column if not exists margin_cash_source text;
alter table quote_lines add column if not exists margin_credit_source text;

-- (2) Solicitudes: copia literal del margen único anterior a las dos columnas.
update customer_request_lines
set margin_cash_mode = coalesce(margin_mode, 'pct'),
    margin_cash_pct = margin_pct,
    margin_cash_nominal = coalesce(margin_nominal, 0),
    margin_cash_source = 'migracion'
where margin_cash_mode is null
  and (margin_pct is not null or margin_nominal is not null);

update customer_request_lines
set margin_credit_mode = coalesce(margin_mode, 'pct'),
    margin_credit_pct = margin_pct,
    margin_credit_nominal = coalesce(margin_nominal, 0),
    margin_credit_source = 'migracion'
where margin_credit_mode is null
  and (margin_pct is not null or margin_nominal is not null);

-- (3) Cotizaciones: solo donde de verdad hay un margen capturado (> 0).
update quote_lines
set margin_cash_mode = 'pct',
    margin_cash_pct = margin_pct,
    margin_cash_nominal = round(cost * margin_pct / 100, 4),
    margin_cash_source = 'migracion'
where margin_cash_mode is null and coalesce(margin_pct, 0) > 0;

update quote_lines
set margin_credit_mode = 'pct',
    margin_credit_pct = margin_pct,
    margin_credit_nominal = round(cost * margin_pct / 100, 4),
    margin_credit_source = 'migracion'
where margin_credit_mode is null and coalesce(margin_pct, 0) > 0;

-- (4) Nada de margen por omisión de aquí en adelante.
alter table customer_request_lines alter column margin_pct drop default;
alter table customer_request_lines alter column margin_pct drop not null;
alter table customer_request_lines alter column margin_mode drop default;
alter table customer_request_lines alter column margin_mode drop not null;
alter table customer_request_lines alter column margin_nominal drop default;
alter table customer_request_lines alter column margin_nominal drop not null;
