import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { BackBar } from "@/components/erp";
import { OpsPipeline } from "@/components/pipeline";
import { destText, RequestFields, type RequestDraft } from "@/components/request-form";
import { listDeliveryPoints } from "@/lib/erp/locations";
import { createRequest, listRequests } from "@/lib/erp/requests";
import { humanError } from "@/lib/utils";

export const Route = createFileRoute("/solicitudes/nuevo")({ component: Page });

function Page() {
  const navigate = useNavigate();
  const [data, setData] = useState<Awaited<ReturnType<typeof listRequests>> | null>(null);
  const [destinos, setDestinos] = useState<Array<{ id: number; name: string; address: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<RequestDraft>({
    partnerId: "",
    mode: "campo",
    locationId: "",
    lines: [{ productId: 0, qty: 1, uom: "KGS" }],
  });

  useEffect(() => {
    void Promise.all([listRequests(), listDeliveryPoints()])
      .then(([d, loc]) => {
        setData(d);
        setDestinos(loc.rows);
        setDraft((cur) => ({
          ...cur,
          partnerId: cur.partnerId || (d.customers[0] ? String(d.customers[0].id) : ""),
        }));
      })
      .catch((e) => setError(humanError(e)));
  }, []);

  return (
    <>
      <OpsPipeline current="solicitud" />
      <BackBar to="/solicitudes" label="Todas las solicitudes" />
      <h1 className="text-xl font-semibold">Nueva solicitud</h1>
      <p className="mt-0.5 text-sm text-muted">
        Cliente, producto y destino. Si el rancho no está, «+ Nuevo destino» o Almacén → Destinos. Si te equivocas, después se corrige o se borra.
      </p>
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}

      <form
        className="mt-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!draft.partnerId) {
            setError("Elige el cliente");
            return;
          }
          const ok = draft.lines.filter((l) => l.productId && l.qty > 0);
          if (!ok.length) {
            setError("Agrega al menos un producto");
            return;
          }
          setBusy(true);
          setError(null);
          try {
            const r = await createRequest({
              data: {
                partnerId: Number(draft.partnerId),
                deliveryMode: draft.mode,
                deliveryTo: destText(destinos, draft.locationId),
                locationId: draft.locationId ? Number(draft.locationId) : undefined,
                lines: ok,
              },
            });
            await navigate({ to: "/solicitudes/$solicitudId", params: { solicitudId: String(r.id) } });
          } catch (err) {
            setError(humanError(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <RequestFields
          draft={draft}
          setDraft={setDraft}
          customers={data?.customers ?? []}
          products={data?.products ?? []}
          destinos={destinos}
          setDestinos={setDestinos}
        />
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className="erp-btn" onClick={() => void navigate({ to: "/solicitudes" })}>
            Cancelar
          </button>
          <button className="erp-btn-primary" disabled={busy}>
            {busy ? "Guardando…" : "Registrar solicitud"}
          </button>
        </div>
      </form>
    </>
  );
}
