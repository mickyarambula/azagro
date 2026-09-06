-- PASO 1 del catálogo de circuitos (5-sep-2026): el circuito entra como
-- ETIQUETA. Cada documento guarda por dónde corre su financiamiento, lo hereda
-- por la cadena (SOL → COT → PV → FV → FI/NC/ATC) y lo muestra. El motor
-- (precio, mora, reportes) sigue leyendo Ajustes exactamente igual que antes:
-- eso es el paso 3. Ver DECISIONES.md, ESTADO.md, DISENO_FINANCIAMIENTO.md.
--
-- Nulo permitido: todavía no hay selector en pantalla (paso 2). Lo que ya
-- existe se asigna con la regla decidida por la dirección:
--   plazo 0 (días)                → CONTADO
--   todo lo demás, corte incluido → ASR (circuito de doble facturación, vigente)
--   FI, ATC y NC                  → el circuito de su documento de origen
-- route_kind NO decide nada aquí: es logística (bodega propia, directo,
-- entrega vía ASR), no financiamiento. Las facturas de proveedor (FP) no
-- llevan circuito.

alter table customer_requests add column if not exists circuit_code text;
alter table quotes add column if not exists circuit_code text;
alter table sales_orders add column if not exists circuit_code text;
alter table invoices add column if not exists circuit_code text;

update customer_requests
set circuit_code = case when coalesce(credit_days, 0) > 0 then 'ASR' else 'CONTADO' end
where circuit_code is null;

update quotes
set circuit_code = case when coalesce(credit_days, 0) > 0 then 'ASR' else 'CONTADO' end
where circuit_code is null;

update sales_orders
set circuit_code = case when coalesce(credit_days, 0) > 0 then 'ASR' else 'CONTADO' end
where circuit_code is null;

-- Corte de Compaq: todo al circuito ASR, sin mirar el plazo.
update invoices
set circuit_code = 'ASR'
where circuit_code is null and kind = 'customer' and origin = 'Corte Compaq';

-- Notas de crédito (producto, importe negativo): el circuito de su pedido.
update invoices i
set circuit_code = so.circuit_code
from sales_orders so
where i.circuit_code is null and i.kind = 'customer'
  and coalesce(i.inv_class, 'product') = 'product' and i.amount < 0
  and i.order_id = so.id and so.circuit_code is not null;

-- Facturas de venta: por su propio plazo.
update invoices
set circuit_code = case when coalesce(credit_days, 0) > 0 then 'ASR' else 'CONTADO' end
where circuit_code is null and kind = 'customer' and coalesce(inv_class, 'product') = 'product';

-- FI (mora) y ATC (ajuste de tipo de cambio): el circuito de la factura de
-- origen, que se reconoce por el texto de origen que escribe el sistema
-- ("Mora FV-0001" / "Ajuste TC FV-0001").
update invoices i
set circuit_code = o.circuit_code
from invoices o
where i.circuit_code is null and i.kind = 'customer'
  and coalesce(i.inv_class, 'product') in ('interest', 'fx')
  and o.company_id = i.company_id and o.kind = 'customer'
  and coalesce(o.inv_class, 'product') = 'product'
  and i.origin in ('Mora ' || o.name, 'Ajuste TC ' || o.name)
  and o.circuit_code is not null;
