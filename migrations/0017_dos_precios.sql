-- Dos precios por partida: contado y crédito, cada uno con SU margen.
--
-- Antes había un solo margen por partida (customer_request_lines.margin_*) y
-- la cotización guardaba los dos precios sin decir de qué margen salieron
-- (quote_lines.margin_pct quedó en 0 en todo lo existente). Ahora:
--
--   * La solicitud y la cotización llevan margen contado y margen crédito
--     por separado (modo % o monto fijo, valor % y valor $). Cambiar uno no
--     mueve el otro.
--   * quote_lines.finance_unit guarda el financiamiento por unidad que quedó
--     DENTRO del precio a crédito al cotizar, para poder mostrar costo ·
--     financiamiento · utilidad sin volver a calcular con tasas de hoy.
--   * quotes.accepted_offer / sales_orders.accepted_offer: cuál de los dos
--     precios aceptó el cliente. El pedido hereda ese precio y ese margen.
--   * customer_requests.credit_days / currency / fx_rate: el plazo, la moneda
--     y el tipo de cambio que se capturan en la solicitud se guardan (antes
--     vivían solo en la pantalla y se perdían al salir).
--
-- Todas las columnas nuevas admiten nulo y NO se rellenan aquí: nulo = "no
-- capturado con el esquema nuevo". Qué hacer con las filas que ya existían se
-- decide aparte (ver HANDOFF); el código sabe leer nulo y caer al dato viejo.
-- La fórmula del financiamiento no cambia.

-- customer_requests y customer_request_lines nacieron en código (ensure() de
-- src/lib/erp/requests.ts), no en una migración. En una base nueva (PGLite de
-- preview, o un Neon recién creado) todavía no existen cuando corre este
-- archivo, así que se crean aquí con la misma definición base; en producción
-- ya existen y esto no hace nada.
create table if not exists customer_requests (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  name text not null,
  partner_id integer not null references partners(id),
  date date not null default current_date,
  delivery_mode text not null default 'campo',
  delivery_to text not null default '',
  notes text not null default '',
  state text not null default 'open',
  quote_id integer,
  rfq_id integer
);
create table if not exists customer_request_lines (
  id serial primary key,
  request_id integer not null references customer_requests(id) on delete cascade,
  product_id integer not null references products(id),
  qty numeric(14,3) not null,
  uom text not null default '',
  cost numeric(14,4) not null default 0,
  freight numeric(14,4) not null default 0,
  supplier_id integer references partners(id)
);

alter table customer_requests add column if not exists credit_days integer;
alter table customer_requests add column if not exists currency text;
alter table customer_requests add column if not exists fx_rate numeric(12,4);

alter table customer_request_lines add column if not exists margin_cash_mode text;
alter table customer_request_lines add column if not exists margin_cash_pct numeric(8,4);
alter table customer_request_lines add column if not exists margin_cash_nominal numeric(14,4);
alter table customer_request_lines add column if not exists margin_credit_mode text;
alter table customer_request_lines add column if not exists margin_credit_pct numeric(8,4);
alter table customer_request_lines add column if not exists margin_credit_nominal numeric(14,4);

alter table quote_lines add column if not exists margin_cash_mode text;
alter table quote_lines add column if not exists margin_cash_pct numeric(8,4);
alter table quote_lines add column if not exists margin_cash_nominal numeric(14,4);
alter table quote_lines add column if not exists margin_credit_mode text;
alter table quote_lines add column if not exists margin_credit_pct numeric(8,4);
alter table quote_lines add column if not exists margin_credit_nominal numeric(14,4);
alter table quote_lines add column if not exists finance_unit numeric(14,4);

alter table quotes add column if not exists accepted_offer text;
alter table sales_orders add column if not exists accepted_offer text;
