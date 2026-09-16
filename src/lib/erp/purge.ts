import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql, withTx, type Sql } from "@/lib/db";
import { activeMember, assertAdmin } from "@/lib/erp/acl";
import { ensureAudit, writeAudit } from "@/lib/erp/audit";
import { PARTNER_CATALOG, PRODUCT_CATALOG } from "@/lib/erp/catalog";
import {
  KEEP,
  PREVIEW,
  PURGE,
  REBUILD,
  clearLive,
  liveBlockers,
  liveSinceMessage,
  previewCounts,
  purgeState,
  runPurge,
  setLive,
} from "../../../scripts/purge-plan.mjs";

/**
 * BLOQUE C4 — Borrar datos de prueba, paso 4: el servidor (BORRADO-PRUEBAS.md).
 *
 * La única excepción al "no se borra" del sistema (Decisiones 15 y 16), y por
 * eso confinada: TODA la SQL del borrado vive en `scripts/purge-plan.mjs`;
 * aquí no hay ningún borrado ni ninguna sentencia propia sobre la marca
 * de arranque — este módulo solo decide quién, cuándo y con qué confirmación,
 * y deja rastro. Una prueba por texto lo vigila
 * (`scripts/erp-borrado-servidor.test.mjs`).
 *
 *   - `purgePreview`: solo lectura. Lo que se va (conteo por tabla con la
 *     misma sentencia que después borra), lo que se conserva, los avisos, los
 *     bloqueos y `allowed`.
 *   - `purgeTestData`: solo administrador (en pantalla y aquí, B6); DDL de
 *     runtime fuera de la transacción; adentro, el candado del plan (`for
 *     update` en companies y company_settings, relee `live_since`) y el
 *     nombre de la empresa tecleado ANTES de la primera sentencia; motivo
 *     obligatorio; todo o nada; bitácora `borrado-de-pruebas` adentro; el
 *     intento rechazado queda como `borrado-rechazado` con conexión fresca.
 *   - `setLiveSince` («Arrancó la operación real», `arranque-real`) y
 *     `clearLiveSince` («Regresar a pruebas», `arranque-real-retirado`): el
 *     candado de una vía con salida (B3) — difícil y con rastro, no
 *     imposible; la salida exige nombre + frase + motivo y se niega si hay
 *     documentos o bitácora posteriores a la marca.
 */

/** La frase de la salida (§ 4.2 b). Exacta, en mayúsculas. */
export const LIVE_CLEAR_PHRASE = "REGRESAR A PRUEBAS";

/** El texto honesto del respaldo (§ 4.7): no se vende como red lo que no lo es. */
export const BACKUP_NOTE =
  "El «Descargar respaldo» de esta pantalla es una foto de cartera y existencias (cabeceras y conteos), no un respaldo de la base. " +
  "El respaldo real es el punto de restauración o la rama de Neon, hecho antes de borrar.";

export type PurgeCount = { step: number; table: string; kind: string; count: number };

export type PurgePreview = {
  company: { id: number; name: string };
  liveSince: string | null;
  counts: PurgeCount[];
  rebuild: { name: string; why: string }[];
  keeps: { table: string; why: string }[];
  warnings: string[];
  blockers: string[];
  allowed: boolean;
  role: string;
  backupNote: string;
  liveBlockers: { what: string; count: number }[];
};

type Run = (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const runner = (sql: Sql): Run => (text, params = []) => sql.query(text, params);

const tsOf = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));

/**
 * Deja escrito que alguien intentó borrar (o mover la marca) y no se pudo.
 * Conexión fresca, fuera de la transacción: tiene que quedar aunque el propio
 * rechazo provoque el rollback (patrón de acl.ts logDenied / cancel.ts
 * auditRejected). Nunca rompe el rechazo.
 */
async function auditRejected(companyId: number, userId: string, name: string, what: string) {
  try {
    const fresh = await getSql();
    await ensureAudit(fresh);
    await writeAudit(fresh, {
      companyId,
      userId,
      action: "borrado-rechazado",
      entity: "company",
      entityId: companyId,
      name,
      detail: what.slice(0, 900),
    });
  } catch {
    /* la bitácora no debe impedir el rechazo */
  }
}

/**
 * Lo que la pantalla enseña antes de preguntar (§ 4.3). Solo lectura: no
 * bloquea filas, no borra, no abre transacción. Si el rol no es admin, no
 * hay conteos: solo el bloqueo.
 */
