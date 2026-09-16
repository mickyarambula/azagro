import { useState } from "react";

/**
 * BLOQUE DE PARCIALES, pasos 1.4 y 3.5: cantidad por partida — UN solo
 * diálogo para recibir (compras) y entregar (ventas). Precarga lo pendiente
 * de cada partida, tope = pendiente; "todo lo pendiente" salta el diálogo
 * (llama sin `lines`, el camino de siempre); confirmar llama con `lines`,
 * solo las partidas con cantidad > 0. Los errores del servidor se enseñan
 * aquí mismo, sin cerrar.
 */
export type PendingLine = { lineId: number; product: string; uom: string; pending: number };

export function PartialQtyDialog(props: {
  buttonLabel: string;
  title: string;
  hint?: string;
  allLabel: string;
  confirmLabel: string;
  busyLabel?: string;
  pending: PendingLine[];
  onConfirm: (lines?: Array<{ lineId: number; qty: number }>) => Promise<void>;
  disabled?: boolean;
  primary?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [qtys, setQtys] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openDialog() {
    setError(null);
    setQtys(Object.fromEntries(props.pending.map((l) => [l.lineId, l.pending])));
    setOpen(true);
  }

  async function confirm(lines?: Array<{ lineId: number; qty: number }>) {
    setBusy(true);
    setError(null);
    try {
      await props.onConfirm(lines);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className={props.primary ? "erp-btn-primary" : "erp-btn h-8 text-[12px]"} disabled={props.disabled} onClick={openDialog}>
        {props.buttonLabel}
      </button>
      {open ? (
        <div className="fixed inset-0 z-[90] grid place-items-center bg-ink/40 p-4" onClick={() => !busy && setOpen(false)}>
          <div className="w-full max-w-md rounded-xl border border-line bg-cream p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-base font-semibold">{props.title}</h2>
            <p className="mt-1 text-[12px] text-muted">{props.hint ?? "Cantidad por partida. Deja en 0 la que todavía no sale."}</p>
            <div className="mt-3 grid gap-2">
              {props.pending.map((l) => (
                <label key={l.lineId} className="grid grid-cols-[1fr_auto] items-center gap-2 text-[13px]">
                  <span>
                    {l.product} <span className="text-muted">· pendiente {l.pending} {l.uom}</span>
                  </span>
                  <input
                    type="number"
                    className="erp-input w-24"
                    min={0}
                    max={l.pending}
                    step="0.001"
                    value={qtys[l.lineId] ?? 0}
                    onChange={(e) => setQtys((q) => ({ ...q, [l.lineId]: Math.max(0, Math.min(l.pending, Number(e.target.value) || 0)) }))}
                  />
                </label>
              ))}
            </div>
            {error ? <p className="mt-2 text-[12px] text-danger">{error}</p> : null}
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                className="erp-btn-primary"
                disabled={busy || Object.values(qtys).every((q) => q <= 0)}
                onClick={() => void confirm(Object.entries(qtys).filter(([, q]) => q > 0).map(([lineId, q]) => ({ lineId: Number(lineId), qty: q })))}
              >
                {busy ? (props.busyLabel ?? "Guardando…") : props.confirmLabel}
              </button>
              <button type="button" className="erp-btn" disabled={busy} onClick={() => void confirm(undefined)}>
                {props.allLabel}
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
