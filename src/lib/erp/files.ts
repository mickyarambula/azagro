import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql, type Sql } from "@/lib/db";
import { assertCan } from "@/lib/erp/acl";
import { writeAudit } from "@/lib/erp/audit";

async function cid(sql: Sql, userId: string) {
  const rows = await sql<{ company_id: number }>`select company_id from members where user_id = ${userId} limit 1`;
  if (!rows[0]) throw new Error("Sin empresa");
  return rows[0].company_id;
}

async function ensureFiles(sql: Sql) {
  await sql.query(`
    create table if not exists doc_files (
      id serial primary key,
      company_id integer not null references companies(id) on delete cascade,
      kind text not null,
      entity_id integer not null default 0,
      filename text not null,
      mime text not null default 'application/octet-stream',
      content text not null,
      created_by text not null default '',
      created_at timestamptz not null default now()
    )
  `);
}

const kindZ = z.enum(["sale", "purchase", "invoice", "request", "rfq", "cutover"]);

export const listDocFiles = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ kind: kindZ, entityId: z.number() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    await ensureFiles(sql);
    const rows = await sql<{ id: number; filename: string; mime: string; created_at: string; bytes: number }>`
      select id, filename, mime, created_at::text, length(content) as bytes
      from doc_files
      where company_id = ${companyId} and kind = ${data.kind} and entity_id = ${data.entityId}
      order by id desc
    `;
    return { rows };
  });

export const uploadDocFile = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      kind: kindZ,
      entityId: z.number(),
      filename: z.string().min(1),
      mime: z.string().optional().default("application/octet-stream"),
      content: z.string().min(1),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await assertCan(sql, context.userId, data.kind === "cutover" ? "settings" : "sales", "edit");
    const companyId = await cid(sql, context.userId);
    await ensureFiles(sql);
    if (data.content.length > 6_000_000) throw new Error("El archivo pesa más de ~4 MB. Parte o comprime.");
    const row = await sql<{ id: number }>`
      insert into doc_files (company_id, kind, entity_id, filename, mime, content, created_by)
      values (${companyId}, ${data.kind}, ${data.entityId}, ${data.filename}, ${data.mime || "application/octet-stream"}, ${data.content}, ${context.userId})
      returning id
    `;
    await writeAudit(sql, {
      companyId,
      userId: context.userId,
      action: "archivo",
      entity: data.kind,
      entityId: data.entityId,
      name: data.filename,
    });
    return { id: row[0]!.id };
  });

export const getDocFile = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ id: z.number() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    await ensureFiles(sql);
    const rows = await sql<{ filename: string; mime: string; content: string }>`
      select filename, mime, content from doc_files where id = ${data.id} and company_id = ${companyId}
    `;
    if (!rows[0]) throw new Error("Archivo no encontrado");
    return rows[0];
  });
