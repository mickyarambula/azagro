-- 0050 — Lo que costó traer un viaje (Decisión 100, 21-sep-2026).

-- Un renglón por VIAJE: lo que se comprometió pagar por traer esa mercancía.
-- Se captura al recibir, que es cuando se sabe (el fletero ya dijo su precio
-- antes de cargar — la regla del dueño: el flete no se estima).
--
-- Por qué tabla nueva y no una columna en la orden de compra: una orden puede
-- llegar en tres camiones, y cada camión tiene su costo. La llave es el folio
-- del evento de recepción (RCP/000N), que el sistema ya mina desde el bloque
-- de parciales; amarre por texto, como la Decisión 42, y el folio es único por
-- empresa.
--
-- Por qué no reusar `expenses`: un gasto es dinero que YA salió (y si es de
-- contado, nace con su movimiento de banco). Esto es un compromiso, que es
-- otra cosa. Es la misma forma que ya probó la Decisión 99: lo comprometido
-- vive en el documento, lo pagado en el gasto, y lo pagado manda.
create table if not exists trip_costs (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  event_ref text not null,
  po_id integer references purchase_orders(id) on delete cascade,
  -- El fletero. Opcional: a veces es el mismo proveedor quien lo trae.
  partner_id integer references partners(id),
  -- NULLABLE a propósito: vacío NO es cero (Decisiones 64 y 67). Un viaje sin
  -- flete capturado no es un viaje gratis.
  freight numeric(14,2),
  -- Las maniobras: los cargadores de la descarga. Van aquí y no aparte porque
  -- son parte del mismo costo de traerla (Decisión 100).
  handling numeric(14,2),
  -- Nullable, como los importes: «no se mandó» tiene que poder distinguirse de
  -- «se borró». Una puerta que no captura la nota no puede borrar la que otra
  -- escribió. Se lee siempre con coalesce(notes,'').
  notes text,
  created_by text not null default '',
  created_at timestamptz not null default now(),
  unique (company_id, event_ref)
);

create index if not exists trip_po_idx on trip_costs (company_id, po_id);

-- El gasto PAGADO apunta al mismo viaje, para poder compararlo contra lo
-- comprometido. Vacío = un gasto que no pertenece a ningún viaje, que es lo
-- que son todos los que ya existen.
alter table expenses add column if not exists event_ref text not null default '';
