import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { StatusPill } from "@/components/erp";
import { OpsPipeline } from "@/components/pipeline";
import { REQUEST_MODES } from "@/components/request-form";
import { deleteRequest, listRequests } from "@/lib/erp/requests";
import { humanError, qty } from "@/lib/utils";

export const Route = createFileRoute("/solicitudes/")({ component: Page });

function Page() {
  const navigate = useNavigate();
  const [data, setData] = useState<Awaited<ReturnType<typeof listRequests>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  async function load() {
    setData(await listRequests());
  }

  useEffect(() => {
    void load().catch((e) => setError(humanError(e)));
  }, []);

  async function remove(id: number, name: string) {
    if (!window.confirm(`¿Borrar ${name}? Se puede si aún no tiene cotización.`)) return;
    setBusyId(id);
    setError(null);
    try {
      await deleteRequest({ data: { id } });
      await load();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <OpsPipeline current="solicitud" />
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Solicitudes del cliente</h1>
          <p className="text-sm text-muted">
            Lo que pidió el cliente. Si te equivocaste al armarla, ábrela y corrige o bórrala.
          </p>
        </div>
        <Link to="/solicitudes/nuevo" className="erp-btn-primary grid place-items-center">
          Nueva solicitud
        </Link>
      </div>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}

      <div className="overflow-x-auto erp-card">
        <table className="w-full min-w-[720px] text-left text-[13px]">
          <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3 font-medium">Folio</th>
              <th className="px-3 py-3 font-medium">Cliente</th>
              <th className="px-3 py-3 font-medium">Entrega</th>
              <th className="px-3 py-3 font-medium">Estado</th>
              <th className="px-3 py-3 text-right font-medium">Partidas</th>
              <th className="px-3 py-3 font-medium"> </th>
            </tr>
          </thead>
          <tbody>
            {data?.rows.map((r) => (
              <tr key={r.id} className="erp-row border-t border-line">
                <td className="px-4 py-3 font-medium">
                  <Link
                    to="/solicitudes/$solicitudId"
                    params={{ solicitudId: String(r.id) }}
                    className="hover:underline"
                  >
                    {r.name}
                  </Link>
                </td>
                <td className="px-3 py-3">{r.partner}</td>
                <td className="px-3 py-3">{REQUEST_MODES.find((m) => m.id === r.delivery_mode)?.label ?? r.delivery_mode}</td>
                <td className="px-3 py-3">
                  <StatusPill tone={r.state === "quoted" ? "ok" : r.state === "rfq" ? "warn" : "muted"}>
                    {r.state === "quoted" ? "Cotizada" : r.state === "rfq" ? "Con proveedores" : "Abierta"}
                  </StatusPill>
                </td>
                <td className="px-3 py-3 text-right tabular-nums">{qty(r.lines)}</td>
                <td className="px-3 py-3">
                  <div className="flex flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      className="text-[12px] font-medium text-accent hover:underline"
                      onClick={() => void navigate({ to: "/solicitudes/$solicitudId", params: { solicitudId: String(r.id) } })}
                    >
                      Abrir
                    </button>
                    {r.state !== "quoted" && (
                      <button
                        type="button"
                        className="text-[12px] font-medium text-danger hover:underline disabled:opacity-50"
                        disabled={busyId === r.id}
                        onClick={() => void remove(r.id, r.name)}
                      >
                        Borrar
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {data && data.rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-muted">
                  Aún no hay solicitudes.{" "}
                  <Link to="/solicitudes/nuevo" className="font-medium text-accent hover:underline">
                    Crear la primera
                  </Link>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