export const purgePreview = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ confirmName: z.string().optional() }).optional())
  .handler(async ({ context, data }): Promise<PurgePreview> => {
    const sql = await getSql();
    const me = await activeMember(sql, context.userId);
    const run = runner(sql);
    const state = await purgeState(run, me.company_id);
    const blockers: string[] = [];
    const warnings: string[] = [];
    if (me.role !== "admin") blockers.push("Solo un administrador puede borrar los datos de prueba.");
    if (state.liveSince != null) blockers.push(liveSinceMessage(state.name, state.liveSince));
    const typed = data?.confirmName;
    if (typed !== undefined && typed.trim() !== "" && typed.trim() !== state.name.trim()) {
      blockers.push(`El nombre tecleado no coincide con «${state.name}».`);
    }

    let counts: PurgeCount[] = [];
    let live: { what: string; count: number }[] = [];
    if (me.role === "admin") {
      counts = await previewCounts(run, me.company_id);
      const cost = Number((await run(PREVIEW.productCost, [me.company_id]))[0]?.n ?? 0);
      if (cost > 0) {
        warnings.push(
          `${cost} producto${cost === 1 ? "" : "s"} cambia${cost === 1 ? "" : "n"} de costo: vuelve al promedio de las existencias del corte, o a 0 si no tiene existencia de corte (el costo de referencia no se toca).`,
        );
      }
      // Lo que no tiene marca y se queda (§ 1): socios y productos capturados fuera del catálogo Compaq.
      const partnerCodes = new Set(PARTNER_CATALOG.map((p) => p.code));
      const productCodes = new Set(PRODUCT_CATALOG.map((p) => p.code));
      const partners = await sql<{ code: string; name: string }>`select code, name from partners where company_id = ${me.company_id} order by code`;
      const products = await sql<{ code: string; name: string }>`select code, name from products where company_id = ${me.company_id} order by code`;
      const offP = partners.filter((p) => !partnerCodes.has(p.code));
      const offQ = products.filter((p) => !productCodes.has(p.code));
      if (offP.length) {
        warnings.push(
          `${offP.length} socio${offP.length === 1 ? "" : "s"} fuera del catálogo Compaq se conserva${offP.length === 1 ? "" : "n"} (no hay marca de prueba; revísalos a mano): ${offP
            .slice(0, 12)
            .map((p) => `${p.code} ${p.name}`)
            .join(", ")}${offP.length > 12 ? ", …" : ""}.`,
        );
      }
      if (offQ.length) {
        warnings.push(
          `${offQ.length} producto${offQ.length === 1 ? "" : "s"} fuera del catálogo Compaq se conserva${offQ.length === 1 ? "" : "n"} (no hay marca de prueba; revísalos a mano): ${offQ
            .slice(0, 12)
            .map((p) => `${p.code} ${p.name}`)
            .join(", ")}${offQ.length > 12 ? ", …" : ""}.`,
        );
      }
      if (state.liveSince != null) live = await liveBlockers(run, me.company_id, state.liveSince);
    }
    return {
      company: { id: state.id, name: state.name },
      liveSince: tsOf(state.liveSince),
      counts,
      rebuild: REBUILD.map((r) => ({ name: r.name, why: r.why })),
      keeps: KEEP.map((k) => ({ table: k.table, why: k.why })),
      warnings,
      blockers,
      allowed: blockers.length === 0 && me.role === "admin",
      role: me.role,
      backupNote: BACKUP_NOTE,
      liveBlockers: live,
    };
  });

/**
 * El borrado (§ 4.4-4.6). Todo o nada. El candado real corre ADENTRO de la
 * transacción, en el plan: bloquea companies y company_settings, relee
 * `live_since`, y compara el nombre tecleado antes de la primera sentencia.
 */
