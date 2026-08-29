import { Mail, MessageCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { getMailProfile, sendDirectMail } from "@/lib/erp/alerts";
import { listContacts } from "@/lib/erp/ops";
import { moneyIn } from "@/lib/utils";

export type SendLine = { qty: number; uom?: string; name: string; unitPrice?: number; amount?: number };

export type SendContact = { id: number; name: string; role?: string; email: string; phone: string };

function waDigits(raw: string | null | undefined) {
  const only = String(raw || "").replace(/\D/g, "");
  if (!only) return "";
  if (only.length >= 11) return only;
  if (only.length === 10) return `52${only}`;
  return only;
}

function bodyText(opts: {
  title: string;
  number: string;
  party: string;
  contact?: string;
  lines: SendLine[];
  total?: number;
  extra?: string;
  currency?: string;
  fxRate?: number;
}) {
  const cur = opts.currency === "USD" ? "USD" : "MXN";
  const items = opts.lines
    .slice(0, 30)
    .map((l) => {
      const unit = l.unitPrice != null ? `  P.U. ${moneyIn(l.unitPrice, cur)}` : "";
      const amt = l.amount != null ? `  ${moneyIn(l.amount, cur)}` : l.unitPrice != null ? `  ${moneyIn(l.qty * l.unitPrice, cur)}` : "";
      return `• ${l.qty} ${l.uom || ""} ${l.name}${unit}${amt}`.replace(/\s+/g, " ").trim();
    })
    .join("\n");
  const more = opts.lines.length > 30 ? `\n• +${opts.lines.length - 30} partidas` : "";
  const fx = opts.currency === "USD" && opts.fxRate ? `\nDólar pactado: ${opts.fxRate} MXN` : "";
  const total = opts.total != null ? `\nTotal: ${moneyIn(opts.total, cur)} ${opts.currency ?? ""}`.trim() : "";
  return [
    "AZ INSUMOS AGRICOLAS SA DE CV",
    `${opts.title} ${opts.number}`,
    opts.party ? `Para: ${opts.party}` : "",
    opts.contact ? `Attn: ${opts.contact}` : "",
    "",
    items + more,
    fx,
    total,
    opts.extra ? `\n${opts.extra}` : "",
  ]
    .filter((x) => x !== "")
    .join("\n");
}

function openOutside(href: string) {
  const w = window.open(href, "_blank", "noopener,noreferrer");
  if (w) return;
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function SendButton({
  title,
  number,
  party,
  email,
  phone,
  partnerId,
  lines = [],
  total,
  extra,
  label,
  currency,
  fxRate,
  amount,
}: {
  title: string;
  number: string;
  party: string;
  email?: string | null;
  phone?: string | null;
  partnerId?: number;
  lines?: SendLine[];
  total?: number;
  extra?: string;
  label?: string;
  currency?: string;
  fxRate?: number;
  amount?: number;
}) {
  const [open, setOpen] = useState(false);
  const [contacts, setContacts] = useState<SendContact[]>([]);
  const [pick, setPick] = useState("0");
  const [fromMail, setFromMail] = useState("");
  const [mailReady, setMailReady] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void getMailProfile()
      .then((p) => {
        setFromMail(p.emailFrom);
        setMailReady(p.mailReady);
      })
      .catch(() => undefined);
    if (!partnerId) return;
    void listContacts({ data: { partnerId } })
      .then((rows) => {
        setContacts(rows);
        const billing = rows.find((c) => c.is_billing && (c.email || c.phone));
        const any = rows.find((c) => c.email || c.phone);
        setPick(String((billing ?? any)?.id ?? 0));
      })
      .catch(() => setContacts([]));
  }, [open, partnerId]);

  const chosen = contacts.find((c) => String(c.id) === pick);
  const toEmail = chosen?.email || email || "";
  const toPhone = chosen?.phone || phone || "";
  const toName = chosen ? `${chosen.name}${chosen.role ? ` · ${chosen.role}` : ""}` : "";
  const text = bodyText({
    title,
    number,
    party,
    contact: toName,
    lines,
    total: amount ?? total,
    extra: [extra, total != null && amount != null && amount !== total ? `Saldo: ${moneyIn(total, currency === "USD" ? "USD" : "MXN")}` : ""].filter(Boolean).join("\n"),
    currency,
    fxRate,
  });
  const bcc = fromMail.includes("@") ? `&bcc=${encodeURIComponent(fromMail)}` : "";
  const mail = `mailto:${encodeURIComponent(toEmail)}?subject=${encodeURIComponent(`${title} ${number}`)}${bcc}&body=${encodeURIComponent(text)}`;
  const wa = waDigits(toPhone);
  const waHref = wa ? `https://wa.me/${wa}?text=${encodeURIComponent(text)}` : "";

  return (
    <>
      <button type="button" className="erp-btn h-8 text-[12px]" onClick={() => setOpen(true)}>
        <Mail className="mr-1 inline size-3.5" />
        {label ?? "Enviar"}
      </button>
      {open ? (
        <div className="fixed inset-0 z-[90] grid place-items-center bg-ink/40 p-4" onClick={() => setOpen(false)}>
          <div className="w-full max-w-md rounded-xl border border-line bg-cream p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-base font-semibold">
              Enviar {title} {number}
            </h2>
            <p className="mt-1 text-sm text-muted">{party}</p>

            <label className="mt-3 grid gap-1 text-[12px] font-medium">
              Contacto
              <select className="erp-input" value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="0">Empresa (datos generales)</option>
                {contacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.role ? ` · ${c.role}` : ""}
                    {c.phone ? " · WA" : ""}
                    {c.email ? " · mail" : ""}
                  </option>
                ))}
              </select>
            </label>
            <p className="mt-1 text-[11px] text-muted">
              {toEmail ? `Correo: ${toEmail}` : "Sin correo"}
              {" · "}
              {toPhone ? `WhatsApp: ${toPhone}` : "Sin teléfono"}
            </p>
            <p className="mt-2 rounded-md bg-paper px-3 py-2 text-[12px] text-ink-soft">
              El programa de correo abre con tu cuenta de siempre (ahora Plein Produce). En el campo <strong>De:</strong> elige el correo de Azagro
              {fromMail ? ` (${fromMail})` : ""}. En Outlook Mac: Configuración → Cuentas → agregar el de Azagro; al redactar, clic en De: y cámbialo.
              {mailReady ? " También puedes enviar directo desde Azagro, sin abrir Outlook." : ""}
            </p>

            <pre className="mt-3 max-h-48 overflow-auto rounded-md bg-paper p-3 text-[12px] whitespace-pre-wrap">{text}</pre>
            <div className="mt-4 flex flex-wrap gap-2">
              <a className={`erp-btn-primary inline-flex items-center ${toEmail ? "" : "pointer-events-none opacity-50"}`} href={toEmail ? mail : undefined}>
                <Mail className="mr-1 size-3.5" />
                Abrir Outlook
              </a>
              {mailReady ? (
                <button
                  type="button"
                  className="erp-btn-primary"
                  disabled={!toEmail}
                  onClick={async () => {
                    setNotice(null);
                    try {
                      const r = await sendDirectMail({ data: { to: toEmail, subject: `${title} ${number}`, text } });
                      setNotice(r.notice);
                    } catch (e) {
                      setNotice(e instanceof Error ? e.message : "No se pudo enviar");
                    }
                  }}
                >
                  Enviar como Azagro
                </button>
              ) : null}
              <button
                type="button"
                className="erp-btn inline-flex items-center"
                disabled={!waHref}
                onClick={() => {
                  if (!waHref) return;
                  openOutside(waHref);
                  setOpen(false);
                }}
              >
                <MessageCircle className="mr-1 size-3.5" />
                WhatsApp
              </button>
              <button type="button" className="erp-btn ml-auto" onClick={() => setOpen(false)}>
                Cerrar
              </button>
            </div>
            {notice ? <p className="mt-3 text-[12px] text-ok">{notice}</p> : null}
            {!toEmail && !toPhone ? (
              <p className="mt-3 text-[12px] text-danger">Este contacto no tiene correo ni teléfono. Elige otro o agrégalo en Contactos.</p>
            ) : !waHref ? (
              <p className="mt-3 text-[12px] text-muted">Sin WhatsApp en este contacto. Elige otro del catálogo o captura el teléfono en Contactos.</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
