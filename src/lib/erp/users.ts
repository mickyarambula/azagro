import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { seedCompany } from "@/lib/azagro";
import {
  assertCan,
  isAppRole,
  loadAcl,
  MODULES,
  ROLE_META,
  seedAcl,
  type AclLevel,
  type AppRole,
} from "@/lib/erp/acl";

type Sql = Awaited<ReturnType<typeof getSql>>;

async function authProfile(sql: Sql, userId: string) {
  const rows = await sql<{ email: string; name: string }>`
    select "email" as email, "name" as name from "user" where "id" = ${userId} limit 1
  `;
  return rows[0] ?? { email: "", name: "" };
}

export const getAccessState = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const member = await sql<{
      id: number;
      company_id: number;
      role: string;
      status: string;
      own_only: boolean;
      display_name: string | null;
      email: string;
      name: string;
      join_code: string;
    }>`
      select m.id, m.company_id, m.role, m.status, m.own_only, m.display_name, m.email,
        c.name, c.join_code
      from members m
      join companies c on c.id = m.company_id
      where m.user_id = ${context.userId}
      limit 1
    `;
    if (member[0]) {
      if (member[0].status !== "active") {
        return { status: "disabled" as const, workspace: null, canCreate: false, pending: false };
      }
      const aclCount = await sql<{ n: number }>`
        select count(*)::int as n from member_acl where member_id = ${member[0].id}
      `;
      if ((aclCount[0]?.n ?? 0) === 0) {
        await seedAcl(sql, member[0].id, isAppRole(member[0].role) ? member[0].role : "consulta");
      }
      try {
        await seedCompany(sql, member[0].company_id);
      } catch (err) {
        console.error("seedCompany", err);
      }
      const acl = await loadAcl(sql, member[0].id, member[0].role);
      const count = await sql<{ n: number }>`
        select count(*)::int as n from members where company_id = ${member[0].company_id} and status = 'active'
      `;
      return {
        status: "ok" as const,
        canCreate: false,
        pending: false,
        workspace: {
          companyId: member[0].company_id,
          companyName: member[0].name,
          joinCode: member[0].join_code,
          role: member[0].role,
          roleLabel: isAppRole(member[0].role) ? ROLE_META[member[0].role].label : member[0].role,
          userId: context.userId,
          memberId: member[0].id,
          memberCount: count[0]?.n ?? 1,
          ownOnly: member[0].own_only,
          displayName: member[0].display_name ?? "",
          acl,
        },
      };
    }

    const pending = await sql<{ id: number }>`
      select id from access_requests where user_id = ${context.userId} and status = 'pending' limit 1
    `;
    const companies = await sql<{ n: number }>`select count(*)::int as n from companies`;
    return {
      status: pending[0] ? ("pending" as const) : ("none" as const),
      workspace: null,
      canCreate: (companies[0]?.n ?? 0) === 0,
      pending: Boolean(pending[0]),
    };
  });

export const requestAccess = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const existing = await sql<{ id: number }>`select id from members where user_id = ${context.userId} limit 1`;
    if (existing[0]) return { ok: true };
    const co = await sql<{ id: number }>`select id from companies order by id limit 1`;
    if (!co[0]) throw new Error("Todavía no hay empresa. El primero en entrar debe crearla.");
    const already = await sql<{ id: number }>`
      select id from access_requests
      where user_id = ${context.userId} and company_id = ${co[0].id} and status = 'pending'
      limit 1
    `;
    if (already[0]) return { ok: true };
    const profile = await authProfile(sql, context.userId);
    await sql`
      insert into access_requests (company_id, user_id, email, name)
      values (${co[0].id}, ${context.userId}, ${profile.email}, ${profile.name})
    `;
    return { ok: true };
  });

