-- Catálogo de circuitos de financiamiento y tabla de tasas de dos columnas
-- (5-sep-2026). PASO 0 del plan de construcción del catálogo de circuitos —
-- ver DISENO_FINANCIAMIENTO.md, ESTADO.md, DECISIONES.md (Decisiones 1, 3, 4,
-- 5, 6, y las respuestas del dueño a las diez preguntas del plan).
--
-- Este paso SOLO crea las tablas y las siembra. Nada en el código las lee
-- todavía: ni el motor de precios, ni los reportes, ni la mora. El pedido
-- sigue sin declarar circuito (eso es el paso 1); el motor sigue leyendo
-- company_settings.asr_commission / asr_spread (eso cambia en el paso 3).

-- ---------------------------------------------------------------------------
-- Catálogo de circuitos: cuatro filas fijas por empresa, con los parámetros
-- que cambian entre ellos. "Un solo lugar decide cada número" (regla del
-- dueño): la comisión del circuito ASR se COPIA del valor que la empresa ya
-- tenía capturado en company_settings.asr_commission — nunca un 1% escrito
-- aquí. Si esa columna está sin capturar (NULL), el circuito ASR nace también
-- sin capturar: no se inventa un número donde antes no lo había.
-- ---------------------------------------------------------------------------
create table if not exists credit_circuits (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  code text not null,
  name text not null,
  -- Comisión de apertura, si el circuito la cobra. Nula = no cobra (Contado,
  -- Línea Santa Rosa) o no capturada todavía (Línea propia, sin construir).
  commission_rate numeric(8,4),
  -- Sobre qué base corre el financiamiento de este circuito:
  --   'costo_comision' = costo puesto + comisión — lo que el circuito ASR
  --                       desembolsa hoy (fórmula vigente, sin cambio).
  --   'costo_margen'   = costo puesto + margen — lo que Santa Rosa
  --                       desembolsaría en el circuito lineal (Decisión 4/8).
  -- Nula = el circuito no financia (Contado) o no está construido (Propia).
  financing_base text,
  -- Quién le factura al cliente. 'azagro' en Contado, Circuito ASR y Línea
  -- propia (el financiamiento va escondido dentro del precio, como hoy);
  -- 'santa_rosa' en Línea Santa Rosa (factura directo, Decisión 3).
  invoices_client text,
  -- Quién pone el capital de la operación. Nulo = nadie (Contado).
  finances text,
  -- Reparto de la utilidad de la mora entre Azagro y quien financia. Fase 3;
  -- nace SIN CAPTURAR a propósito, igual que los interruptores de
  -- credit_policies (migración 0021): aunque el 50/50 del circuito lineal ya
  -- esté decidido en DECISIONES.md, la captura y la lectura son de la Fase 3.
  mora_share_azagro numeric(5,4),
  mora_share_financier numeric(5,4),
  -- Si hoy se puede elegir en el selector de circuito (el selector todavía no
  -- existe: paso 2). Los cuatro nacen visibles en el catálogo; solo dos son
  -- elegibles hoy — los otros dos están "por construir" (pregunta 9 y § 3 del
  -- diseño: Línea Santa Rosa "por construir", Línea propia "cuando llegue").
  enabled boolean not null default false,
  sort_order integer not null default 0,
  unique (company_id, code)
);

insert into credit_circuits
  (company_id, code, name, commission_rate, financing_base, invoices_client, finances, enabled, sort_order)
select cs.company_id, 'CONTADO', 'Contado', null, null, 'azagro', null, true, 1
from company_settings cs
on conflict (company_id, code) do nothing;

insert into credit_circuits
  (company_id, code, name, commission_rate, financing_base, invoices_client, finances, enabled, sort_order)
select cs.company_id, 'ASR', 'Circuito ASR', cs.asr_commission, 'costo_comision', 'azagro', 'santa_rosa', true, 2
from company_settings cs
on conflict (company_id, code) do nothing;

insert into credit_circuits
  (company_id, code, name, commission_rate, financing_base, invoices_client, finances, enabled, sort_order)
select cs.company_id, 'SANTA_ROSA', 'Línea Santa Rosa', null, 'costo_margen', 'santa_rosa', 'santa_rosa', false, 3
from company_settings cs
on conflict (company_id, code) do nothing;

insert into credit_circuits
  (company_id, code, name, commission_rate, financing_base, invoices_client, finances, enabled, sort_order)
select cs.company_id, 'PROPIA', 'Línea propia', null, null, 'azagro', 'azagro', false, 4
from company_settings cs
on conflict (company_id, code) do nothing;

-- ---------------------------------------------------------------------------
-- Tabla de tasas de dos columnas (Decisión 1, 5-sep-2026): "tasa de costo" (lo
-- que de verdad cuesta la línea) y "tasa de cobro" (la que entra al precio y a
-- la mora del cliente). Las dos se capturan directamente, pueden ser iguales;
-- la protección es la diferencia entre ambas y SE CALCULA, no se captura
-- aparte. Deliberadamente no se llaman "TIIE": un número con protección
-- adentro no es la TIIE que publica Banxico.
--
-- Nace VACÍA a propósito: no se migra ni se deriva de tiie_rates + spread,
-- porque eso sería inventar un número de negocio que nadie capturó con este
-- criterio nuevo. Coexiste con tiie_rates hasta que el motor de precios se
-- conecte (paso 3); nada la lee todavía.
-- ---------------------------------------------------------------------------
create table if not exists funding_rates (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  date date not null,
  cost_rate numeric(8,6) not null,
  collection_rate numeric(8,6) not null,
  unique (company_id, date)
);
