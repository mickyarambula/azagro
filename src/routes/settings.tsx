import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { AppShell } from "@/components/app-shell";
import { Field, PageHead, Panel } from "@/components/erp";
import { useAccess } from "@/lib/access";
import { getSettings, saveFx, saveSettings, saveTiie } from "@/lib/erp/ops";
import { BUSINESS_RULES, YEAR_DAYS } from "@/lib/erp/rules";
import { dbStatus, exportBackup } from "@/lib/erp/cutover";
import { applyTheme, readThemePref, type ThemePref } from "@/lib/theme";
import { todayMx } from "@/lib/utils";

export const Route = createFileRoute("/settings")({ component: Page });

function Page() {
  return (
    <AppShell>
      <SettingsBody />
    </AppShell>
  );
}

function SettingsBody() {
  const { can, role } = useAccess();
  const editable = can("settings", "edit");
  const [form, setForm] = useState({
    legalName: "AZ INSUMOS AGRICOLAS SA DE CV",
    rfc: "",
    creditDays: 150,
    invoiceDays: 120,
    fegaRate: 0.0304,
    collectionSpread: 0.09,
    financeSpread: 0.045,
    defaultTiie: 0.0706,
    asrCommission: 0.01,
    asrSpread: 0.04,
    earlyPayDays: 120,
    emailFrom: "",
    phone: "",
    alertDaysCxc: 7,
    alertDaysCxp: 7,
    alertEmail: "",
    alertEmailOn: true,
    resendKey: "",
    mailReady: false,
  });
  const [tiie, setTiie] = useState<Array<{ date: string; rate: string }>>([]);
  const [fx, setFx] = useState<Array<{ date: string; usd_mxn: string }>>([]);
  const [tDate, setTDate] = useState(() => todayMx());
  const [tRate, setTRate] = useState(0.0706);
  const [fDate, setFDate] = useState(() => todayMx());
  const [fRate, setFRate] = useState(18);
  const [msg, setMsg] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemePref>("system");
  const [dbLabel, setDbLabel] = useState("");

  async function load() {
    const s = await getSettings();
    setForm({
      legalName: s.legalName,
      rfc: s.rfc,
      creditDays: s.creditDays,
      invoiceDays: s.invoiceDays,
      fegaRate: s.fegaRate,
      collectionSpread: s.collectionSpread,
      financeSpread: s.financeSpread,
      defaultTiie: s.defaultTiie,
      asrCommission: s.asrCommission,
      asrSpread: s.asrSpread,
      earlyPayDays: s.earlyPayDays ?? 120,
      emailFrom: s.emailFrom,
      phone: s.phone,
      alertDaysCxc: s.alertDaysCxc ?? 7,
      alertDaysCxp: s.alertDaysCxp ?? 7,
      alertEmail: s.alertEmail ?? "",
      alertEmailOn: s.alertEmailOn ?? true,
      resendKey: "",
      mailReady: s.mailReady ?? false,
    });
    setTiie(s.tiie);
    setFx(s.fx);
  }
  useEffect(() => {
    void load();
    setTheme(readThemePref());
    void dbStatus()
      .then((d) => setDbLabel(d.label))
      .catch(() => undefined);
  }, []);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    const { mailReady: _ready, ...rest } = form;
    await saveSettings({ data: rest });
    setMsg("Política guardada");
    await load();
  }

  return (
    <>
      <PageHead
        title="Configuración"
        hint="Reglas de crédito, TIIE, tipo de cambio y circuito ASR. Los días se cuentan calendario exacto; el interés usa año comercial 360."
      />
      {msg && <p className="mb-3 text-sm text-ok">{msg}</p>}
      {dbLabel && (
        <Panel className="mb-4">
          <h2 className="text-sm font-semibold">Base de datos</h2>
          <p className="mt-1 text-sm text-muted">{dbLabel}. Recibir, entregar, devolver y cobrar van en una sola transacción. Bitácora en Ajustes.</p>
          <button
            type="button"
            className="erp-btn mt-3"
            onClick={async () => {
              const d = await exportBackup();
              const blob = new Blob([JSON.stringify(d, null, 2)], { type: "application/json" });
              const a = document.createElement("a");
              a.href = URL.createObjectURL(blob);
              a.download = `azagro-respaldo-${d.at.slice(0, 10)}.json`;
              a.click();
            }}
          >
            Descargar respaldo
          </button>
        </Panel>
      )}

      <Panel className="mb-4">
        <h2 className="text-sm font-semibold">Reglas de negocio</h2>
        <p className="mt-0.5 text-sm text-muted">Esto es lo que el sistema aplica. Las tasas de abajo son los números; estas son las políticas.</p>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          {BUSINESS_RULES.map((r) => (
            <div key={r.id} className="rounded-lg border border-line bg-paper p-3">
              <dt className="text-sm font-semibold">{r.title}</dt>
              <dd className="mt-1 text-[13px] leading-snug text-muted">{r.body}</dd>
            </div>
          ))}
        </dl>
      </Panel>

      <Panel className="mb-4">
        <h2 className="text-sm font-semibold">Cómo mandar correos de Azagro (sin mezclar con Plein Produce)</h2>
        <ol className="mt-3 space-y-2 text-[13px] leading-snug text-ink-soft">
          <li>
            <strong>1.</strong> Más abajo, en “Correo de Azagro”, escribe el correo de esta empresa (ej. cobranza@azagro.com) y pulsa Guardar al final de la página.
          </li>
          <li>
            <strong>2.</strong> En tu Mac, abre Outlook → Configuración → Cuentas → el + para agregar cuenta. Entra el correo de Azagro (el de Plein Produce se queda; no lo borres).
          </li>
          <li>
            <strong>3.</strong> En el ERP pulsa Enviar. Se abre Outlook. Arriba, en <strong>De:</strong>, cambia Plein Produce por Azagro. Luego Enviar.
          </li>
        </ol>
        <p className="mt-3 text-[13px] text-muted">
          Eso basta. No hace falta “Resend” ni ninguna clave. Resend es un cartero automático para el día que el sistema mande solo, sin abrir Outlook. Hoy no lo uses.
        </p>
      </Panel>

      <Panel className="mb-4">
        <h2 className="text-sm font-semibold">Apariencia</h2>
        <p className="mt-0.5 text-sm text-muted">El sistema sigue tu elección. Los documentos se capturan igual.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {(
            [
              ["light", "Claro"],
              ["dark", "Oscuro"],
              ["system", "Sistema"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={theme === id ? "erp-btn-primary" : "erp-btn"}
              onClick={() => {
                setTheme(id);
                applyTheme(id);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </Panel>

      <form onSubmit={onSave} className="grid gap-3 erp-card p-4 md:grid-cols-3">
        <Field label="Razón social" className="md:col-span-2">
          <input className="erp-input" value={form.legalName} onChange={(e) => setForm({ ...form, legalName: e.target.value })} />
        </Field>
        <Field label="RFC">
          <input className="erp-input" value={form.rfc} onChange={(e) => setForm({ ...form, rfc: e.target.value })} />
        </Field>
        <Field label="Correo de Azagro (el que debe salir en De:)" className="md:col-span-2">
          <input
            className="erp-input"
            type="email"
            value={form.emailFrom}
            placeholder="cobranza@azagro.com"
            onChange={(e) => setForm({ ...form, emailFrom: e.target.value })}
          />
          <p className="mt-1 text-[11px] font-normal normal-case tracking-normal text-muted">
            Este es el correo de la empresa. Plein Produce y Azagro pueden convivir: en Outlook agregas las dos cuentas y, al mandar, eliges De: Azagro.
          </p>
        </Field>
        <Field label="Teléfono">
          <input className="erp-input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </Field>
        <Field label="Alerta CxC (días antes)">
          <input
            className="erp-input"
            type="number"
            value={form.alertDaysCxc}
            onChange={(e) => setForm({ ...form, alertDaysCxc: Number(e.target.value) })}
          />
        </Field>
        <Field label="Alerta CxP (días antes)">
          <input
            className="erp-input"
            type="number"
            value={form.alertDaysCxp}
            onChange={(e) => setForm({ ...form, alertDaysCxp: Number(e.target.value) })}
          />
        </Field>
        <Field label="Correos de alerta" className="md:col-span-2">
          <input
            className="erp-input"
            value={form.alertEmail}
            placeholder="admin@azagro.com, cobranza@azagro.com"
            onChange={(e) => setForm({ ...form, alertEmail: e.target.value })}
          />
          <p className="mt-1 text-[11px] font-normal normal-case tracking-normal text-muted">
            Avisos internos de Azagro (tú, cobranza, dirección). No es el correo del cliente.
          </p>
        </Field>
        <Field label="Clave de envío automático (opcional, más adelante)" className="md:col-span-3">
          <input
            className="erp-input"
            type="password"
            value={form.resendKey}
            placeholder={form.mailReady ? "Ya quedó guardada. Vacío = no la cambies." : "Déjalo vacío por ahora"}
            onChange={(e) => setForm({ ...form, resendKey: e.target.value })}
          />
          <p className="mt-1 text-[11px] font-normal normal-case tracking-normal text-muted">
            Solo si un día quieren que el ERP mande solo. Se saca en resend.com, se verifica el dominio de Azagro y se pega aquí. No uses una clave de Plein Produce. Mientras esté vacío, Enviar sigue abriendo Outlook.
          </p>
        </Field>
        <Field label="Alertas por correo">
          <label className="flex h-10 items-center gap-2 text-sm font-normal normal-case tracking-normal text-ink">
            <input
              type="checkbox"
              checked={form.alertEmailOn}
              onChange={(e) => setForm({ ...form, alertEmailOn: e.target.checked })}
            />
            Mostrar barra y permitir envío
          </label>
        </Field>
        <Field label="Plazo factura (días) — vencimiento visible al cliente">
          <input className="erp-input" type="number" value={form.invoiceDays} onChange={(e) => setForm({ ...form, invoiceDays: Number(e.target.value) })} />
        </Field>
        <Field label="Plazo financiero / mora (días) — aquí arranca el interés">
          <input className="erp-input" type="number" value={form.creditDays} onChange={(e) => setForm({ ...form, creditDays: Number(e.target.value) })} />
        </Field>
        <Field label="Umbral pronto pago (días)">
          <input className="erp-input" type="number" value={form.earlyPayDays} onChange={(e) => setForm({ ...form, earlyPayDays: Number(e.target.value) })} />
        </Field>
        <Field label="FEGA + comisión (única vez)">
          <input className="erp-input" type="number" step="0.0001" value={form.fegaRate} onChange={(e) => setForm({ ...form, fegaRate: Number(e.target.value) })} />
        </Field>
        <Field label="Spread de línea (en precio, %)">
          <input className="erp-input" type="number" step="0.0001" value={form.financeSpread} onChange={(e) => setForm({ ...form, financeSpread: Number(e.target.value) })} />
        </Field>
        <Field label="Spread mora (factura de intereses, %)">
          <input className="erp-input" type="number" step="0.0001" value={form.collectionSpread} onChange={(e) => setForm({ ...form, collectionSpread: Number(e.target.value) })} />
        </Field>
        <Field label="TIIE por omisión">
          <input className="erp-input" type="number" step="0.0001" value={form.defaultTiie} onChange={(e) => setForm({ ...form, defaultTiie: Number(e.target.value) })} />
        </Field>
        <Field label="Comisión ASR">
          <input className="erp-input" type="number" step="0.0001" value={form.asrCommission} onChange={(e) => setForm({ ...form, asrCommission: Number(e.target.value) })} />
        </Field>
        <Field label="Spread ASR (TIIE + )">
          <input className="erp-input" type="number" step="0.0001" value={form.asrSpread} onChange={(e) => setForm({ ...form, asrSpread: Number(e.target.value) })} />
        </Field>
        <p className="md:col-span-3 text-sm text-muted">
          Mora (solo factura FI si ya venció) = Cargo × (TIIE + {((form.collectionSpread || 0) * 100).toFixed(1)}%) × días exactos / {YEAR_DAYS}. En el estado de cuenta, Comisión 1% + FEGA 2.04% = 3.04% sobre el cargo (columna «Comisión + FEGA»); no se mete al precio del producto.
          Costo de línea en cotización = TIIE + {((form.financeSpread || 0) * 100).toFixed(1)}% × días exactos / {YEAR_DAYS}.
        </p>
        {editable && <button className="erp-btn-primary">Guardar política</button>}
      </form>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <Panel>
          <h2 className="text-sm font-semibold">Tabla TIIE</h2>
          {role === "admin" ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <input className="erp-input" type="date" value={tDate} onChange={(e) => setTDate(e.target.value)} />
              <input className="erp-input w-28" type="number" step="0.0001" value={tRate} onChange={(e) => setTRate(Number(e.target.value))} />
              <button
                type="button"
                className="erp-btn"
                onClick={() => saveTiie({ data: { date: tDate, rate: tRate } }).then(load)}
              >
                Agregar
              </button>
            </div>
          ) : (
            <p className="mt-2 text-xs text-muted">Solo un administrador puede cambiar la TIIE.</p>
          )}
          <ul className="mt-3 text-sm">
            {tiie.map((r) => (
              <li key={r.date} className="flex justify-between border-b border-line py-1.5">
                <span>{r.date}</span>
                <span className="tabular-nums">{(Number(r.rate) * 100).toFixed(2)}%</span>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel>
          <h2 className="text-sm font-semibold">Tipo de cambio USD/MXN</h2>
          {role === "admin" ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <input className="erp-input" type="date" value={fDate} onChange={(e) => setFDate(e.target.value)} />
              <input className="erp-input w-28" type="number" step="0.0001" value={fRate} onChange={(e) => setFRate(Number(e.target.value))} />
              <button type="button" className="erp-btn" onClick={() => saveFx({ data: { date: fDate, usdMxn: fRate } }).then(load)}>
                Agregar
              </button>
            </div>
          ) : (
            <p className="mt-2 text-xs text-muted">Solo un administrador puede cambiar el tipo de cambio.</p>
          )}
          <ul className="mt-3 text-sm">
            {fx.map((r) => (
              <li key={r.date} className="flex justify-between border-b border-line py-1.5">
                <span>{r.date}</span>
                <span className="tabular-nums">{Number(r.usd_mxn).toFixed(4)}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </>
  );
}