export const listTeam = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    await assertCan(sql, context.userId, "users", "view");
    const me = await sql<{ company_id: number }>`select company_id from members where user_id = ${context.userId} limit 1`;
    const cid = me[0]!.company_id;
    const members = await sql<{
      id: number;
      user_id: string;
      role: string;
      status: string;
      own_only: boolean;
      display_name: string | null;
      email: string;
      auth_email: string | null;
      auth_name: string | null;
    }>`
      select m.id, m.user_id, m.role, m.status, m.own_only, m.display_name, m.email,
        u."email" as auth_email, u."name" as auth_name
      from members m
      left join "user" u on u."id" = m.user_id
      where m.company_id = ${cid}
      order by m.id
    `;
    const acls = await sql<{ member_id: number; module: string; level: string }>`
      select a.member_id, a.module, a.level
      from member_acl a
      join members m on m.id = a.member_id
      where m.company_id = ${cid}
    `;
    const requests = await sql<{
      id: number;
      user_id: string;
      email: string;
      name: string;
      created_at: string;
    }>`
      select id, user_id, email, name, created_at::text
      from access_requests
      where company_id = ${cid} and status = 'pending'
      order by id
    `;
    return {
      roles: ROLE_META,
      modules: MODULES,
      members: members.map((m) => ({
        ...m,
        email: m.auth_email || m.email,
        name: m.display_name || m.auth_name || m.email,
        acl: Object.fromEntries(
          acls.filter((a) => a.member_id === m.id).map((a) => [a.module, a.level]),
        ) as Record<string, AclLevel>,
      })),
      requests,
    };
  });

export const approveAccess = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      requestId: z.number(),
      role: z.string(),
      ownOnly: z.boolean().optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await assertCan(sql, context.userId, "users", "edit");
    if (!isAppRole(data.role)) throw new Error("Rol no válido");
    const me = await sql<{ company_id: number }>`select company_id from members where user_id = ${context.userId}`;
    const req = await sql<{ id: number; user_id: string; email: string; name: string; status: string }>`
      select id, user_id, email, name, status from access_requests
      where id = ${data.requestId} and company_id = ${me[0]!.company_id}
    `;
    if (!req[0] || req[0].status !== "pending") throw new Error("Solicitud no disponible");
    const exists = await sql<{ id: number }>`select id from members where user_id = ${req[0].user_id} limit 1`;
    if (exists[0]) {
      await sql`update access_requests set status = 'approved' where id = ${req[0].id}`;
      return { ok: true };
    }
    const own = data.ownOnly ?? ROLE_META[data.role].ownOnly;
    const row = await sql<{ id: number }>`
      insert into members (company_id, user_id, role, display_name, email, status, own_only)
      values (${me[0]!.company_id}, ${req[0].user_id}, ${data.role}, ${req[0].name || "Usuario"}, ${req[0].email}, 'active', ${own})
      returning id
    `;
    await seedAcl(sql, row[0]!.id, data.role);
    await sql`update access_requests set status = 'approved' where id = ${req[0].id}`;
    return { ok: true };
  });

export const rejectAccess = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ requestId: z.number() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await assertCan(sql, context.userId, "users", "edit");
    const me = await sql<{ company_id: number }>`select company_id from members where user_id = ${context.userId}`;
    await sql`
      update access_requests set status = 'rejected'
      where id = ${data.requestId} and company_id = ${me[0]!.company_id}
    `;
    return { ok: true };
  });

export const updateMember = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      memberId: z.number(),
      role: z.string(),
      status: z.enum(["active", "disabled"]),
      ownOnly: z.boolean(),
      displayName: z.string().optional(),
      resetAcl: z.boolean().optional(),
      acl: z.record(z.string(), z.enum(["none", "view", "edit"])).optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await assertCan(sql, context.userId, "users", "edit");
    if (!isAppRole(data.role)) throw new Error("Rol no válido");
    const me = await sql<{ company_id: number; id: number }>`
      select company_id, id from members where user_id = ${context.userId}
    `;
    const target = await sql<{ id: number; user_id: string }>`
      select id, user_id from members where id = ${data.memberId} and company_id = ${me[0]!.company_id}
    `;
    if (!target[0]) throw new Error("Usuario no encontrado");
    if (target[0].user_id === context.userId && data.status === "disabled") {
      throw new Error("No puedes desactivar tu propio usuario");
    }
    await sql`
      update members set
        role = ${data.role},
        status = ${data.status},
        own_only = ${data.ownOnly},
        display_name = coalesce(${data.displayName ?? null}, display_name)
      where id = ${target[0].id}
    `;
    if (data.resetAcl || !data.acl) {
      await seedAcl(sql, target[0].id, data.role);
    }
    if (data.acl) {
      for (const [mod, level] of Object.entries(data.acl)) {
        await sql`
          insert into member_acl (member_id, module, level)
          values (${target[0].id}, ${mod}, ${level})
          on conflict (member_id, module) do update set level = excluded.level
        `;
      }
    }
    return { ok: true };
  });
