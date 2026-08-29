import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { listAudit } from "@/lib/erp/audit";
import { humanError } from "@/lib/utils";

export const Route = createFileRoute("/bitacora")({ component: Page });

const ACTION: Record<string, string> = {
  recibir: "Recibió OC",
  entregar: "Entregó pedido",
  devolver: "Devolución",
  cobro: "Cobro",
  pago: "Pago",
  traslado: "Traslado",
  ajuste: "Ajuste de stock",
  archivo: "Archivo",
  corte: "Corte / importación",
};

function Page() {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof listAudit>>["rows"]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void listAudit()
      .then((d) => setRows(d.rows))
      .catch((e) => setError(humanError(e)));
  }, []);

  return (
    <AppShell>
      <h1 className="text-xl font-semibold">Bitácora</h1>
      <p className="mt-0.5 text-sm text-muted">Quién recibió, entregó, cobró o devolvió. No se borra.</p>
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      <div className="mt-4 overflow-x-auto erp-card">
        <table className="w-full min-w-[640px] text-left text-[13px]">
          <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3 font-medium">Cuándo</th>
              <th className="px-3 py-3 font-medium">Quién</th>
              <th className="px-3 py-3 font-medium">Qué</th>
              <th className="px-3 py-3 font-medium">Folio</th>
              <th className="px-3 py-3 font-medium">Nota</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-line">
                <td className="px-4 py-2 tabular-nums text-muted">{r.created_at.replace("T", " ").slice(0, 19)}</td>
                <td className="px-3 py-2">{r.who}</td>
                <td className="px-3 py-2">{ACTION[r.action] ?? r.action}</td>
                <td className="px-3 py-2 font-medium">{r.name || "—"}</td>
                <td className="px-3 py-2 text-muted">{r.detail || "—"}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-sm text-muted">
                  Aún no hay movimientos registrados.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </AppShell>
  );
}
