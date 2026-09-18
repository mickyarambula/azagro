-- 0045 — El esquema se declara aquí, no en el código (18-sep-2026).
--
-- Esta migración declara CUARENTA columnas. VEINTICUATRO de ellas existían
-- ÚNICAMENTE porque algún camino del código corría `alter table ... add column
-- if not exists` en tiempo de ejecución, antes de usarlas: no estaban en
-- ninguna migración. Las otras dieciséis (los `margin_cash_*` / `margin_credit_*`
-- de `quote_lines` y `customer_request_lines`) ya estaban declaradas en 0017 y
-- 0018; se repiten aquí para que el grupo completo se lea en un solo lugar, y
-- por `if not exists` no cambian nada. Entre las veinticuatro que faltaban:
--
--   · purchase_orders.so_id      — la ÚNICA liga entre una compra y el pedido
--                                  de venta que la motivó. De ella cuelgan el
--                                  costo del P&L, el spread cambiario y todo
--                                  lo que este bloque necesita.
--   · purchase_orders.fulfill_kind — inventario vs. directo/brokeraje, que
--                                  decide si la orden se recibe en bodega y
--                                  cuándo nace la deuda (Decisiones 14 y 29).
--   · invoices.created_by        — quién emitió cada factura (trazabilidad).
--
-- Consecuencias de que vivieran así: el esquema no se podía leer en ningún
-- lado; una tabla nueva dependía de que se ejecutara el camino correcto antes
-- de la primera lectura; y sobre todo, `computeDealPnl` corría SIETE `alter
-- table` por llamada y el Panorama la llama hasta 500 veces por carga — tres
-- mil quinientas sentencias de esquema para dibujar una tabla.
--
-- Esta migración es declarativa: `if not exists` en todo, así que en una base
-- donde el código ya las creó no cambia nada, y en una base nueva quedan
-- puestas antes de la primera consulta. Lo que sí agrega son los ÍNDICES: el
-- camino pedido → compra → factura del proveedor se recorre en bucle y hasta
-- hoy no tenía por dónde.

-- --- Ajustes de la empresa: alertas y correo ---------------------------------
alter table company_settings add column if not exists alert_days_cxc integer not null default 7;
alter table company_settings add column if not exists alert_days_cxp integer not null default 7;
alter table company_settings add column if not exists alert_email text not null default '';
alter table company_settings add column if not exists alert_email_on boolean not null default true;
alter table company_settings add column if not exists resend_key text not null default '';
alter table company_settings add column if not exists seeded_at timestamptz;

-- --- Solicitud del cliente ---------------------------------------------------
alter table customer_requests add column if not exists location_id integer;
alter table customer_request_lines add column if not exists pick_reason text not null default '';
alter table customer_request_lines add column if not exists margin_cash_mode text;
alter table customer_request_lines add column if not exists margin_cash_pct numeric(8,4);
alter table customer_request_lines add column if not exists margin_cash_nominal numeric(14,4);
alter table customer_request_lines add column if not exists margin_cash_source text;
alter table customer_request_lines add column if not exists margin_credit_mode text;
alter table customer_request_lines add column if not exists margin_credit_pct numeric(8,4);
alter table customer_request_lines add column if not exists margin_credit_nominal numeric(14,4);
alter table customer_request_lines add column if not exists margin_credit_source text;

-- --- Cotización --------------------------------------------------------------
alter table quotes add column if not exists request_id integer;
alter table quote_lines add column if not exists margin_cash_mode text;
alter table quote_lines add column if not exists margin_cash_pct numeric(8,4);
alter table quote_lines add column if not exists margin_cash_nominal numeric(14,4);
alter table quote_lines add column if not exists margin_cash_source text;
alter table quote_lines add column if not exists margin_credit_mode text;
alter table quote_lines add column if not exists margin_credit_pct numeric(8,4);
alter table quote_lines add column if not exists margin_credit_nominal numeric(14,4);
alter table quote_lines add column if not exists margin_credit_source text;

-- --- Cotización a proveedores ------------------------------------------------
alter table vendor_rfqs add column if not exists location_id integer;
alter table vendor_rfqs add column if not exists purpose text not null default 'sale';
alter table vendor_rfqs add column if not exists request_id integer;

-- --- Orden de compra: la liga con el pedido y el tipo de surtido -------------
alter table purchase_orders add column if not exists so_id integer;
alter table purchase_orders add column if not exists rfq_id integer;
alter table purchase_orders add column if not exists fulfill_kind text not null default 'inventory';

-- --- Pedido de venta: entrega y recepción ------------------------------------
alter table sales_orders add column if not exists ship_mode text not null default 'azagro';
alter table sales_orders add column if not exists fletero text not null default '';
alter table sales_orders add column if not exists placas text not null default '';
alter table sales_orders add column if not exists received_at date;

-- --- Facturas: quién la hizo y con qué números -------------------------------
alter table invoices add column if not exists created_by text not null default '';
alter table invoices add column if not exists calc text not null default '';
alter table invoices add column if not exists params_snap text not null default '';
alter table invoices add column if not exists int_part numeric(14,2) not null default 0;
alter table invoices add column if not exists fega_part numeric(14,2) not null default 0;

-- --- Índices del camino pedido → compra → factura del proveedor --------------
-- `purchase_orders.so_id` se recorre una vez por pedido dentro del bucle del
-- Panorama (hasta 500 por carga) y en cada tarjeta de pedido.
create index if not exists po_so_idx on purchase_orders (company_id, so_id);
-- La factura del proveedor se amarra a su orden POR TEXTO (`invoices.origin` =
-- `purchase_orders.name`, el mismo amarre de la Decisión 42). El folio es único
-- por empresa (`purchase_orders_folio_uq`, migración 0015), así que el texto es
-- llave de verdad; lo que faltaba era el índice para poder caminarla.
create index if not exists inv_origin_idx on invoices (company_id, kind, origin);
