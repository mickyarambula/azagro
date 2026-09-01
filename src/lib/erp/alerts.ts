import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { exactClock } from "@/lib/erp/credit";
import { activeMember, assertCan } from "@/lib/erp/acl";
import { writeAudit } from "@/lib/erp/audit";
import { money } from "@/lib/utils";

type Sql = Awaited<ReturnType<typeof getSql>>;

async function cid(sql: Sql, userId: string) {
  const rows = await sql<{ company_id: number }>`select company_id from members where user_id = ${userId} and status = 'active' limit 1`;
  if (!rows[0]) throw new Error("Sin empresa");
  return rows[0].company_id;
}

async function ensureAlerts(sql: Sql) {
  await sql.query(`
    create table if not exists notifications (
      id serial primary key,
      company_id integer not null references companies(id) on delete cascade,
      kind text not null default 'due',
      title text not null,
      body text not null default '',
      payload jsonb not null default '{}',
      read_at timestamptz,
      created_at timestamptz not null default now()
    )
  `);
  await sql`alter table company_settings add column if not exists alert_days_cxc integer not null default 7`;
  await sql`alter table company_settings add column if not exists alert_days_cxp integer not null default 7`;
  await sql`alter table company_settings add column if not exists alert_email text not null default ''`;
  await sql`alter table company_settings add column if not exists alert_email_on boolean not null default true`;
  await sql`alter table company_settings add column if not exists resend_key text not null default ''`;
}

