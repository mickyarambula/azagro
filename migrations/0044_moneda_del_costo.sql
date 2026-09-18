-- 0044_moneda_del_costo.sql — Decisiones 76-81 (17-sep-2026), bloque A.1 (MODELO-NEGOCIO.md § 11-12).
-- Solo aditivo: columnas nullable. Vacío = "sin declarar", nunca 0 ni 'MXN' por omisión (regla 9).

-- D76: el costo lleva moneda y TC (la moneda del costo puede diferir de la del documento que lo usa).
-- cost_currency = moneda en que el proveedor dio el costo; cost_fx = TC USD→MXN usado para ese costo (solo si USD).
alter table quote_lines            add column if not exists cost_currency text;
alter table quote_lines            add column if not exists cost_fx numeric(12,6);
alter table customer_request_lines add column if not exists cost_currency text;
alter table customer_request_lines add column if not exists cost_fx numeric(12,6);
-- El último precio por socio+producto declara su moneda (fecha y vigencia son de § 10, no de aquí).
alter table partner_products       add column if not exists currency text;
-- vendor_rfqs.currency nacía por código (rfq.ts); pasa a migración con el mismo default que quotes y purchase_orders.
alter table vendor_rfqs            add column if not exists currency text not null default 'MXN';

-- D77: el costo de referencia se captura declarando moneda; products.ref_cost se guarda en pesos y aquí queda el rastro.
alter table products               add column if not exists ref_cost_currency text;
alter table products               add column if not exists ref_cost_fx numeric(12,6);

-- D81: compra de dólares y transferencias entre monedas, con TC y las dos patas ligadas.
alter table bank_moves             add column if not exists fx_rate numeric(12,6);
alter table bank_moves             add column if not exists amount_fx numeric(14,2);
alter table bank_moves             add column if not exists pair_id integer references bank_moves(id);

-- D79: backfill de las FP en USD que nacieron en dólares crudos. Solo las que tienen TC real (fx_agreed <> 1);
-- las del corte no se tocan (ya están en pesos, Decisión 70, cutover_key no nulo).
-- El saldo sigue la única regla del sistema (refreshInvoiceResidual: importe − abonos): los abonos previos a
-- una FP en dólares se aplicaban 1:1 y son pesos reales del banco, así que no se convierten — se restan tal cual.
update invoices
   set amount_fx = amount,
       amount    = round(amount * fx_agreed, 2),
       residual  = round(amount * fx_agreed, 2) - (amount - residual)
 where kind = 'supplier' and currency = 'USD' and cutover_key is null
   and coalesce(amount_fx, 0) = 0 and fx_agreed > 0 and fx_agreed <> 1;

-- Las FP USD con fx_agreed = 1 (nacidas del default) no tienen TC real: se conserva el original en amount_fx
-- y quedan marcadas "sin TC" por su fx_agreed = 1 hasta que alguien lo capture en la OC.
update invoices set amount_fx = amount
 where kind = 'supplier' and currency = 'USD' and cutover_key is null
   and coalesce(amount_fx, 0) = 0 and fx_agreed = 1;
