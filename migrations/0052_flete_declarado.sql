-- 0052 — El flete al cliente se DECLARA, o el documento no nace
-- (Decisión 102, pieza 3 del bloque del flete, 22-sep-2026).
--
-- La regla del dueño del 20-sep: «el flete no se estima, debes tener
-- conocimiento del costo para poder cotizar porque si no puede variar
-- negativamente y afectar el margen». Hoy el campo nace en CERO y nadie tiene
-- que decir de dónde salió ese cero: un valor por omisión que decide dinero,
-- justo lo que prohíbe la regla 9. El precio se arma sin flete, el margen se
-- ve completo, y el camión llega igual de caro.
--
-- El patrón es el de las Decisiones 67 (plazo del proveedor) y 69 (política de
-- cobro): **vacío no es cero**. Un cero se teclea a propósito, y cuando de
-- verdad no hay flete que cobrar se dice por qué.
--
-- Solo aditiva. Lo ya capturado NO se toca: un cero viejo se queda como estaba
-- y su documento sigue naciendo, igual que hicieron las migraciones 0039 y
-- 0040 con el plazo y la política.

-- 1. De dónde salió el flete de esta partida. NULL = sin declarar, que es lo
--    que son todas las partidas anteriores a esta pieza.
--      'cobrado'   → se le cobra al cliente; el importe está en `freight`
--      'recoge'    → el cliente lo recoge en bodega: cero a propósito
--      'proveedor' → viene puesto por el proveedor: cero a propósito
alter table customer_request_lines add column if not exists freight_mode text;
alter table quote_lines            add column if not exists freight_mode text;

-- 2. UNA VENTA DIRECTA NO TENÍA DÓNDE GUARDARLO. `sales_lines` nunca tuvo
--    flete: la utilidad lo buscaba en la cotización, por producto. Un pedido
--    que nace sin cotización —venta directa, u orden de compra del cliente
--    convertida— tenía flete CERO para siempre, sin que nadie lo dijera.
--    Nullable: vacío = este pedido nació antes de la pieza 3 y su flete sigue
--    leyéndose de la cotización, como siempre.
alter table sales_lines add column if not exists freight      numeric(14,4);
alter table sales_lines add column if not exists freight_mode text;
