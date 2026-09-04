import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useEffect, useState, type FormEvent } from "react";
import { AppShell } from "@/components/app-shell";
import { Field, PageHead, Panel } from "@/components/erp";
import { useAccess } from "@/lib/access";
import { creditPolicyUsage, getSettingsForm, listCreditPolicies, POLICY_FIELDS, QUOTE_TERMS_LABEL, saveCreditPolicy, saveFx, saveSettings, saveTiie, type CreditPolicyRow, type PolicyField } from "@/lib/erp/ops";
import { formatTerms, parseTerms } from "@/lib/erp/ladder";
import { BUSINESS_RULES, YEAR_DAYS } from "@/lib/erp/rules";
import { dbStatus, exportBackup } from "@/lib/erp/cutover";
import { applyTheme, readThemePref, type ThemePref } from "@/lib/theme";
import { moneyIn, todayMx } from "@/lib/utils";

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
  // Los números de negocio (plazos, spreads, comisiones, umbral) NO tienen
  // valor inicial aquí: nacen vacíos y se leen de la base. Un renglón sin
  // capturar se muestra como pendiente y el resto del sistema se detiene
  // hasta que alguien lo escriba. Nunca un número de respaldo en el código.
  const [form, setForm] = useState({
    legalName: "",
    rfc: "",
    emailFrom: "",
    phone: "",
    alertDaysCxc: 7,
    alertDaysCxp: 7,
    alertEmail: "",
    alertEmailOn: true,
    resendKey: "",
    mailReady: false,
  });
  const [policy, setPolicy] = useState<Record<PolicyField, number | null>>({
    creditDays: null,
    invoiceDays: null,
    fegaRate: null,
    fegaCommission: null,
    collectionSpread: null,
    asrCommission: null,
    asrSpread: null,
    earlyPayDays: null,
  });
  const [missing, setMissing] = useState<string[]>([]);
  // Escalera de plazos de la cotización interna: texto "0, 30, 60…" tal cual
  // se captura; vacío = sin capturar (la base la trae sembrada).
  const [quoteTerms, setQuoteTerms] = useState("");
  // Políticas de cobro: cobra comisión sí/no, cobra FEGA sí/no. Nulo = sin
  // capturar; no se propone un valor.
  const [policies, setPolicies] = useState<CreditPolicyRow[]>([]);
  const [polEdit, setPolEdit] = useState<Record<string, { commission: string; fega: string }>>({});
  // Quién está en cada política: solo lectura y solo administrador (dice cuánto
  // debe cada cliente). Se lee aparte de los Ajustes porque el servidor lo
  // rechaza para cualquier otro rol.
  const [usage, setUsage] = useState<Awaited<ReturnType<typeof creditPolicyUsage>> | null>(null);
  const [openPolicy, setOpenPolicy] = useState<string | null>(null);
  const [tiie, setTiie] = useState<Array<{ date: string; rate: string }>>([]);
  const [fx, setFx] = useState<Array<{ date: string; usd_mxn: string }>>([]);
  const [tDate, setTDate] = useState(() => todayMx());
  const [tRate, setTRate] = useState<number | null>(null);
  const [fDate, setFDate] = useState(() => todayMx());
  const [fRate, setFRate] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemePref>("system");
  const [dbLabel, setDbLabel] = useState("");

  async function load() {
    // Lectura tolerante: esta es la única pantalla que puede abrirse con
    // Ajustes incompletos, precisamente para completarlos.
    const s = await getSettingsForm();
    setForm({
      legalName: s.legalName,
      rfc: s.rfc,
      emailFrom: s.emailFrom,
      phone: s.phone,
      alertDaysCxc: s.alertDaysCxc ?? 7,
      alertDaysCxp: s.alertDaysCxp ?? 7,
      alertEmail: s.alertEmail ?? "",
      alertEmailOn: s.alertEmailOn ?? true,
      resendKey: "",
      mailReady: s.mailReady ?? false,
    });
    setPolicy(s.values);
    setMissing(s.missing);
    setQuoteTerms(s.quoteTerms ? formatTerms(s.quoteTerms) : "");
    setTiie(s.tiie);
    setFx(s.fx);
    const cps = await listCreditPolicies().catch(() => []);
    setPolicies(cps);
    const yn = (v: boolean | null) => (v == null ? "" : v ? "si" : "no");
    setPolEdit(Object.fromEntries(cps.map((c) => [c.code, { commission: yn(c.commission), fega: yn(c.fega) }])));
  }

  async function loadUsage() {
    if (role !== "admin") return;
    setUsage(await creditPolicyUsage().catch(() => null));
  }

  async function onSavePolicy(code: string) {
    setError(null);
    setMsg(null);
    const e = polEdit[code];
    if (!e || !e.commission || !e.fega) {
      setError("Contesta las dos preguntas de la política (comisión y FEGA) antes de guardar.");
      return;
    }
    try {
      await saveCreditPolicy({ data: { code, commission: e.commission === "si", fega: e.fega === "si" } });
      setMsg(`Política ${code} guardada`);
      await load();
      // Capturarla mueve documentos del renglón "sin política" al suyo.
      await loadUsage();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la política");
    }
  }
  const setNum = (k: PolicyField, raw: string) => setPolicy({ ...policy, [k]: raw.trim() === "" ? null : Number(raw) });
  const numInput = (k: PolicyField, step?: string) => (
    <input
      className="erp-input"
      type="number"
      step={step}
      value={policy[k] ?? ""}
      placeholder="sin capturar"
      onChange={(e) => setNum(k, e.target.value)}
    />
  );
  useEffect(() => {
    void load().catch((e) => setError(e instanceof Error ? e.message : "No se pudieron leer los Ajustes"));
    setTheme(readThemePref());
    void dbStatus()
      .then((d) => setDbLabel(d.label))
      .catch(() => undefined);
  }, []);

  // El rol llega del contexto, no siempre en el primer render.
  useEffect(() => {
    void loadUsage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setMsg(null);
    const faltan: string[] = POLICY_FIELDS.filter(([k]) => policy[k] == null).map(([, label]) => label);
    if (!parseTerms(quoteTerms)?.length) faltan.push(QUOTE_TERMS_LABEL);
    if (faltan.length) {
      setError(`Falta capturar: ${faltan.join(", ")}. Sin esos números el sistema no opera.`);
      return;
    }
    const { mailReady: _ready, ...rest } = form;
    try {
      await saveSettings({ data: { ...rest, ...(policy as Record<PolicyField, number>), quoteTerms } });
      setMsg("Política guardada");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar");
    }
  }
  const pct = (v: number | null, d = 2) => (v == null ? "—" : (v * 100).toFixed(d) + "%");

  return (
    <>
      <PageHead
        title="Configuración"
        hint="Reglas de crédito, TIIE, tipo de cambio y circuito ASR. Los días se cuentan calendario exacto; el interés usa año comercial 360."
      />
      {msg && <p className="mb-3 text-sm text-ok">{msg}</p>}
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      {missing.length > 0 && (
        <p className="mb-3 rounded-md border border-danger bg-cream px-3 py-2 text-sm text-danger">
          Ajustes incompletos: falta {missing.join(", ")}. Cotizar, facturar, cobrar y el estado de cuenta se detienen hasta que se capturen abajo.
        </p>
      )}
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
        <Field label="Plazo factura (días) — vencimiento visible al cliente">{numInput("invoiceDays")}</Field>
        <Field label="Plazo financiero / mora (días) — aquí arranca el interés">{numInput("creditDays")}</Field>
        <Field label="Umbral pronto pago (días)">{numInput("earlyPayDays")}</Field>
        <Field label="Comisión + FEGA (única vez, fracción)">{numInput("fegaRate", "0.0001")}</Field>
        <Field label="Comisión dentro de «comisión + FEGA» (fracción)">{numInput("fegaCommission", "0.0001")}</Field>
        <Field label="Spread mora (factura de intereses, fracción)">{numInput("collectionSpread", "0.0001")}</Field>
        <Field label="Comisión ASR (en precio, una sola vez, fracción)">{numInput("asrCommission", "0.0001")}</Field>
        <Field label="Spread ASR (en precio, TIIE +, fracción)">{numInput("asrSpread", "0.0001")}</Field>
        <Field label="Escalera de plazos de la cotización (días separados por coma; 0 = contado)">
          <input
            className={quoteTerms.trim() && !parseTerms(quoteTerms)?.length ? "erp-input border-danger" : "erp-input"}
            value={quoteTerms}
            placeholder="sin capturar"
            onChange={(e) => setQuoteTerms(e.target.value)}
          />
          <p className="mt-1 text-[11px] font-normal normal-case tracking-normal text-muted">
            Columnas de la escalera interna por partida (precio, financiamiento y utilidad por plazo). Al cliente solo le llegan dos precios: contado y el del plazo acordado.
          </p>
        </Field>
        <p className="md:col-span-3 text-sm text-muted">
          Precio de venta por unidad = (costo puesto + financiamiento) ÷ (1 − margen %): el margen es sobre el precio de venta, no sobre el costo; con margen en pesos, precio = costo puesto + financiamiento + monto. La TIIE no se captura aquí: siempre sale de la tabla de abajo (renglón vigente en la fecha que toque, con su fecha a la vista). Financiamiento dentro del precio de venta (por unidad) = costo × {pct(policy.asrCommission)} + costo × {policy.asrCommission == null ? "—" : (1 + policy.asrCommission).toFixed(2)} × (TIIE + {pct(policy.asrSpread)}) × días de crédito / {YEAR_DAYS}. La comisión se cobra una sola vez, no depende de los días, y además genera interés porque la línea adelanta costo + comisión. De contado (0 días) el financiamiento es $0, comisión incluida.
          Mora (solo factura FI si ya venció) = Cargo × (TIIE + {pct(policy.collectionSpread, 1)}) × días exactos / {YEAR_DAYS}. En el estado de cuenta, comisión {pct(policy.fegaCommission)} + FEGA {policy.fegaRate == null || policy.fegaCommission == null ? "—" : ((policy.fegaRate - policy.fegaCommission) * 100).toFixed(2) + "%"} = {pct(policy.fegaRate)} sobre el cargo (columna «Comisión + FEGA»); no se mete al precio del producto.
        </p>
        {editable && <button className="erp-btn-primary">Guardar política</button>}
      </form>

      <Panel className="mt-5">
        <h2 className="text-sm font-semibold">Políticas de cobro (comisión y FEGA por cliente)</h2>
        <p className="mt-0.5 text-sm text-muted">
          Cada pedido nace con una política de cobro y su factura la hereda. El porcentaje es siempre el de arriba (comisión {pct(policy.fegaCommission)} + FEGA{" "}
          {policy.fegaRate == null || policy.fegaCommission == null ? "—" : ((policy.fegaRate - policy.fegaCommission) * 100).toFixed(2) + "%"}); aquí solo se dice
          cuál de las dos mitades se le cobra a ese cliente, porque se negocia distinto con cada uno. El interés de mora no depende de esto.
        </p>
        {policies.some((p) => p.commission == null || p.fega == null) && (
          <p className="mt-3 rounded-md border border-danger bg-cream px-3 py-2 text-[13px] text-danger">
            Hay políticas sin capturar. Mientras una política no conteste las dos preguntas, sus facturas vencidas salen marcadas «sin política» en el estado de
            cuenta y la factura de intereses (FI) se detiene. No se supone un valor por omisión.
          </p>
        )}
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[620px] text-left text-[13px]">
            <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
              <tr>
                <th className="py-2 font-medium">Política</th>
                <th className="py-2 font-medium">¿Cobra comisión?</th>
                <th className="py-2 font-medium">¿Cobra FEGA?</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {policies.map((cp) => {
                const e = polEdit[cp.code] ?? { commission: "", fega: "" };
                const sinCapturar = cp.commission == null || cp.fega == null;
                const sel = (field: "commission" | "fega") => (
                  <select
                    className={e[field] ? "erp-input" : "erp-input border-warn"}
                    value={e[field]}
                    disabled={role !== "admin"}
                    onChange={(ev) => setPolEdit({ ...polEdit, [cp.code]: { ...e, [field]: ev.target.value } })}
                  >
                    <option value="">sin capturar</option>
                    <option value="si">Sí</option>
                    <option value="no">No</option>
                  </select>
                );
                return (
                  <tr key={cp.code} className="border-t border-line align-top">
                    <td className="py-2 pr-3">
                      <span className="font-medium">{cp.name}</span>
                      <span className="ml-2 font-mono text-[11px] text-muted">{cp.code}</span>
                      {sinCapturar ? <span className="block text-[11px] text-warn">sin capturar</span> : null}
                    </td>
                    <td className="py-2 pr-3">{sel("commission")}</td>
                    <td className="py-2 pr-3">{sel("fega")}</td>
                    <td className="py-2 text-right">
                      {role === "admin" ? (
                        <button type="button" className="erp-btn h-8 text-[12px]" onClick={() => void onSavePolicy(cp.code)}>
                          Guardar
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
              {policies.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-6 text-center text-sm text-muted">
                    Sin políticas de cobro en la base.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {role !== "admin" ? <p className="mt-2 text-xs text-muted">Solo un administrador puede cambiar una política de cobro.</p> : null}
        <p className="mt-2 text-[12px] text-muted">Cada cambio queda en Bitácora con el valor anterior y el nuevo.</p>

        {role === "admin" && (
          <div className="mt-6 border-t border-line pt-4">
            <h3 className="text-sm font-semibold">Quién está en cada política</h3>
            <p className="mt-0.5 text-[12px] text-muted">
              Solo lectura. La política vive en el documento, no en el cliente: aquí se cuentan las facturas de mercancía con
              saldo abierto, la misma población del estado de cuenta. Un cliente con documentos de dos políticas aparece en las
              dos. Toca un renglón para ver quiénes son.
            </p>
            {usage == null ? (
              <p className="mt-3 text-[12px] text-muted">Leyendo…</p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-[13px]">
                  <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
                    <tr>
                      <th className="py-2 font-medium">Política</th>
                      <th className="py-2 text-right font-medium">Clientes</th>
                      <th className="py-2 text-right font-medium">Facturas abiertas</th>
                      <th className="py-2 text-right font-medium">Saldo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.map((u) => {
                      const key = u.code || "(sin política)";
                      const abierto = openPolicy === key;
                      const peligro = !u.captured && u.invoices > 0;
                      return (
                        <Fragment key={key}>
                          <tr className={`border-t border-line align-top ${peligro ? "text-danger" : ""}`}>
                            <td className="py-2 pr-3">
                              <button
                                type="button"
                                className="text-left underline decoration-dotted"
                                onClick={() => setOpenPolicy(abierto ? null : key)}
                              >
                                {abierto ? "▾" : "▸"} {u.name}
                              </button>
                              {u.code ? <span className="ml-2 font-mono text-[11px] text-muted">{u.code}</span> : null}
                              <span className="block text-[11px] text-muted">
                                {u.captured
                                  ? `comisión ${u.commission ? "sí" : "no"} · FEGA ${u.fega ? "sí" : "no"}${u.chargesInterest ? "" : " · no genera mora"}`
                                  : "No se cobra comisión ni FEGA y la factura de intereses se detiene."}
                              </span>
                            </td>
                            <td className="py-2 text-right tabular-nums">{u.clients || "—"}</td>
                            <td className="py-2 text-right tabular-nums">{u.invoices || "—"}</td>
                            <td className="py-2 text-right tabular-nums">
                              {u.byCurrency.length === 0
                                ? "—"
                                : u.byCurrency.map((m) => (
                                    <span key={m.currency} className="block">
                                      {moneyIn(m.saldo, m.currency)} <span className="text-[11px] text-muted">{m.currency}</span>
                                    </span>
                                  ))}
                            </td>
                          </tr>
                          {abierto && (
                            <tr className="bg-paper">
                              <td colSpan={4} className="px-3 py-3">
                                {u.clientsList.length === 0 ? (
                                  <p className="text-[12px] text-muted">
                                    {u.code
                                      ? "Ningún cliente con saldo abierto en esta política."
                                      : "Ningún documento sin política capturada: nada se detiene al cobrar."}
                                  </p>
                                ) : (
                                  <table className="w-full text-left text-[12px]">
                                    <thead className="text-[10px] uppercase tracking-wide text-muted">
                                      <tr>
                                        <th className="py-1 font-medium">Cliente</th>
                                        <th className="py-1 text-right font-medium">Facturas</th>
                                        <th className="py-1 text-right font-medium">Saldo</th>
                                        {!u.code && <th className="py-1 font-medium">Trae la política</th>}
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {u.clientsList.map((c) => (
                                        <tr key={c.id} className="border-t border-line align-top">
                                          <td className="py-1.5 pr-3">
                                            <span className="font-mono text-[11px] text-muted">{c.code}</span> {c.name}
                                            {c.group ? <span className="block text-[11px] text-muted">{c.group}</span> : null}
                                          </td>
                                          <td className="py-1.5 text-right tabular-nums">{c.invoices}</td>
                                          <td className="py-1.5 text-right tabular-nums">
                                            {c.byCurrency.map((m) => (
                                              <span key={m.currency} className="block">
                                                {moneyIn(m.saldo, m.currency)}{" "}
                                                <span className="text-[10px] text-muted">{m.currency}</span>
                                              </span>
                                            ))}
                                          </td>
                                          {!u.code && (
                                            <td className="py-1.5 font-mono text-[11px] text-muted">{c.policyCodes.join(", ")}</td>
                                          )}
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                )}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
                <p className="mt-2 text-[12px] text-muted">
                  Los renglones no se traslapan: una factura cuya política todavía no contesta las dos preguntas no cuenta para
                  esa política, cuenta en «Sin política capturada». El saldo va por moneda, nunca sumado.
                </p>
              </div>
            )}
          </div>
        )}
      </Panel>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <Panel>
          <h2 className="text-sm font-semibold">Tabla TIIE</h2>
          {role === "admin" ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <input className="erp-input" type="date" value={tDate} onChange={(e) => setTDate(e.target.value)} />
              <input
                className="erp-input w-28"
                type="number"
                step="0.0001"
                placeholder="fracción"
                value={tRate ?? ""}
                onChange={(e) => setTRate(e.target.value.trim() === "" ? null : Number(e.target.value))}
              />
              <button
                type="button"
                className="erp-btn"
                disabled={tRate == null}
                onClick={() => (tRate == null ? undefined : saveTiie({ data: { date: tDate, rate: tRate } }).then(load).catch((e) => setError(e instanceof Error ? e.message : "Error")))}
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
              <input
                className="erp-input w-28"
                type="number"
                step="0.0001"
                placeholder="MXN por USD"
                value={fRate ?? ""}
                onChange={(e) => setFRate(e.target.value.trim() === "" ? null : Number(e.target.value))}
              />
              <button
                type="button"
                className="erp-btn"
                disabled={fRate == null}
                onClick={() => (fRate == null ? undefined : saveFx({ data: { date: fDate, usdMxn: fRate } }).then(load).catch((e) => setError(e instanceof Error ? e.message : "Error")))}
              >
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
