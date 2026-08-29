import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { OpsPipeline } from "@/components/pipeline";
import { StatusPill } from "@/components/erp";
import { listRfqs } from "@/lib/erp/rfq";

export const Route = createFileRoute("/rfq/")({ component: Page });

function Page() {
  const [data, setData] = useState<Awaited<ReturnType<typeof listRfqs>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void listRfqs()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Error"));
  }, []);

  return (
    <>
      <OpsPipeline current="compra" />
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Cotizar a proveedores</h1>
          <p className="text-sm text-muted">
            Dos caminos: desde la solicitud del cliente, o <strong>para inventario</strong> cuando nomas quieres reponer bodega.
          </p>
        </div>
        <Link to="/rfq/nuevo" className="erp-btn-primary">
          Pedir para inventario
        </Link>
      </div>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      <div className="overflow-x-auto erp-card">
        <table className="w-full min-w-[560px] text-left text-[13px]">
          <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3 font-medium">Folio</th>
              <th className="px-3 py-3 font-medium">Para</th>
              <th className="px-3 py-3 font-medium">Estado</th>
              <th className="px-3 py-3 font-medium">Notas</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {data?.rfqs.map((r) => (
              <tr key={r.id} className="border-t border-line">
                <td className="px-4 py-3 font-medium">{r.name}</td>
                <td className="px-3 py-3">
                  <StatusPill tone={r.purpose === "stock" ? "ok" : "muted"}>
                    {r.purpose === "stock" ? "Inventario" : "Cliente"}
                  </StatusPill>
                </td>
                <td className="px-3 py-3">
                  <StatusPill tone={r.state === "awarded" ? "ok" : "warn"}>{r.state === "awarded" ? "Adjudicada" : "Abierta"}</StatusPill>
                </td>
                <td className="px-3 py-3 text-muted">{r.notes || "—"}</td>
                <td className="px-4 py-3 text-right">
                  <Link to="/rfq/$rfqId" params={{ rfqId: String(r.id) }} className="text-[12px] font-semibold text-accent">
                    Ver
                  </Link>
                </td>
              </tr>
            ))}
            {data && data.rfqs.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-sm text-muted">
                  Aún no hay cotizaciones a proveedor.{" "}
                  <Link to="/rfq/nuevo" className="font-medium text-accent hover:underline">
                    Pedir para inventario
                  </Link>
                  {" · "}o mándala desde la solicitud del cliente.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
