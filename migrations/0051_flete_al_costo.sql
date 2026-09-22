-- 0051 — El flete de entrada entra al costo de la mercancía (Decisiones 100 y
-- 101, pieza 2 del bloque del flete, 21-sep-2026).
--
-- La 0050 capturó lo que costó traer un viaje. Ésta lo mete al costo con el
-- que la mercancía entra al kardex, y **apaga la segunda suma en el mismo
-- cambio** para que no se cuente dos veces: la cotización toma el costo del
-- inventario y le vuelve a sumar el flete, así que hacerlo a medias subiría el
-- precio $23.53 por saco en un camión de 100 sacos a $500 con $2,000 de flete
-- —$2,352.94 cobrados de más al cliente— y la utilidad del pedido saldría
-- $2,000 por debajo de la real.
--
-- Lo que NO hace, a propósito: corregir el costo de mercancía YA recibida. El
-- flete que llega tarde pide un movimiento de kardex de solo valor, y el
-- promedio no se recalcula hacia atrás (regla 2). Es otro bloque.
--
-- Solo aditiva: ni un drop, ni un cambio de tipo, ni un not null sin default
-- sobre tabla con datos. Ninguna tabla nueva, así que el plan de borrado de
-- pruebas no cambia.

-- 1. LA DESCOMPOSICIÓN del costo con el que entró. Sin esto, «promedio $520»
--    no se puede explicar (Decisión 20: el promedio se enseña con su número) y
--    la reversa no sabría qué está sacando.
--    NULLABLE a propósito: null = movimiento anterior a esta pieza, o entrada
--    que no lleva flete (devolución, ajuste, traslado, corte). Vacío no es cero.
alter table stock_moves  add column if not exists freight_unit numeric(14,4);

-- 2. La misma descomposición, promediada por el MISMO promedio móvil que el
--    costo, y colapsada al catálogo igual que `products.cost`.
alter table stock_quants add column if not exists avg_freight     numeric(14,4) not null default 0;
alter table products     add column if not exists freight_in_cost numeric(14,4) not null default 0;

-- 3. EL APAGADOR. Cuánto flete de entrada ya venía dentro del costo que esta
--    partida congeló. Tiene que viajar CON el número: la etiqueta de dónde
--    salió el costo (`cost_source`) no se guarda en ninguna tabla y, donde se
--    calcula, miente en las dos direcciones — dice «kardex» de un precio de
--    proveedor y «cotización» de un promedio del kardex.
--    NULL = partida anterior a esta pieza: su costo nunca llevó flete adentro,
--    que es un hecho, no un valor por omisión.
alter table quote_lines add column if not exists cost_freight_in numeric(14,4);

-- 4. El peso por unidad: lo que de verdad consume el camión. NULLABLE (regla
--    9): sin peso capturado, un camión de unidades MEZCLADAS no se reparte por
--    cantidad —eso sería inventar que un litro pesa lo que una tonelada—, se
--    detiene y lo pide. Se captura solo cuando hace falta, no de entrada.
alter table products add column if not exists unit_weight numeric(14,4);
alter table products add column if not exists weight_uom  text;

-- 5. Lo que se espera pagar por traer ESTA orden, capturado por quien ve
--    costos ANTES de recibir (Decisión 101). Quien recibe es el almacén, que
--    por la regla 10 no ve costos: sin esto, o el almacén no puede recibir
--    nunca, o el flete llega cuando ya no puede entrar al costo.
alter table purchase_orders add column if not exists planned_freight  numeric(14,2);
alter table purchase_orders add column if not exists planned_handling numeric(14,2);

-- 6. Qué se capitalizó de este viaje y cuándo. Sin esto, un viaje capturado un
--    día DESPUÉS de recibir se ve idéntico a uno que sí entró al costo, y
--    corregirlo seguiría pisando un número que ya no puede llegar al kardex.
alter table trip_costs add column if not exists capitalized_at     timestamptz;
alter table trip_costs add column if not exists capitalized_amount numeric(14,2);

-- 7. `trip_costs` nació como la única tabla de dinero sin moneda ni tipo de
--    cambio. US$2,000 tecleados ahí entrarían como $2,000 pesos y destruirían
--    el costo del inventario. Se declara; sin TC real, un viaje en dólares se
--    detiene (regla 9, igual que la OC en dólares).
alter table trip_costs add column if not exists currency text not null default 'MXN';
alter table trip_costs add column if not exists fx_rate  numeric(14,4);
