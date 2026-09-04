import { createFileRoute, Link } from "@tanstack/react-router";
import { RFQ_MESSAGE } from "@/lib/erp/doc-text";
import { useEffect, useMemo, useState } from "react";
import { OpsPipeline } from "@/components/pipeline";
import { BackBar } from "@/components/erp";
import { MoneyField } from "@/components/fields";
import { SendButton } from "@/components/send-doc";
import { applyRfqWinners, getRfq, saveRfqBid } from "@/lib/erp/rfq";
import { Expediente } from "@/components/expediente";
import { money, num, qty } from "@/lib/utils";

export const Route = createFileRoute("/rfq/$rfqId")({ component: Page });

function Page() {
  const { rfqId } = Route.useParams();
  const id = Number(rfqId);
  const [data, setData] = useState<Awaited<ReturnType<typeof getRfq>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pick, setPick] = useState<Record<number, number>>({});

  async function load() {
    const d = await getRfq({ data: { id } });
    setData(d);
    // Ganador por renglón: se sugiere el más barato solo donde el usuario
    // no ha elegido. Una elección manual (crédito, servicio) se respeta
    // aunque se sigan capturando precios en otros renglones.
    setPick((prev) => {
      const next: Record<number, number> = {};
      for (const line of d.lines) {
        const bids = d.bids.filter((b) => b.product_id === line.product_id && Number(b.unit_price) > 0);
        bids.sort((a, b) => Number(a.unit_price) - Number(b.unit_price));
        const chosen = prev[line.product_id];
        if (chosen && bids.some((b) => b.partner_id === chosen)) next[line.product_id] = chosen;
        else if (bids[0]) next[line.product_id] = bids[0].partner_id;
      }
      return next;
    });
  }
  useEffect(() => {
    void load().catch((e) => setError(e instanceof Error ? e.message : "Error"));
  }, [id]);

  const bidMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of data?.bids ?? []) m.set(`${b.partner_id}:${b.product_id}`, num(b.unit_price));
    return m;
  }, [data]);

  if (!data) return <p className="text-sm text-muted">{error ?? "Cargando…"}</p>;

  return (
    <>
      <OpsPipeline current="compra" />
      <BackBar to="/rfq" label="Cotizar proveedores" />
      <Expediente kind="rfq" id={id} />
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{data.rfq.name}</h1>
          <p className="text-sm text-muted">
            {data.rfq.purpose === "stock"
              ? `Compra para inventario${data.rfq.location_name ? ` · se recibe en ${data.rfq.location_name}` : ""}. Captura precios, elige ganador y se arma la OC.`
              : data.rfq.notes || "Comparar precios de proveedores y elegir ganador por producto."}
          </p>
        </div>
        <Link to="/rfq" className="erp-btn grid place-items-center">Lista</Link>
      </div>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      {msg && <p className="mb-3 text-sm text-ok">{msg}</p>}

      <div className="mb-4 flex flex-wrap gap-2">
        {data.invited.map((s) => (
          <SendButton
            key={s.id}
            title="Solicitud de cotización"
            number={data.rfq.name}
            party={s.name}
            partnerId={s.id}
            email={s.email}
            phone={s.phone}
            lines={data.lines.map((l) => ({ qty: Number(l.qty), uom: l.uom, name: `${l.code} ${l.product}` }))}
            extra={RFQ_MESSAGE}
          />
        ))}
      </div>

      <div className="overflow-x-auto erp-card">
        <table className="w-full min-w-[720px] text-left text-[13px]">
          <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3 font-medium">Producto</th>
              <th className="px-3 py-3 text-right font-medium">Cant.</th>
              {data.invited.map((s) => (
                <th key={s.id} className="px-3 py-3 text-right font-medium">{s.name}</th>
              ))}
              <th className="px-3 py-3 font-medium">Ganador</th>
            </tr>
          </thead>
          <tbody>
            {data.lines.map((line) => (
              <tr key={line.product_id} className="border-t border-line">
                <td className="px-4 py-3">
                  <p className="font-medium">{line.product}</p>
                  <p className="font-mono text-[11px] text-muted">{line.code}</p>
                </td>
                <td className="px-3 py-3 text-right tabular-nums">{qty(line.qty)} {line.uom}</td>
                {data.invited.map((s) => {
                  const val = bidMap.get(`${s.id}:${line.product_id}`) ?? 0;
                  return (
                    <td key={s.id} className="px-3 py-2">
                      <MoneyField
                        value={val}
                        onCommit={(n) => {
                          void saveRfqBid({ data: { rfqId: id, partnerId: s.id, productId: line.product_id, unitPrice: n } })
                            .then(load)
                            .catch((e) => setError(e instanceof Error ? e.message : "Error"));
                        }}
                      />
                    </td>
                  );
                })}
                <td className="px-3 py-2">
                  <select
                    className="erp-input"
                    value={pick[line.product_id] ?? ""}
                    onChange={(e) => setPick((p) => ({ ...p, [line.product_id]: Number(e.target.value) }))}
                  >
                    <option value="">—</option>
                    {data.invited.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} {bidMap.get(`${s.id}:${line.product_id}`) ? money(bidMap.get(`${s.id}:${line.product_id}`)!) : ""}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex justify-end">
        {data.rfq.state === "awarded" ? (
          <p className="text-sm text-ok">
            {data.rfq.purpose === "stock"
              ? "Ya se emitieron las OC. Recíbelas en Pedidos de compra para que entren al kardex."
              : "Precios aplicados a la cotización del cliente."}
          </p>
        ) : (
          <button
            type="button"
            className="erp-btn-primary"
            onClick={async () => {
              const winners = data.lines
                .map((l) => {
                  const partnerId = pick[l.product_id];
                  const unitPrice = partnerId ? bidMap.get(`${partnerId}:${l.product_id}`) ?? 0 : 0;
                  return partnerId && unitPrice > 0 ? { productId: l.product_id, partnerId, unitPrice } : null;
                })
                .filter((x): x is { productId: number; partnerId: number; unitPrice: number } => !!x);
              if (!winners.length) {
                setError("Elige ganador con precio en al menos una partida");
                return;
              }
              try {
                const r = await applyRfqWinners({ data: { rfqId: id, winners } });
                setMsg(
                  data.rfq.purpose === "stock"
                    ? r.pos?.length
                      ? `Órdenes ${r.pos.join(", ")} listas. Recibe en bodega para que entren al kardex.`
                      : "Adjudicada"
                    : "Costos aplicados a la cotización del cliente",
                );
                await load();
              } catch (e) {
                setError(e instanceof Error ? e.message : "No se pudo aplicar");
              }
            }}
          >
            {data.rfq.purpose === "stock" ? "Emitir OC al ganador" : "Usar precios ganadores como costo"}
          </button>
        )}
      </div>
    </>
  );
}
