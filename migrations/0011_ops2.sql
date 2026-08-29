-- Cotización contado/crédito, renegociación, guía fletero, entregas OC.

alter table quotes add column if not exists price_offer text not null default 'both';
alter table quotes add column if not exists revision integer not null default 1;

alter table quote_lines add column if not exists cash_price numeric(14,4) not null default 0;
alter table quote_lines add column if not exists credit_price numeric(14,4) not null default 0;

alter table sales_orders add column if not exists chofer text not null default '';
alter table sales_orders add column if not exists vehicle_brand text not null default '';

alter table purchase_lines add column if not exists deliver_to text not null default '';
