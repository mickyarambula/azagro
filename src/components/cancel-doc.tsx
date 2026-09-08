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
