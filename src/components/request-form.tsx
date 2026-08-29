import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { DestinoForm } from "@/components/destino-form";
import { HeadBox } from "@/components/erp";
import { QtyField, UomSelect } from "@/components/fields";
import { SearchSelect, asOpts } from "@/components/search-select";

export const REQUEST_MODES = [
  { id: "campo", label: "Puesta en campo" },
  { id: "bodega", label: "En bodega" },
  { id: "pickup", label: "El cliente recolecta" },
] as const;

export type RequestLine = { productId: number; qty: number; uom: string };

export type RequestDraft = {
  partnerId: string;
  mode: (typeof REQUEST_MODES)[number]["id"];
  locationId: string;
  lines: RequestLine[];
};

export function RequestFields({
  draft,
  setDraft,
  customers,
  products,
  destinos,
  setDestinos,
}: {
  draft: RequestDraft;
  setDraft: (next: RequestDraft) => void;
  customers: Array<{ id: number; code?: string; name: string }>;
  products: Array<{ id: number; code: string; name: string; uom: string }>;
  destinos: Array<{ id: number; name: string; address: string; partner_id?: number | null; partner_name?: string | null }>;
  setDestinos: (rows: Array<{ id: number; name: string; address: string; partner_id?: number | null; partner_name?: string | null }>) => void;
}) {
  const dest = destinos.find((x) => x.id === Number(draft.locationId));
  const [adding, setAdding] = useState(false);
  const [typed, setTyped] = useState("");
  const partnerId = Number(draft.partnerId) || 0;
  const mine = destinos.filter((d) => partnerId && d.partner_id === partnerId);
  const others = destinos.filter((d) => !partnerId || d.partner_id !== partnerId);
  const destOpts = [
    ...asOpts(mine, (d) => d.id, (d) => d.name, (d) => d.address || d.partner_name || undefined),
    ...asOpts(others, (d) => d.id, (d) => d.name, (d) => [d.partner_name, d.address].filter(Boolean).join(" · ") || undefined),
  ];
  return (
    <>
      <div className="grid gap-3 lg:grid-cols-4">
        <HeadBox label="Cliente" className="lg:col-span-2">
          <SearchSelect
            bare
            value={draft.partnerId}
            options={asOpts(customers, (c) => c.id, (c) => (c.code ? `${c.code} — ${c.name}` : c.name))}
            onChange={(partnerId) => {
              const pid = Number(partnerId) || 0;
              const keep = destinos.find((d) => d.id === Number(draft.locationId));
              const own = destinos.filter((d) => d.partner_id === pid);
              const locationId =
                keep && (keep.partner_id === pid || !keep.partner_id)
                  ? draft.locationId
                  : own[0]
                    ? String(own[0].id)
                    : "";
              setDraft({ ...draft, partnerId, locationId });
            }}
            placeholder="Buscar cliente Compaq…"
          />
        </HeadBox>
        <HeadBox label="Cómo se entrega">
          <select
            className="erp-input w-full border-0 bg-transparent px-0"
            value={draft.mode}
            onChange={(e) => setDraft({ ...draft, mode: e.target.value as RequestDraft["mode"] })}
          >
            {REQUEST_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </HeadBox>
        <HeadBox label="Destino (catálogo)">
          <SearchSelect
            bare
            value={draft.locationId}
            options={destOpts}
            onChange={(locationId) => setDraft({ ...draft, locationId })}
            placeholder="Buscar destino…"
            onCreate={(name) => {
              setTyped(name);
              setAdding(true);
            }}
          />
        </HeadBox>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-3 text-[12px]">
        {dest?.address ? <span className="text-muted">{dest.address}</span> : null}
        <button type="button" className="font-medium text-accent hover:underline" onClick={() => setAdding(true)}>
          + Nuevo destino
        </button>
        <Link to="/bodegas" search={{ tab: "destinos" }} className="text-muted hover:underline">
          Ver / editar catálogo
        </Link>
      </div>
      {adding && (
        <DestinoForm
          customers={customers}
          defaultPartnerId={Number(draft.partnerId) || undefined}
          initialName={typed}
          onCancel={() => {
            setAdding(false);
            setTyped("");
          }}
          onSaved={(row, all) => {
            setDestinos(all);
            setDraft({ ...draft, locationId: String(row.id) });
            setAdding(false);
            setTyped("");
          }}
        />
      )}

      <div className="mt-3 overflow-x-auto erp-card">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
            <tr>
              <th className="px-3 py-2.5 font-medium">Producto</th>
              <th className="px-3 py-2.5 font-medium">UoM</th>
              <th className="px-3 py-2.5 text-right font-medium">Cantidad</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {draft.lines.map((line, i) => {
              const p = products.find((x) => x.id === line.productId);
              return (
                <tr key={i} className="border-t border-line">
                  <td className="px-3 py-2">
                    <SearchSelect
                      value={line.productId ? String(line.productId) : ""}
                      options={asOpts(products, (prod) => prod.id, (prod) => `${prod.code} — ${prod.name}`)}
                      placeholder="Buscar producto Compaq…"
                      onChange={(v) => {
                        const id = Number(v);
                        const prod = products.find((x) => x.id === id);
                        setDraft({
                          ...draft,
                          lines: draft.lines.map((x, j) => (j === i ? { ...x, productId: id, uom: prod?.uom || x.uom } : x)),
                        });
                      }}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <UomSelect
                      value={line.uom || p?.uom || "KGS"}
                      extra={p?.uom}
                      onChange={(uom) => setDraft({ ...draft, lines: draft.lines.map((x, j) => (j === i ? { ...x, uom } : x)) })}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <QtyField
                      value={line.qty}
                      onChange={(qtyN) => setDraft({ ...draft, lines: draft.lines.map((x, j) => (j === i ? { ...x, qty: qtyN } : x)) })}
                    />
                  </td>
                  <td className="px-2 py-2">
                    {draft.lines.length > 1 && (
                      <button
                        type="button"
                        className="grid size-8 place-items-center text-muted hover:text-danger"
                        onClick={() => setDraft({ ...draft, lines: draft.lines.filter((_, j) => j !== i) })}
                      >
                        <Trash2 className="size-4" />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        className="erp-btn mt-3"
        onClick={() => setDraft({ ...draft, lines: [...draft.lines, { productId: 0, qty: 1, uom: "KGS" }] })}
      >
        <Plus className="mr-1 inline size-3.5" />
        Otro producto
      </button>
    </>
  );
}

export function destText(
  destinos: Array<{ id: number; name: string; address: string }>,
  locationId: string,
) {
  const dest = destinos.find((x) => x.id === Number(locationId));
  return dest?.address || dest?.name || "";
}