async function buildDigest(sql: Sql, companyId: number) {
  await ensureAlerts(sql);
  const cfg = await sql<{
    alert_days_cxc: number;
    alert_days_cxp: number;
    alert_email: string;
    alert_email_on: boolean;
    legal_name: string;
    email_from: string;
  }>`
    select coalesce(alert_days_cxc,7)::int as alert_days_cxc, coalesce(alert_days_cxp,7)::int as alert_days_cxp,
      coalesce(alert_email,'') as alert_email, coalesce(alert_email_on,true) as alert_email_on,
      legal_name, coalesce(email_from,'') as email_from
    from company_settings where company_id = ${companyId}
  `;
  const warnCxc = cfg[0]?.alert_days_cxc ?? 7;
  const warnCxp = cfg[0]?.alert_days_cxp ?? 7;
  const to = (cfg[0]?.alert_email || "").trim();
  const enabled = cfg[0]?.alert_email_on !== false;
  const asOf = new Date().toISOString().slice(0, 10);
  const rows = await sql<{
    name: string;
    kind: string;
    partner: string;
    due_date: string;
    residual: string;
  }>`
    select i.name, i.kind, p.name as partner, i.due_date::text, i.residual::text
    from invoices i
    join partners p on p.id = i.partner_id
    where i.company_id = ${companyId} and i.state <> 'paid' and i.residual > 0.009
    order by i.due_date, i.id
  `;
  const items = rows
    .map((r) => {
      const clock = exactClock(r.due_date, asOf);
      const warn = r.kind === "supplier" ? warnCxp : warnCxc;
      const alert = clock.status === "overdue" || clock.status === "today" || clock.days <= warn;
      return {
        name: r.name,
        kind: r.kind as "customer" | "supplier",
        partner: r.partner,
        due: r.due_date,
        residual: Number(r.residual),
        label: clock.label,
        alert,
        overdue: clock.status === "overdue",
      };
    })
    .filter((r) => r.alert);
  const cxc = items.filter((i) => i.kind === "customer");
  const cxp = items.filter((i) => i.kind === "supplier");
  const payload = {
    asOf,
    cxc: cxc.map((i) => ({ folio: i.name, partner: i.partner, due: i.due, residual: i.residual, clock: i.label })),
    cxp: cxp.map((i) => ({ folio: i.name, partner: i.partner, due: i.due, residual: i.residual, clock: i.label })),
  };
  const subject = `Azagro · ${cxc.length} por cobrar y ${cxp.length} por pagar en alerta`;
  const body = [
    cfg[0]?.legal_name || "AZAGRO",
    `Alertas de vencimiento · corte ${asOf}`,
    "",
    cxc.length ? "POR COBRAR" : "",
    ...cxc.map((i) => `• ${i.name}  ${i.partner}  vence ${i.due}  ${i.label}  ${money(i.residual)}`),
    cxp.length ? "POR PAGAR" : "",
    ...cxp.map((i) => `• ${i.name}  ${i.partner}  vence ${i.due}  ${i.label}  ${money(i.residual)}`),
  ]
    .filter(Boolean)
    .join("\n");
  const mailto = to
    ? `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    : "";
  return {
    enabled,
    to,
    from: cfg[0]?.email_from || "",
    legalName: cfg[0]?.legal_name || "AZ INSUMOS AGRICOLAS SA DE CV",
    asOf,
    warnCxc,
    warnCxp,
    cxc: cxc.length,
    cxp: cxp.length,
    items,
    payload,
    subject,
    body,
    mailto,
    resendReady: Boolean(process.env.RESEND_API_KEY),
  };
}

export const getAlertDigest = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    // El resumen trae folios y saldos de cartera: sin permiso de cartera va vacío
    // (la campana la ve todo el equipo, no debe tronar).
    const me = await activeMember(sql, context.userId);
    if (me.acl.credit === "none") {
      const asOf = new Date().toISOString().slice(0, 10);
      return {
        enabled: false,
        to: "",
        from: "",
        legalName: "",
        asOf,
        warnCxc: 0,
        warnCxp: 0,
        cxc: 0,
        cxp: 0,
        items: [] as Awaited<ReturnType<typeof buildDigest>>["items"],
        payload: { asOf, cxc: [], cxp: [] },
        subject: "",
        body: "",
        mailto: "",
        resendReady: false,
      };
    }
    return buildDigest(sql, companyId);
  });

export const listNotifications = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    await ensureAlerts(sql);
    const rows = await sql<{
      id: number;
      kind: string;
      title: string;
      body: string;
      read_at: string | null;
      created_at: string;
    }>`
      select id, kind, title, body, read_at::text, created_at::text
      from notifications where company_id = ${companyId}
      order by id desc limit 30
    `;
    return { rows, unread: rows.filter((r) => !r.read_at).length };
  });

export const markNotificationsRead = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ id: z.number().optional() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    if (data.id) {
      await sql`update notifications set read_at = now() where company_id = ${companyId} and id = ${data.id}`;
    } else {
      await sql`update notifications set read_at = now() where company_id = ${companyId} and read_at is null`;
    }
    return { ok: true };
  });

async function mailAccount(sql: Sql, companyId: number) {
  await ensureAlerts(sql);
  const r = await sql<{ email_from: string; legal_name: string; resend_key: string }>`
    select coalesce(email_from,'') as email_from, legal_name, coalesce(resend_key,'') as resend_key
    from company_settings where company_id = ${companyId}
  `;
  const key = process.env.RESEND_API_KEY || r[0]?.resend_key || "";
  const emailFrom = r[0]?.email_from || "";
  const legal = r[0]?.legal_name || "AZ INSUMOS AGRICOLAS SA DE CV";
  const from = emailFrom.includes("@") ? `${legal} <${emailFrom}>` : emailFrom || `${legal} <beth.t@example.com>`;
  return { key, emailFrom, legal, from, ready: key.length > 8 };
}

async function sendResend(opts: { key: string; from: string; to: string[]; subject: string; text: string }) {
  if (!opts.key) return { ok: false as const, reason: "no_key" };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: opts.from, to: opts.to, subject: opts.subject, text: opts.text }),
  });
  if (!res.ok) {
    const err = await res.text();
    return { ok: false as const, reason: err.slice(0, 200) };
  }
  return { ok: true as const };
}

export const getMailProfile = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const acc = await mailAccount(sql, await cid(sql, context.userId));
    return { emailFrom: acc.emailFrom, legalName: acc.legal, mailReady: acc.ready };
  });

export const sendDirectMail = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ to: z.string(), subject: z.string(), text: z.string() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    // Escribir a nombre de la empresa exige permiso de cartera, no basta la sesión.
    await assertCan(sql, context.userId, "credit", "edit");
    const acc = await mailAccount(sql, companyId);
    const to = data.to.split(/[,;]/).map((s) => s.trim()).filter((s) => s.includes("@"));
    if (!to.length) throw new Error("Falta el correo destino");
    if (!acc.ready) throw new Error("Aún no hay envío directo. Se abre Outlook: en De: elige la cuenta de Azagro.");
    const sent = await sendResend({ key: acc.key, from: acc.from, to, subject: data.subject, text: data.text });
    if (!sent.ok) throw new Error(`No se pudo enviar: ${sent.reason}`);
    await writeAudit(sql, {
      companyId,
      userId: context.userId,
      action: "correo",
      entity: "mail",
      name: data.subject.slice(0, 120),
      detail: `Para ${to.join(", ")}`,
    });
    return { ok: true, notice: `Enviado desde ${acc.emailFrom || "Azagro"} a ${to.join(", ")}.` };
  });

export const sendPaymentReminder = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ invoiceId: z.number() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    await assertCan(sql, context.userId, "credit", "edit");
    const acc = await mailAccount(sql, companyId);
    const inv = await sql<{
      name: string;
      kind: string;
      residual: string;
      amount: string;
      due_date: string;
      partner: string;
      email: string;
    }>`
      select i.name, i.kind, i.residual::text, i.amount::text, i.due_date::text, p.name as partner, coalesce(p.email,'') as email
      from invoices i join partners p on p.id = i.partner_id
      where i.id = ${data.invoiceId} and i.company_id = ${companyId}
    `;
    if (!inv[0]) throw new Error("Factura no encontrada");
    const clock = exactClock(inv[0].due_date);
    const subject =
      inv[0].kind === "customer"
        ? `Recordatorio de pago ${inv[0].name} · ${inv[0].partner}`
        : `Pago a proveedor ${inv[0].name} · ${inv[0].partner}`;
    const text = [
      acc.legal,
      "",
      inv[0].kind === "customer"
        ? `Estimados ${inv[0].partner}:`
        : `Recordatorio interno de pago a ${inv[0].partner}:`,
      "",
      `Folio ${inv[0].name}`,
      `Importe ${money(Number(inv[0].amount))}`,
      `Saldo ${money(Number(inv[0].residual))}`,
      `Vencimiento ${inv[0].due_date} · ${clock.label}`,
      "",
      inv[0].kind === "customer"
        ? "Agradecemos su pronto pago a la cuenta de AZ INSUMOS AGRICOLAS SA DE CV."
        : "Programar el pago con saldo en banco Azagro.",
    ].join("\n");
    const to =
      inv[0].kind === "customer"
        ? inv[0].email
        : (await sql<{ alert_email: string }>`select coalesce(alert_email,'') as alert_email from company_settings where company_id = ${companyId}`)[0]
            ?.alert_email || acc.emailFrom;
    const mailto = to
      ? `mailto:${encodeURIComponent(to)}?bcc=${encodeURIComponent(acc.emailFrom)}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`
      : "";
    if (acc.ready && to.includes("@")) {
      const sent = await sendResend({
        key: acc.key,
        from: acc.from,
        to: to.split(/[,;]/).map((s) => s.trim()).filter((s) => s.includes("@")),
        subject,
        text,
      });
      if (sent.ok) {
        // Si el cliente dice "nunca me cobraron", aquí está la prueba.
        await writeAudit(sql, {
          companyId,
          userId: context.userId,
          action: "recordatorio",
          entity: "invoice",
          entityId: data.invoiceId,
          name: inv[0].name,
          detail: `Enviado a ${to} · saldo ${inv[0].residual}`,
        });
        return { sent: "resend" as const, notice: `Recordatorio enviado a ${to}.`, mailto, subject, text, to };
      }
    }
    await writeAudit(sql, {
      companyId,
      userId: context.userId,
      action: "recordatorio",
      entity: "invoice",
      entityId: data.invoiceId,
      name: inv[0].name,
      detail: `Borrador abierto en el correo del usuario para ${to || "(sin destinatario)"}`,
    });
    return { sent: "mailto" as const, notice: "Se abre el correo. En De: elige la cuenta de Azagro.", mailto, subject, text, to };
  });

export const sendPartnerReminders = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    await assertCan(sql, context.userId, "credit", "edit");
    const d = await buildDigest(sql, companyId);
    const acc = await mailAccount(sql, companyId);
    const customers = d.items.filter((i) => i.kind === "customer" && i.alert);
    let sentN = 0;
    const failed: string[] = [];
    if (acc.ready) {
      const rows = await sql<{ name: string; email: string; residual: string; due_date: string; partner: string }>`
        select i.name, coalesce(p.email,'') as email, i.residual::text, i.due_date::text, p.name as partner
        from invoices i join partners p on p.id = i.partner_id
        where i.company_id = ${companyId} and i.kind = 'customer' and i.state <> 'paid' and i.residual > 0.009
      `;
      for (const r of rows) {
        if (!customers.some((c) => c.name === r.name)) continue;
        if (!r.email.includes("@")) {
          failed.push(r.partner);
          continue;
        }
        const clock = exactClock(r.due_date);
        const text = `${acc.legal}\n\nEstimados ${r.partner}:\nFolio ${r.name}\nSaldo ${money(Number(r.residual))}\nVence ${r.due_date} · ${clock.label}\n\nAgradecemos su pronto pago.`;
        const sent = await sendResend({
          key: acc.key,
          from: acc.from,
          to: [r.email],
          subject: `Recordatorio de pago ${r.name}`,
          text,
        });
        if (sent.ok) sentN += 1;
        else failed.push(r.partner);
      }
      await writeAudit(sql, {
        companyId,
        userId: context.userId,
        action: "recordatorio",
        entity: "mail",
        name: "Recordatorios masivos",
        detail: `${sentN} clientes con recordatorio enviado${failed.length ? ` · sin correo o fallidos: ${failed.join(", ")}` : ""}`.slice(0, 900),
      });
      return {
        sent: "resend" as const,
        notice: `Recordatorios a clientes: ${sentN} enviados.${failed.length ? ` Sin correo: ${failed.join(", ")}.` : ""}`,
        mailto: "",
      };
    }
    return { sent: "mailto" as const, notice: "Aún no hay envío directo. Usa Recordatorio en cada factura.", mailto: d.mailto };
  });

export const sendDueAlerts = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    await assertCan(sql, context.userId, "credit", "edit");
    const d = await buildDigest(sql, companyId);
    if (d.cxc + d.cxp === 0) return { ...d, sent: "none" as const, notice: "No hay vencimientos en alerta." };
    try {
      await sql`
        insert into notifications (company_id, kind, title, body)
        values (${companyId}, 'due', ${d.subject}, ${d.body})
      `;
    } catch {
      /* inbox is secondary to sending */
    }
    const to = d.to.split(/[,;]/).map((s) => s.trim()).filter((s) => s.includes("@"));
    const acc = await mailAccount(sql, companyId);
    if (to.length && acc.ready) {
      const sent = await sendResend({ key: acc.key, from: acc.from, to, subject: d.subject, text: d.body });
      if (sent.ok) {
        await writeAudit(sql, {
          companyId,
          userId: context.userId,
          action: "recordatorio",
          entity: "mail",
          name: "Aviso interno de vencimientos",
          detail: `Enviado a ${to.join(", ")} · ${d.cxc} por cobrar · ${d.cxp} por pagar`,
        });
        return { ...d, sent: "resend" as const, notice: `Correo enviado a ${to.join(", ")}.` };
      }
      return { ...d, sent: "mailto" as const, notice: `No se pudo enviar solo (${sent.reason}). Se abre el correo del equipo.` };
    }
    if (d.mailto) return { ...d, sent: "mailto" as const, notice: "Se abre el correo del equipo. En De: elige la cuenta de Azagro, no la de Plein Produce." };
    return { ...d, sent: "inbox" as const, notice: "Quedó en el centro de avisos. Pon correos en Ajustes para mandarlo." };
  });
