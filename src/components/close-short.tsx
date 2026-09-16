import { useState } from "react";
import { humanError } from "@/lib/utils";

/**
 * BLOQUE DE PARCIALES, paso 7 (Decisiones 49 y 50): cerrar corto un pedido
 * o una orden de compra — lo pendiente que ya nunca va a salir / llegar se
 * cierra con motivo obligatorio; lo ya entregado / recibido y facturado
 * queda intacto. Cerrar no es borrar: todo se conserva y el documento pasa
 * a "entregado" / "recibida" con la marca de corto. Es de administrador o
 * gerencia, como revertir: es una decisión que no se deshace con un botón.
 */
export function CloseShortButton(props: {
  title: string;
  number: string;
  pending: Array<{ product: string; uom: string; pending: number }>;
  onConfirm: (reason: string) => Promise<unknown>;
  onDone?: () => void | Promise<void>;
  label?: string;
  disabled?: boolean;
  /** "entregado" (pedido) o "recibido" (OC): cambia el texto, no la regla. */
  kind: "sale" | "purchase";
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hecho = props.kind === "sale" ? "entregado" : "recibido";
  const falta = props.kind === "sale" ? "salir" : "llegar";

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
      <button type="button" className="erp-btn h-8 text-[12px]" disabled={props.disabled} onClick={() => { setError(null); setOpen(true); }}>
        {props.label ?? `Cerrar con lo ${hecho}`}
      </button>
      {open ? (
        <div className="fixed inset-0 z-[90] grid place-items-center bg-ink/40 p-4" onClick={() => !busy && setOpen(false)}>
          <div className="w-full max-w-md rounded-xl border border-line bg-cream p-5 text-left shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-base font-semibold">
              Cerrar corto {props.title} {props.number}
            </h2>
            <p className="mt-1 text-[12px] text-muted">
              Lo pendiente que ya no va a {falta} se cierra con motivo; lo ya {hecho} y facturado queda intacto. Cerrar no es borrar: todo se conserva,
              y no se deshace desde aquí.
            </p>
            <p className="mt-2 text-[12px] font-semibold">Se cierra sin {falta}:</p>
            <ul className="list-disc space-y-0.5 pl-5 text-[12px] text-ink-soft">
              {props.pending.map((l, i) => (
                <li key={i}>
                  {l.product} · {l.pending} {l.uom}
                </li>
              ))}
            </ul>
            <label className="mt-3 grid gap-1 text-[12px] font-medium">
              Motivo (obligatorio)
              <textarea className="erp-input mt-1 w-full" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={`Por qué ya no va a ${falta}…`} />
            </label>
            <p className="mt-3 text-[12px] text-muted">Esto es de administrador o gerencia.</p>
            {error ? <p className="mt-2 text-[12px] text-danger">{error}</p> : null}
            <div className="mt-4 flex gap-2">
              <button type="button" className="erp-btn-primary" disabled={busy || !reason.trim()} onClick={() => void confirm()}>
                Confirmar cierre corto
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