export const purgeTestData = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      confirmName: z.string().trim().min(1, "Teclea el nombre de la empresa"),
      reason: z.string().trim().min(1, "Escribe el motivo"),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    // DDL de runtime (la bitácora se crea si no existe) FUERA de la transacción.
    await ensureAudit(sql);
    const me = await assertAdmin(sql, context.userId);
    const state = await purgeState(runner(sql), me.company_id);
    try {
      return await withTx(async (tx) => {
        await assertAdmin(tx, context.userId);
        const res = await runPurge(runner(tx), me.company_id, { expectName: data.confirmName });
        const deleted = res.deleted.map((d) => `${d.table}${d.kind === "update" ? " (desligar)" : ""}: ${d.count}`).join(", ");
        const rebuilt = res.rebuilt.map((r) => `${r.name}: ${r.count}`).join(", ");
        const kept = KEEP.map((k) => k.table).join(", ");
        await writeAudit(tx, {
          companyId: me.company_id,
          userId: context.userId,
          action: "borrado-de-pruebas",
          entity: "company",
          entityId: me.company_id,
          name: res.company.name,
          detail: `${data.reason} · borrado: ${deleted} · reconstruido: ${rebuilt} · conservado: el corte de Compaq (facturas con cutover_key, INI 'Corte Compaq', CSV del corte) y ${kept}`,
        });
        return { company: { id: res.company.id, name: res.company.name }, deleted: res.deleted, rebuilt: res.rebuilt };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await auditRejected(me.company_id, context.userId, state.name, `${message} · motivo tecleado: ${data.reason}`);
      throw err;
    }
  });

/** «Arrancó la operación real» (§ 4.2): desde aquí el borrado se niega. Una sola vez. */
export const setLiveSince = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      confirmName: z.string().trim().min(1, "Teclea el nombre de la empresa"),
      reason: z.string().trim().min(1, "Escribe el motivo"),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await ensureAudit(sql);
    const me = await assertAdmin(sql, context.userId);
    const state = await purgeState(runner(sql), me.company_id);
    try {
      return await withTx(async (tx) => {
        await assertAdmin(tx, context.userId);
        const res = await setLive(runner(tx), me.company_id, { expectName: data.confirmName });
        await writeAudit(tx, {
          companyId: me.company_id,
          userId: context.userId,
          action: "arranque-real",
          entity: "company",
          entityId: me.company_id,
          name: res.name,
          detail: `Arrancó la operación real el ${tsOf(res.liveSince)?.slice(0, 10)}: los datos de prueba ya no se pueden borrar · ${data.reason}`,
        });
        return { company: { id: res.id, name: res.name }, liveSince: tsOf(res.liveSince) };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await auditRejected(me.company_id, context.userId, state.name, `Arrancó la operación real: ${message} · motivo tecleado: ${data.reason}`);
      throw err;
    }
  });

/**
 * «Regresar a pruebas» (§ 4.2, la salida del candado): nombre + frase +
 * motivo, y el plan se niega si hay documentos o bitácora posteriores a la
 * marca — con la salida nombrada (cancelar/revertir primero).
 */
export const clearLiveSince = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      confirmName: z.string().trim().min(1, "Teclea el nombre de la empresa"),
      phrase: z.string().trim().min(1, `Teclea «${LIVE_CLEAR_PHRASE}»`),
      reason: z.string().trim().min(1, "Escribe el motivo"),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await ensureAudit(sql);
    const me = await assertAdmin(sql, context.userId);
    const state = await purgeState(runner(sql), me.company_id);
    try {
      if (data.phrase !== LIVE_CLEAR_PHRASE) throw new Error(`La frase no coincide: teclea exactamente «${LIVE_CLEAR_PHRASE}».`);
      return await withTx(async (tx) => {
        await assertAdmin(tx, context.userId);
        const res = await clearLive(runner(tx), me.company_id, { expectName: data.confirmName });
        await writeAudit(tx, {
          companyId: me.company_id,
          userId: context.userId,
          action: "arranque-real-retirado",
          entity: "company",
          entityId: me.company_id,
          name: res.name,
          detail: `Marca de arranque retirada (estaba puesta desde ${tsOf(res.liveSince)?.slice(0, 10)}); no había documentos ni bitácora posteriores · ${data.reason}`,
        });
        return { company: { id: res.id, name: res.name }, liveSince: null as string | null };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await auditRejected(me.company_id, context.userId, state.name, `Regresar a pruebas: ${message} · motivo tecleado: ${data.reason}`);
      throw err;
    }
  });

/** Para la pantalla: los pasos del plan con su motivo, sin la SQL. */
export function purgePlanSummary() {
  return PURGE.map((s) => ({ step: s.step, table: s.table, kind: s.kind, keeps: s.keeps ?? null, why: s.why ?? null }));
}
