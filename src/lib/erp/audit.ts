import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql, type Sql } from "@/lib/db";
import { assertCan } from "@/lib/erp/acl";

async function cid(sql: Sql, userId: string) {
  const rows = await sql<{ company_id: number }>`select company_id from members where user_id = ${userId} and status = 'active' limit 1`;
  if (!rows[0]) throw new Error("Sin empresa");
  return rows[0].company_id;
}

export async function ensureAudit(sql: Sql) {
  await sql.query(`
    create table if not exists audit_log (
      id serial primary key,
      company_id integer not null references companies(id) on delete cascade,
      user_id text not null default '',
      action text not null,
      entity text not null,
      entity_id integer,
      name text not null default '',
      detail text not null default '',
      created_at timestamptz not null default now()
    )
  `);
}

export async function writeAudit(
  sql: Sql,
  opts: {
    companyId: number;
    userId: string;
    action: string;
    entity: string;
    entityId?: number | null;
    name?: string;
    detail?: string;
  },
) {
  await ensureAudit(sql);
  await sql`
    insert into audit_log (company_id, user_id, action, entity, entity_id, name, detail)
    values (
      ${opts.companyId}, ${opts.userId}, ${opts.action}, ${opts.entity},
      ${opts.entityId ?? null}, ${opts.name ?? ""}, ${opts.detail ?? ""}
    )
  `;
}

export const listAudit = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z
      .object({
        q: z.string().optional(),
        action: z.string().optional(),
        userId: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
      })
      .optional(),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    await assertCan(sql, context.userId, "settings", "view");
    await ensureAudit(sql);
    const q = (data?.q ?? "").trim();
    const action = (data?.action ?? "").trim();
    const userId = (data?.userId ?? "").trim();
    const from = (data?.from ?? "").slice(0, 10);
    const to = (data?.to ?? "").slice(0, 10);
    const limit = data?.limit ?? 100;
    const offset = data?.offset ?? 0;
    const rows = await sql<{
      id: number;
      user_id: string;
      who: string;
      action: string;
      entity: string;
      entity_id: number | null;
      name: string;
      detail: string;
      created_at: string;
    }>`
      select a.id, a.user_id,
        coalesce(nullif(m.display_name,''), nullif(m.email,''), a.user_id) as who,
        a.action, a.entity, a.entity_id, a.name, a.detail, a.created_at::text
      from audit_log a
      left join members m on m.user_id = a.user_id and m.company_id = a.company_id
      where a.company_id = ${companyId}
        and (${q} = '' or a.name ilike ${"%" + q + "%"} or a.detail ilike ${"%" + q + "%"})
        and (${action} = '' or a.action = ${action})
        and (${userId} = '' or a.user_id = ${userId})
        and (${from} = '' or a.created_at >= ${from + "T00:00:00"}::timestamptz)
        and (${to} = '' or a.created_at <= ${to + "T23:59:59"}::timestamptz)
      order by a.id desc
      limit ${limit} offset ${offset}
    `;
    const actions = await sql<{ action: string }>`
      select distinct action from audit_log where company_id = ${companyId} order by action
    `;
    const users = await sql<{ user_id: string; who: string }>`
      select m.user_id, coalesce(nullif(m.display_name,''), nullif(m.email,''), m.user_id) as who
      from members m where m.company_id = ${companyId} order by who
    `;
    return { rows, actions: actions.map((a) => a.action), users, limit, offset };
  });
