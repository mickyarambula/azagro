import { useState } from "react";
import { Field } from "@/components/erp";
import { SearchSelect, asOpts } from "@/components/search-select";
import { listDeliveryPoints, saveLocation } from "@/lib/erp/locations";
import { humanError } from "@/lib/utils";

export type DestinoRow = { id: number; name: string; address: string; partner_id?: number | null; partner_name?: string | null };

export function DestinoForm({
  customers,
  defaultPartnerId,
  initialName = "",
  onSaved,
  onCancel,
}: {
  customers: Array<{ id: number; code?: string; name: string }>;
  defaultPartnerId?: number;
  initialName?: string;
  onSaved: (row: DestinoRow, all: DestinoRow[]) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [address, setAddress] = useState("");
  const [partnerId, setPartnerId] = useState(defaultPartnerId ?? 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="mt-2 grid gap-3 rounded-lg border border-line bg-paper p-3 md:grid-cols-4">
      <Field label="Nombre">
        <input
          className="erp-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Entrega Potato — Guasave"
          autoFocus
        />
      </Field>
      <Field label="Dirección / campo">
        <input className="erp-input" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Guasave, km 12…" />
      </Field>
      <Field label="Cliente (opcional)">
        <SearchSelect
          value={partnerId ? String(partnerId) : ""}
          options={asOpts(customers, (c) => c.id, (c) => (c.code ? `${c.code} — ${c.name}` : c.name))}
          onChange={(v) => setPartnerId(Number(v) || 0)}
          allowEmpty
          emptyLabel="Sin cliente"
          placeholder="Vincular cliente…"
        />
      </Field>
      <div className="flex items-end gap-2">
        <button type="button" className="erp-btn" onClick={onCancel}>Cancelar</button>
        <button
          type="button"
          className="erp-btn-primary"
          disabled={busy}
          onClick={async () => {
            if (name.trim().length < 2) {
              setError("Pon el nombre del destino (rancho, campo, bodega del cliente…)");
              return;
            }
            setBusy(true);
            setError(null);
            try {
              const r = await saveLocation({
                data: {
                  name: name.trim(),
                  locType: "customer",
                  address: address.trim() || name.trim(),
                  partnerId: partnerId || undefined,
                },
              });
              const loc = await listDeliveryPoints();
              const row = loc.rows.find((x) => x.id === r.id) ?? { id: r.id, name: name.trim(), address: address.trim() };
              onSaved(row, loc.rows);
            } catch (err) {
              setError(humanError(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Guardando…" : "Guardar destino"}
        </button>
      </div>
      {error && <p className="md:col-span-4 text-sm text-danger">{error}</p>}
    </div>
  );
}
