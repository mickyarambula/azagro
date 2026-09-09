import { useState } from "react";
import { humanError } from "@/lib/utils";

/**
 * BLOQUE DE DESHACER, paso 1: cancelar lo liviano. Un solo componente para
 * las tres pantallas (solicitud, cotización, pedido en borrador) — mismo
 * patrón que SendButton (send-doc.tsx) para "la misma interacción en varios
 * documentos". Enseña qué se va a cancelar, exige el motivo (no es
 * opcional) y pregunta una vez.
 */
export function CancelButton(props: {
  title: string;
  number: string;
  summary: string[];
  onConfirm: (reason: string) => Promise<unknown>;
  onDone?: () => void | Promise<void>;
  label?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (!reason.trim()) {
      setError("El motivo es obligatorio.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await props.onConfirm(reason.trim());
      setOpen(false);
      setReason("");
      await props.onDone?.();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="erp-btn h-8 text-[12px] text-danger"
        disabled={props.disabled}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        {props.label ?? "Cancelar"}
      </button>
      {open ? (
        <div
          className="fixed inset-0 z-[90] grid place-items-center bg-ink/40 p-4"
          onClick={() => !busy && setOpen(false)}
        >
          <div className="w-full max-w-md rounded-xl border border-line bg-cream p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-base font-semibold">
              Cancelar {props.title} {props.number}
            </h2>
            <p className="mt-1 text-[12px] text-muted">Se marca cancelada y se conserva — no se borra, y no se puede deshacer desde aquí.</p>
            <ul className="mt-3 list-disc space-y-0.5 pl-5 text-[12px] text-ink-soft">
              {props.summary.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
            <label className="mt-3 grid gap-1 text-[12px] font-medium">
              Motivo (obligatorio)
              <textarea
                className="erp-input mt-1 w-full"
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Por qué se cancela…"
              />
            </label>
            {error ? <p className="mt-2 text-[12px] text-danger">{error}</p> : null}
            <div className="mt-4 flex gap-2">
              <button type="button" className="erp-btn-primary" disabled={busy || !reason.trim()} onClick={() => void confirm()}>
                Confirmar cancelación
              </button>
              <button type="button" className="erp-btn ml-auto" disabled={busy} onClick={() => setOpen(false)}>
                Cerrar
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Paso 4: cancelar en cascada. Mismo diálogo, pero la cadena la calcula el
// servidor (cancelChainPreview) y se enseña completa antes de preguntar una
// vez (Decisión 25): qué se cancela, qué se revierte, qué no se toca, y —si
// algo ya movió inventario o cartera— por qué no se puede, sin botón.
// ---------------------------------------------------------------------------
type ChainDoc = {
  kind: "sale" | "purchase" | "supplier_invoice" | "quote";
  id: number;
  name: string;
  partner: string;
  total: number;
  currency: string;
  state: string;
  residual?: number;
  dueDate?: string;
  note: string;
};
export type ChainPreview = {
  root: { kind: "sale" | "purchase"; id: number; name: string };
  cancels: ChainDoc[];
  reverts: ChainDoc[];
  keeps: ChainDoc[];
  blockers: string[];
  revertsCartera: boolean;
  needsRole: "admin_gerencia" | "module";
  allowed: boolean;
  role: string;
};

export function CancelChainButton(props: {
  title: string;
  number: string;
  load: () => Promise<ChainPreview>;
  onConfirm: (reason: string) => Promise<unknown>;
  onDone?: () => void | Promise<void>;
  label?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [chain, setChain] = useState<ChainPreview | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openDialog() {
    setError(null);
    setChain(null);
    setOpen(true);
    try {
      setChain(await props.load());
    } catch (e) {
      setError(humanError(e));
    }
  }

  async function confirm() {
    if (!reason.trim()) {
      setError("El motivo es obligatorio.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await props.onConfirm(reason.trim());
      setOpen(false);
      setReason("");
      await props.onDone?.();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  }

  const blocked = Boolean(chain?.blockers.length);
  const canConfirm = Boolean(chain) && !blocked && Boolean(chain?.allowed) && Boolean(reason.trim()) && !busy;
  const money = (n: number, cur: string) => `$${n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`;

  return (
    <>
      <button type="button" className="erp-btn h-8 text-[12px] text-danger" disabled={props.disabled} onClick={() => void openDialog()}>
        {props.label ?? "Cancelar"}
      </button>
      {open ? (
        <div className="fixed inset-0 z-[90] grid place-items-center bg-ink/40 p-4" onClick={() => !busy && setOpen(false)}>
          <div className="w-full max-w-lg rounded-xl border border-line bg-cream p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-base font-semibold">
              Cancelar {props.title} {props.number}
            </h2>
            {!chain && !error ? <p className="mt-2 text-[12px] text-muted">Revisando qué cuelga de este documento…</p> : null}

            {chain && blocked ? (
              <div className="mt-3 rounded-md border border-danger bg-cream px-3 py-2 text-[12px] text-danger">
                <p className="font-semibold">No se puede cancelar.</p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {chain.blockers.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
                <p className="mt-2 text-muted">Este intento quedó en la bitácora.</p>
              </div>
            ) : null}

            {chain && !blocked ? (
              <>
                <p className="mt-1 text-[12px] text-muted">Se marca cancelado y se conserva — no se borra, y no se puede deshacer desde aquí. Todo o nada.</p>
                <p className="mt-3 text-[12px] font-semibold">Se cancela:</p>
                <ul className="list-disc space-y-0.5 pl-5 text-[12px] text-ink-soft">
                  {chain.cancels.map((d) => (
                    <li key={`${d.kind}-${d.id}`}>
                      {d.name} · {d.partner} · {money(d.total, d.currency)} ({d.note})
                    </li>
                  ))}
                </ul>
                {chain.reverts.length ? (
                  <>
                    <p className="mt-3 text-[12px] font-semibold">Se revierte (deuda que ya existe en cartera):</p>
                    <ul className="list-disc space-y-0.5 pl-5 text-[12px] text-ink-soft">
                      {chain.reverts.map((d) => (
                        <li key={`${d.kind}-${d.id}`}>
                          {d.name} · {d.partner} · {money(d.total, d.currency)} · saldo {money(d.residual ?? 0, d.currency)}
                          {d.dueDate ? ` · vencía ${d.dueDate}` : ""} — {d.note}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {chain.keeps.length ? (
                  <>
                    <p className="mt-3 text-[12px] font-semibold">No se toca:</p>
                    <ul className="list-disc space-y-0.5 pl-5 text-[12px] text-ink-soft">
                      {chain.keeps.map((d) => (
                        <li key={`${d.kind}-${d.id}`}>
                          {d.name} {d.note}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {chain.revertsCartera ? (
                  <p className={`mt-3 text-[12px] ${chain.allowed ? "text-muted" : "text-danger"}`}>
                    {chain.allowed
                      ? "Como revierte una deuda ya registrada, esta cancelación es de administrador o gerencia — tú puedes hacerla."
                      : "Como revierte una deuda ya registrada, esta cancelación es solo de administrador o gerencia. Pídesela a uno de ellos."}
                  </p>
                ) : null}
                <label className="mt-3 grid gap-1 text-[12px] font-medium">
                  Motivo (obligatorio)
                  <textarea className="erp-input mt-1 w-full" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Por qué se cancela…" />
                </label>
              </>
            ) : null}

            {error ? <p className="mt-2 text-[12px] text-danger">{error}</p> : null}
            <div className="mt-4 flex gap-2">
              {chain && !blocked ? (
                <button type="button" className="erp-btn-primary" disabled={!canConfirm} onClick={() => void confirm()}>
                  Confirmar cancelación
                </button>
              ) : null}
              <button type="button" className="erp-btn ml-auto" disabled={busy} onClick={() => setOpen(false)}>
                Cerrar
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Paso 5: reversa de cobro/pago. La cadena la calcula el servidor
// (reversalPreview): qué se revierte (con importes), qué vuelve a deber, qué
// se queda, y los números de banco y cartera antes/después. Una vez. Y al
// final, lo que NO se puede deshacer después — la Decisión 16 dicha en el
// momento en que importa, no en un documento.
// ---------------------------------------------------------------------------
type ReversalLine = { name: string; detail: string; amount: number; currency: string };
export type ReversalPreviewView = {
  payment: { id: number; name: string; kind: "inbound" | "outbound"; amount: number; date: string; partner: string; bank: string | null; memo: string };
  invoice: { id: number; name: string; currency: string; residualNow: number; residualAfter: number; dueDate: string; moraDue: string | null };
  reverts: ReversalLine[];
  keeps: ReversalLine[];
  bank: { name: string; before: number; after: number; reconciled: boolean } | null;
  partnerDebt: { name: string; before: number; after: number };
  blockers: string[];
  allowed: boolean;
  role: string;
};

export function ReversalButton(props: {
  paymentName: string;
  load: () => Promise<ReversalPreviewView>;
  onConfirm: (reason: string) => Promise<unknown>;
  onDone?: () => void | Promise<void>;
  label?: string;
  disabled?: boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [chain, setChain] = useState<ReversalPreviewView | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openDialog() {
    setError(null);
    setChain(null);
    setOpen(true);
    try {
      setChain(await props.load());
    } catch (e) {
      setError(humanError(e));
    }
  }
  async function confirm() {
    if (!reason.trim()) {
      setError("El motivo es obligatorio.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await props.onConfirm(reason.trim());
      setOpen(false);
      setReason("");
      await props.onDone?.();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  }

  const blocked = Boolean(chain?.blockers.length);
  const canConfirm = Boolean(chain) && !blocked && Boolean(chain?.allowed) && Boolean(reason.trim()) && !busy;
  const money = (n: number, cur: string) =>
    `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`;
  const verbo = chain?.payment.kind === "outbound" ? "el pago" : "el cobro";

  return (
    <>
      <button
        type="button"
        className={props.compact ? "text-[12px] font-medium text-danger hover:underline" : "erp-btn h-8 text-[12px] text-danger"}
        disabled={props.disabled}
        onClick={() => void openDialog()}
      >
        {props.label ?? "Revertir"}
      </button>
      {open ? (
        <div className="fixed inset-0 z-[90] grid place-items-center bg-ink/40 p-4" onClick={() => !busy && setOpen(false)}>
          <div className="w-full max-w-lg rounded-xl border border-line bg-cream p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-base font-semibold">
              Revertir {chain ? verbo : ""} {props.paymentName}
              {chain ? ` · ${chain.payment.partner} · ${money(chain.payment.amount, chain.invoice.currency)} · ${chain.payment.date}${chain.payment.bank ? ` · ${chain.payment.bank}` : ""}` : ""}
            </h2>
            {!chain && !error ? <p className="mt-2 text-[12px] text-muted">Revisando qué se movió con este {verbo}…</p> : null}

            {chain && blocked ? (
              <div className="mt-3 rounded-md border border-danger bg-cream px-3 py-2 text-[12px] text-danger">
                <p className="font-semibold">No se puede revertir.</p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {chain.blockers.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
                <p className="mt-2 text-muted">Este intento quedó en la bitácora.</p>
              </div>
            ) : null}

            {chain && !blocked ? (
              <>
                <p className="mt-3 text-[12px] font-semibold">Se revierte (quedan el original, la reversa y la liga entre los dos):</p>
                <ul className="list-disc space-y-0.5 pl-5 text-[12px] text-ink-soft">
                  {chain.reverts.map((d, i) => (
                    <li key={i}>
                      {d.name} · {d.detail} · {money(d.amount, d.currency)}
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-[12px] font-semibold">Vuelve a deber:</p>
                <ul className="list-disc space-y-0.5 pl-5 text-[12px] text-ink-soft">
                  <li>
                    {chain.invoice.name}: saldo {money(chain.invoice.residualNow, chain.invoice.currency)} → {money(chain.invoice.residualAfter, chain.invoice.currency)} · vencía {chain.invoice.dueDate}
                    {chain.payment.kind === "inbound"
                      ? ` · la mora vuelve a correr desde el plazo financiero${chain.invoice.moraDue ? ` (${chain.invoice.moraDue})` : ""}; lo ya facturado se queda`
                      : ""}
                  </li>
                </ul>
                {chain.keeps.length ? (
                  <>
                    <p className="mt-3 text-[12px] font-semibold">Se queda:</p>
                    <ul className="list-disc space-y-0.5 pl-5 text-[12px] text-ink-soft">
                      {chain.keeps.map((d, i) => (
                        <li key={i}>
                          {d.name} · {money(d.amount, d.currency)} · {d.detail}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
                <p className="mt-3 text-[12px] text-ink-soft">
                  <span className="font-semibold">Después:</span>
                  {chain.bank ? ` ${chain.bank.name} ${money(chain.bank.before, "MXN")} → ${money(chain.bank.after, "MXN")} ·` : ""}
                  {` ${chain.partnerDebt.name} debe ${money(chain.partnerDebt.before, chain.invoice.currency)} → ${money(chain.partnerDebt.after, chain.invoice.currency)}`}
                </p>
                <p className={`mt-3 text-[12px] ${chain.allowed ? "text-muted" : "text-danger"}`}>
                  {chain.allowed
                    ? "Esto revierte cartera y banco: es de administrador o gerencia — tú puedes hacerlo."
                    : "Esto revierte cartera y banco: es solo de administrador o gerencia. Pídeselo a uno de ellos."}
                </p>
                <label className="mt-3 grid gap-1 text-[12px] font-medium">
                  Motivo (obligatorio)
                  <textarea className="erp-input mt-1 w-full" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Por qué se revierte…" />
                </label>
                <p className="mt-3 rounded-md border border-warn bg-cream px-3 py-2 text-[12px] text-warn">
                  Lo que no se puede deshacer después: la reversa también queda para siempre. No estás borrando este {verbo}, estás agregando un movimiento
                  contrario. Si la reversa resulta ser el error, no se deshace: se captura el {verbo} correcto, y quedan los tres.
                </p>
              </>
            ) : null}

            {error ? <p className="mt-2 text-[12px] text-danger">{error}</p> : null}
            <div className="mt-4 flex gap-2">
              {chain && !blocked ? (
                <button type="button" className="erp-btn-primary" disabled={!canConfirm} onClick={() => void confirm()}>
                  Confirmar reversa
                </button>
              ) : null}
              <button type="button" className="erp-btn ml-auto" disabled={busy} onClick={() => setOpen(false)}>
                Cerrar
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Paso 6: revertir una recepción. Enseña qué sale del inventario, al costo
// con el que entró, y — Decisión 20 — cómo queda el promedio con su número,
// incluido lo que se queda de más en el valor.
// ---------------------------------------------------------------------------
type ReceiptLineView = {
  productId: number; code: string; product: string; uom: string;
  qty: number; unitCost: number; value: number; moveRef: string; location: string;
  qtyBefore: number; qtyAfter: number; avgNow: number;
  avgBeforeReceipt: number | null; valueNow: number; valueAfter: number; avgLeftover: number | null;
};
export type ReceiptReversalView = {
  po: { id: number; name: string; partner: string; state: string; date: string; currency: string };
  lines: ReceiptLineView[];
  invoice: { id: number; name: string; amount: number; residual: number; currency: string } | null;
  blockers: string[];
  allowed: boolean;
  role: string;
};

export function ReceiptReversalButton(props: {
  poName: string;
  load: () => Promise<ReceiptReversalView>;
  onConfirm: (reason: string) => Promise<unknown>;
  onDone?: () => void | Promise<void>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [chain, setChain] = useState<ReceiptReversalView | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openDialog() {
    setError(null);
    setChain(null);
    setOpen(true);
    try {
      setChain(await props.load());
    } catch (e) {
      setError(humanError(e));
    }
  }
  async function confirm() {
    if (!reason.trim()) {
      setError("El motivo es obligatorio.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await props.onConfirm(reason.trim());
      setOpen(false);
      setReason("");
      await props.onDone?.();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  }

  const blocked = Boolean(chain?.blockers.length);
  const canConfirm = Boolean(chain) && !blocked && Boolean(chain?.allowed) && Boolean(reason.trim()) && !busy;
  const m = (n: number, cur = "MXN") => `$${n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`;
  const m4 = (n: number) => `$${n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;

  return (
    <>
      <button type="button" className="erp-btn h-8 text-[12px] text-danger" disabled={props.disabled} onClick={() => void openDialog()}>
        Revertir recepción
      </button>
      {open ? (
        <div className="fixed inset-0 z-[90] grid place-items-center bg-ink/40 p-4" onClick={() => !busy && setOpen(false)}>
          <div className="w-full max-w-lg rounded-xl border border-line bg-cream p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-base font-semibold">
              Revertir la recepción de {props.poName}
              {chain ? ` · ${chain.po.partner} · recibida el ${chain.po.date}` : ""}
            </h2>
            {!chain && !error ? <p className="mt-2 text-[12px] text-muted">Revisando qué entró con esta orden…</p> : null}

            {chain && blocked ? (
              <div className="mt-3 rounded-md border border-danger bg-cream px-3 py-2 text-[12px] text-danger">
                <p className="font-semibold">No se puede revertir.</p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {chain.blockers.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
                <p className="mt-2 text-muted">Este intento quedó en la bitácora.</p>
              </div>
            ) : null}

            {chain && !blocked ? (
              <>
                <p className="mt-3 text-[12px] font-semibold">Sale del inventario (queda la entrada, la salida y la liga entre las dos):</p>
                <ul className="list-disc space-y-1 pl-5 text-[12px] text-ink-soft">
                  {chain.lines.map((l) => (
                    <li key={l.productId}>
                      {l.code} {l.product} · {l.qty} {l.uom} · {l.location} · al costo con el que entró {m(l.unitCost, chain.po.currency)} = {m(l.value, chain.po.currency)}
                      <br />
                      Existencia: {l.qtyBefore} → {l.qtyAfter} {l.uom} · Valor: {m(l.valueNow)} → {m(l.valueAfter)}
                      <br />
                      Promedio: {m4(l.avgNow)} → {m4(l.avgNow)} (no se mueve: solo las entradas lo promedian)
                      {l.avgBeforeReceipt != null ? (
                        <>
                          <br />
                          <span className="text-warn">
                            Antes de esta recepción era {m(l.avgBeforeReceipt)}. Se quedan {m(l.avgLeftover ?? 0)} de más en el valor de las {l.qtyAfter} {l.uom} que quedan. Eso no se corrige solo.
                          </span>
                        </>
                      ) : (
                        <>
                          <br />
                          <span className="text-muted">Entró más mercancía después, así que el promedio de antes de esta recepción no se puede reconstruir con exactitud; no se estima.</span>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
                {chain.invoice ? (
                  <>
                    <p className="mt-3 text-[12px] font-semibold">Se revierte también:</p>
                    <ul className="list-disc space-y-0.5 pl-5 text-[12px] text-ink-soft">
                      <li>
                        {chain.invoice.name} · {m(chain.invoice.amount, chain.invoice.currency)} · saldo {m(chain.invoice.residual, chain.invoice.currency)} · sin abonos → se marca revertida
                      </li>
                    </ul>
                  </>
                ) : null}
                <p className="mt-3 text-[12px] text-muted">
                  La orden vuelve a &quot;confirmada, por recibir&quot;: se puede recibir otra vez, y ahí nacerá su deuda nueva.
                </p>
                <p className={`mt-3 text-[12px] ${chain.allowed ? "text-muted" : "text-danger"}`}>
                  {chain.allowed
                    ? "Esto revierte inventario: es de administrador o gerencia — tú puedes hacerlo."
                    : "Esto revierte inventario: es solo de administrador o gerencia. Pídeselo a uno de ellos."}
                </p>
                <label className="mt-3 grid gap-1 text-[12px] font-medium">
                  Motivo (obligatorio)
                  <textarea className="erp-input mt-1 w-full" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Por qué se revierte…" />
                </label>
                <p className="mt-3 rounded-md border border-warn bg-cream px-3 py-2 text-[12px] text-warn">
                  Lo que no se puede deshacer después: la salida también queda para siempre. No estás borrando la entrada, estás agregando el movimiento
                  contrario — y el promedio no regresa solo.
                </p>
              </>
            ) : null}

            {error ? <p className="mt-2 text-[12px] text-danger">{error}</p> : null}
            <div className="mt-4 flex gap-2">
              {chain && !blocked ? (
                <button type="button" className="erp-btn-primary" disabled={!canConfirm} onClick={() => void confirm()}>
                  Confirmar reversa
                </button>
              ) : null}
              <button type="button" className="erp-btn ml-auto" disabled={busy} onClick={() => setOpen(false)}>
                Cerrar
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Paso 7: revertir una entrega con su factura. Antes de preguntar, la
// distinción que la persona tiene que hacer (Decisión 38): revertir no es
// devolver. Y si la FV ya está timbrada, el aviso de que la NC hay que
// timbrarla en Compaq (Decisión 39).
// ---------------------------------------------------------------------------
type DLine = { name: string; detail: string; amount: number; currency: string };
export type DeliveryReversalView = {
  so: { id: number; name: string; partner: string; date: string; currency: string; circuit: string | null; creditDays: number; direct: boolean };
  stock: Array<{ code: string; product: string; uom: string; qty: number; unitCost: number; value: number; location: string; qtyBefore: number; qtyAfter: number; avgBefore: number; avgAfter: number }>;
  reverts: DLine[];
  fiscal: { name: string; folio: string; uuid: string } | null;
  partnerDebt: { name: string; before: number; after: number };
  blockers: string[];
  allowed: boolean;
  role: string;
};

export function DeliveryReversalButton(props: {
  soName: string;
  load: () => Promise<DeliveryReversalView>;
  onConfirm: (reason: string) => Promise<unknown>;
  onDone?: () => void | Promise<void>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [chain, setChain] = useState<DeliveryReversalView | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openDialog() {
    setError(null);
    setChain(null);
    setOpen(true);
    try {
      setChain(await props.load());
    } catch (e) {
      setError(humanError(e));
    }
  }
  async function confirm() {
    if (!reason.trim()) {
      setError("El motivo es obligatorio.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await props.onConfirm(reason.trim());
      setOpen(false);
      setReason("");
      await props.onDone?.();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  }

  const blocked = Boolean(chain?.blockers.length);
  const canConfirm = Boolean(chain) && !blocked && Boolean(chain?.allowed) && Boolean(reason.trim()) && !busy;
  const m = (n: number, cur = "MXN") => `$${n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`;
  const m4 = (n: number) => `$${n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;

  return (
    <>
      <button type="button" className="erp-btn h-8 text-[12px] text-danger" disabled={props.disabled} onClick={() => void openDialog()}>
        Revertir entrega
      </button>
      {open ? (
        <div className="fixed inset-0 z-[90] grid place-items-center bg-ink/40 p-4" onClick={() => !busy && setOpen(false)}>
          <div className="w-full max-w-lg rounded-xl border border-line bg-cream p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-base font-semibold">
              Revertir la entrega de {props.soName}
              {chain ? ` · ${chain.so.partner} · entregada el ${chain.so.date}${chain.so.creditDays > 0 ? ` · ${chain.so.creditDays} d` : " · contado"}` : ""}
            </h2>
            <p className="mt-2 rounded-md border border-warn bg-cream px-3 py-2 text-[12px] text-warn">
              <span className="font-semibold">Revertir no es devolver.</span> Usa esto solo si la entrega no debió registrarse: pedido equivocado, cliente
              equivocado, capturada dos veces. Si la mercancía sí salió y el cliente la está regresando, eso es una <span className="font-semibold">devolución</span>.
              Si la mercancía está en casa del cliente y la venta fue real, revertir es mentir: el inventario diría que está en bodega.
            </p>
            {!chain && !error ? <p className="mt-2 text-[12px] text-muted">Revisando qué se movió con esta entrega…</p> : null}

            {chain && blocked ? (
              <div className="mt-3 rounded-md border border-danger bg-cream px-3 py-2 text-[12px] text-danger">
                <p className="font-semibold">No se puede revertir.</p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {chain.blockers.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
                <p className="mt-2 text-muted">Este intento quedó en la bitácora.</p>
              </div>
            ) : null}

            {chain && !blocked ? (
              <>
                {chain.stock.length ? (
                  <>
                    <p className="mt-3 text-[12px] font-semibold">Regresa al inventario (queda la salida, la entrada y la liga):</p>
                    <ul className="list-disc space-y-1 pl-5 text-[12px] text-ink-soft">
                      {chain.stock.map((l) => (
                        <li key={l.code}>
                          {l.code} {l.product} · {l.qty} {l.uom} · {l.location} · al costo con el que salió {m(l.unitCost)} = {m(l.value)}
                          <br />
                          Existencia {l.qtyBefore} → {l.qtyAfter} {l.uom} · Promedio {m4(l.avgBefore)} → {m4(l.avgAfter)}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="mt-3 text-[12px] text-muted">Pedido directo / brokeraje: no movió inventario de Azagro.</p>
                )}
                <p className="mt-3 text-[12px] font-semibold">Se revierte:</p>
                <ul className="list-disc space-y-0.5 pl-5 text-[12px] text-ink-soft">
                  {chain.reverts.map((d, i) => (
                    <li key={i}>
                      {d.name} · {m(d.amount, d.currency)} · {d.detail}
                    </li>
                  ))}
                </ul>
                {chain.fiscal ? (
                  <p className="mt-3 rounded-md border border-danger bg-cream px-3 py-2 text-[12px] text-danger">
                    <span className="font-semibold">{chain.fiscal.name} está timbrada</span> ({chain.fiscal.uuid || chain.fiscal.folio}). Este sistema no cancela ante el SAT: la
                    nota de crédito que nace aquí hay que timbrarla en Compaq como nota de crédito de esa factura, y capturar aquí su folio fiscal. Hasta entonces, para
                    el SAT la venta sigue viva.
                  </p>
                ) : null}
                <p className="mt-3 text-[12px] text-muted">
                  El pedido vuelve a &quot;confirmado, por entregar&quot;. Si se vuelve a entregar, la factura nueva toma la tasa de la tabla a esa fecha.
                </p>
                <p className="mt-2 text-[12px] text-ink-soft">
                  <span className="font-semibold">Después:</span> {chain.partnerDebt.name} debe {m(chain.partnerDebt.before, chain.so.currency)} → {m(chain.partnerDebt.after, chain.so.currency)}
                </p>
                <p className={`mt-3 text-[12px] ${chain.allowed ? "text-muted" : "text-danger"}`}>
                  {chain.allowed
                    ? "Esto revierte inventario y cartera: es de administrador o gerencia — tú puedes hacerlo."
                    : "Esto revierte inventario y cartera: es solo de administrador o gerencia. Pídeselo a uno de ellos."}
                </p>
                <label className="mt-3 grid gap-1 text-[12px] font-medium">
                  Motivo (obligatorio)
                  <textarea className="erp-input mt-1 w-full" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Por qué se revierte…" />
                </label>
                <p className="mt-3 rounded-md border border-warn bg-cream px-3 py-2 text-[12px] text-warn">
                  Lo que no se puede deshacer después: la nota de crédito y la entrada al inventario también quedan para siempre. No estás borrando la entrega, estás
                  agregando los movimientos contrarios.
                </p>
              </>
            ) : null}

            {error ? <p className="mt-2 text-[12px] text-danger">{error}</p> : null}
            <div className="mt-4 flex gap-2">
              {chain && !blocked ? (
                <button type="button" className="erp-btn-primary" disabled={!canConfirm} onClick={() => void confirm()}>
                  Confirmar reversa
                </button>
              ) : null}
              <button type="button" className="erp-btn ml-auto" disabled={busy} onClick={() => setOpen(false)}>
                Cerrar
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
