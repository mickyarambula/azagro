import type { getSql } from "@/lib/db";
import {
  foldName,
  LOCATION_CATALOG,
  PARTNER_CATALOG,
  PARTNER_GROUP_CATALOG,
  PRODUCT_CATALOG,
  PRODUCT_KIND_CATALOG,
  UOM_CATALOG,
} from "@/lib/erp/catalog";

type Sql = Awaited<ReturnType<typeof getSql>>;

const g = globalThis as typeof globalThis & {
  __compaqSync__?: Record<number, { at: number; counts: { partners: number; products: number; locations: number } }>;
};

export async function syncCompaqCatalogs(sql: Sql, companyId: number, force = false) {
  g.__compaqSync__ ??= {};
  const cached = g.__compaqSync__[companyId];
  if (!force && cached && Date.now() - cached.at < 6 * 60 * 60 * 1000) return cached.counts;
  await sql`
    create table if not exists uoms (
      id serial primary key,
      company_id integer not null references companies(id) on delete cascade,
      code text not null,
      name text not null default '',
      unique (company_id, code)
    )
  `;
  await sql`
    create table if not exists product_kinds (
      id serial primary key,
      company_id integer not null references companies(id) on delete cascade,
      code text not null,
      name text not null default '',
      unique (company_id, code)
    )
  `;
  await sql`
    create table if not exists partner_groups (
      id serial primary key,
      company_id integer not null references companies(id) on delete cascade,
      code text not null,
      name text not null default '',
      unique (company_id, code)
    )
  `;
  await sql`alter table partners add column if not exists legal_name text not null default ''`;
  await sql`alter table partners add column if not exists group_name text not null default ''`;
  await sql`alter table partners add column if not exists partner_kind text not null default 'trade'`;
  await sql`alter table partners add column if not exists rfc text not null default ''`;
  await sql`alter table partners add column if not exists credit_limit numeric(14,2) not null default 0`;
  await sql`alter table products add column if not exists product_type text not null default ''`;
  await sql`alter table locations add column if not exists address text not null default ''`;

  for (const u of UOM_CATALOG) {
    await sql`
      insert into uoms (company_id, code, name) values (${companyId}, ${u.code}, ${u.name})
      on conflict (company_id, code) do update set name = excluded.name
    `;
  }
  for (const k of PRODUCT_KIND_CATALOG) {
    await sql`
      insert into product_kinds (company_id, code, name) values (${companyId}, ${k.code}, ${k.name})
      on conflict (company_id, code) do update set name = excluded.name
    `;
  }
  for (const g of PARTNER_GROUP_CATALOG) {
    await sql`
      insert into partner_groups (company_id, code, name) values (${companyId}, ${g.code}, ${g.name})
      on conflict (company_id, code) do update set name = excluded.name
    `;
  }

  const catalogCodes = new Set(PARTNER_CATALOG.map((p) => p.code));
  const existingP = await sql<{ id: number; code: string; name: string; legal_name: string }>`
    select id, code, name, coalesce(legal_name, '') as legal_name
    from partners where company_id = ${companyId}
  `;
  for (const p of PARTNER_CATALOG) {
    const named = existingP.find((e) => {
      if (catalogCodes.has(e.code) && e.code !== p.code) return false;
      const a = foldName(e.name);
      const b = foldName(e.legal_name);
      const n = foldName(p.name);
      return a === n || b === n;
    });
    if (named && named.code !== p.code) {
      const taken = await sql<{ id: number }>`
        select id from partners where company_id = ${companyId} and code = ${p.code} limit 1
      `;
      if (!taken[0]) {
        await sql`update partners set code = ${p.code} where id = ${named.id} and company_id = ${companyId}`;
        named.code = p.code;
      }
    }
    const late = p.is_customer ? 16.06 : 0;
    await sql`
      insert into partners (
        company_id, code, name, legal_name, rfc, is_customer, is_supplier,
        group_name, city, payment_days, late_rate, partner_kind, credit_limit
      )
      values (
        ${companyId}, ${p.code}, ${p.name}, ${p.legal_name}, ${p.rfc}, ${p.is_customer}, ${p.is_supplier},
        ${p.group_name}, ${p.city}, ${p.payment_days}, ${late}, ${p.partner_kind}, ${p.credit_limit}
      )
      on conflict (company_id, code) do update set
        name = excluded.name,
        legal_name = excluded.legal_name,
        rfc = excluded.rfc,
        is_customer = excluded.is_customer,
        is_supplier = excluded.is_supplier,
        group_name = excluded.group_name,
        payment_days = excluded.payment_days,
        partner_kind = excluded.partner_kind,
        credit_limit = excluded.credit_limit
    `;
  }

  const prodCodes = new Set(PRODUCT_CATALOG.map((p) => p.code));
  const existingPr = await sql<{ id: number; code: string; name: string }>`
    select id, code, name from products where company_id = ${companyId}
  `;
  for (const p of PRODUCT_CATALOG) {
    const named = existingPr.find((e) => {
      if (prodCodes.has(e.code) && e.code !== p.code) return false;
      return foldName(e.name) === foldName(p.name);
    });
    if (named && named.code !== p.code) {
      const taken = await sql<{ id: number }>`
        select id from products where company_id = ${companyId} and code = ${p.code} limit 1
      `;
      if (!taken[0]) {
        await sql`update products set code = ${p.code} where id = ${named.id} and company_id = ${companyId}`;
        named.code = p.code;
      }
    }
    const category = p.product_type === "INSUMO" ? "Insumos" : p.product_type === "MAQUINARIA" ? "Maquinaria" : p.product_type === "AGROQUIMICOS" ? "Agroquímicos" : "Fertilizantes";
    await sql`
      insert into products (company_id, code, name, category, product_type, uom, cost, list_price, min_stock)
      values (${companyId}, ${p.code}, ${p.name}, ${category}, ${p.product_type}, ${p.uom}, 0, ${p.list_price}, 0)
      on conflict (company_id, code) do update set
        name = excluded.name,
        product_type = excluded.product_type,
        uom = excluded.uom,
        category = excluded.category,
        list_price = case when products.list_price = 0 then excluded.list_price else products.list_price end
    `;
  }

  const partners = await sql<{ id: number; code: string }>`
    select id, code from partners where company_id = ${companyId}
  `;
  const pid = new Map(partners.map((p) => [p.code, p.id]));
  for (const loc of LOCATION_CATALOG) {
    const partnerId = loc.partnerCode ? (pid.get(loc.partnerCode) ?? null) : null;
    await sql`
      insert into locations (company_id, code, name, loc_type, partner_id, address)
      values (${companyId}, ${loc.code}, ${loc.name}, ${loc.loc_type}, ${partnerId}, '')
      on conflict (company_id, code) do update set
        name = excluded.name,
        loc_type = excluded.loc_type,
        partner_id = coalesce(excluded.partner_id, locations.partner_id)
    `;
  }

  const counts = {
    partners: PARTNER_CATALOG.length,
    products: PRODUCT_CATALOG.length,
    locations: LOCATION_CATALOG.length,
  };
  await linkSeedDestinos(sql, companyId);
  g.__compaqSync__[companyId] = { at: Date.now(), counts };
  return counts;
}

/** Destinos de entrega de demostración ligados al cliente Compaq (no son almacenes). */
export async function linkSeedDestinos(sql: Sql, companyId: number) {
  const pairs: Array<[string, string]> = [
    ["ENT-SL", "CL0018"],
    ["ENT-CACO", "CL0019"],
  ];
  for (const [locCode, partnerCode] of pairs) {
    const p = await sql<{ id: number }>`
      select id from partners where company_id = ${companyId} and code = ${partnerCode} limit 1
    `;
    if (!p[0]) continue;
    await sql`
      update locations
      set partner_id = ${p[0].id}
      where company_id = ${companyId} and code = ${locCode} and (partner_id is null or partner_id <> ${p[0].id})
    `;
  }
}
