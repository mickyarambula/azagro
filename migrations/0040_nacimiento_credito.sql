-- 0040: nacimiento del crédito (Decisiones 68 y 69, AUDITORIA.md § 3 grupo A,
-- 17-sep-2026).
--
-- 1) «Sin mora» deja de ser valor por omisión. Hasta hoy `policy_code` nacía
--    en 'NONE' por el default de la columna (0006): "no capturó política" y
--    "eligió Sin mora" eran indistinguibles, y una venta a crédito podía nacer
--    sin mora, sin comisión y sin FEGA sin que nadie lo decidiera. Ahora la
--    política se elige o el documento no nace (`assertSaleTerms`). Mismo
--    patrón que la 0039: quita restricciones, no toca datos ni tipo. Vacío =
--    "sin política capturada" — el estado de cuenta ya marca ese caso y la FI
--    se detiene ahí. Los renglones que ya están en 'NONE' NO se tocan
--    (Decisión 69 c): una migración no decide dinero de nadie. En `invoices`
--    también: FP, NC, FI y ATC no tienen política y ahora lo dicen (vacío) en
--    vez de fingir «Sin mora».
alter table sales_orders alter column policy_code drop default;
alter table sales_orders alter column policy_code drop not null;
alter table invoices alter column policy_code drop default;
alter table invoices alter column policy_code drop not null;

-- 2) Pedidos a Fecha / Cosecha que nacieron con credit_days = 0 aunque tienen
--    plazo financiero (hallazgo #4): `computeDues` los pasaba tal como venían
--    del formulario. Se deriva de sus PROPIAS fechas (credit_due − date), nunca
--    de Ajustes, y solo donde hoy dice 0: un plazo ya capturado no se mueve.
--    Idempotente: la segunda pasada no encuentra filas. Un pedido cancelado
--    no se toca: ya no es de nadie.
update sales_orders
   set credit_days = (credit_due - date)
 where term_kind in ('date', 'harvest')
   and state <> 'cancelled'
   and coalesce(credit_days, 0) = 0
   and credit_due is not null
   and credit_due > date;

-- Lo mismo para las FV de producto ABIERTAS de esos pedidos: el pronto pago
-- bonifica los días no usados de SU plazo, y con 0 tomaba los de Ajustes. La FV
-- lleva los días del PEDIDO (Decisión 69 d: credit_due − fecha del pedido, el
-- mismo número que hereda una FV nueva), no los de su propia fecha. Una FV
-- pagada o revertida no se toca: lo cobrado ya quedó como se cobró. La foto de
-- parámetros (params_snap) y el circuito de esas FV no se reescriben aquí.
update invoices i
   set credit_days = (so.credit_due - so.date)
  from sales_orders so
 where so.id = i.order_id
   and i.kind = 'customer'
   and i.state = 'open'
   and coalesce(i.inv_class, 'product') = 'product'
   and so.term_kind in ('date', 'harvest')
   and coalesce(i.credit_days, 0) = 0
   and so.credit_due is not null
   and so.credit_due > so.date;
