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
