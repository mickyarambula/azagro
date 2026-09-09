import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { activeMember } from "@/lib/erp/acl";
import { sectionByKey } from "@/lib/nav";

/**
 * Favoritos del menú, por persona (bloque de diseño, parte 1, migración 0031).
 *
 * - La llave es `SectionDef.key` de nav.ts; una clave que no exista en el menú
 *   se rechaza, nunca se guarda a ciegas.
 * - Cada quien toca solo lo suyo: el `member_id` sale de la sesión, no del
 *   cliente. No hay favoritos por omisión ni por rol; la tabla nace vacía.
 * - No va a bitácora: es preferencia personal, no mueve documentos ni dinero
 *   (decisión del dueño, 9-sep-2026).
 */
export const listFavorites = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const me = await activeMember(sql, context.userId);
    const rows = await sql<{ section_key: string }>`
      select section_key from member_favorites where member_id = ${me.id} order by created_at
    `;
    return rows.map((r) => r.section_key);
  });

export const toggleFavorite = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ key: z.string().min(1).max(60) }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const me = await activeMember(sql, context.userId);
    if (!sectionByKey(data.key)) throw new Error(`La sección "${data.key}" no existe en el menú`);
    const had = await sql<{ n: number }>`
      select count(*)::int as n from member_favorites where member_id = ${me.id} and section_key = ${data.key}
    `;
    if ((had[0]?.n ?? 0) > 0) {
      await sql`delete from member_favorites where member_id = ${me.id} and section_key = ${data.key}`;
    } else {
      await sql`
        insert into member_favorites (member_id, section_key) values (${me.id}, ${data.key})
        on conflict do nothing
      `;
    }
    const rows = await sql<{ section_key: string }>`
      select section_key from member_favorites where member_id = ${me.id} order by created_at
    `;
    return rows.map((r) => r.section_key);
  });
