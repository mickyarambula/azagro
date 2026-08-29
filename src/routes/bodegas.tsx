import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { DestinoForm } from "@/components/destino-form";
import { Field, StatusPill } from "@/components/erp";
import { SearchSelect, asOpts } from "@/components/search-select";
import { listInventory, listPartners } from "@/lib/azagro";
import { deleteLocation, saveLocation } from "@/lib/erp/locations";
import { money, num } from "@/lib/utils";

export const Route = createFileRoute("/bodegas")({
  validateSearch: (raw: Record<string, unknown>) => ({
    tab: raw.tab === "destinos" ? "destinos" : "bodegas",
  }),
  component: Page,
});

const TYPE_LABEL: Record<string, string> = {
  internal: "Bodega Azagro",
  supplier: "En proveedor",
  transit: "Tránsito",
  customer: "Punto de entrega",
};

function Page() {
  const { tab } = Route.useSearch();
  const destinos = tab === "destinos";
  const [data, setData] = useState<Awaited<ReturnType<typeof listInventory>> | null>(null);
  const [partners, setPartners] = useState<Awaited<ReturnType<typeof listPartners>>>([]);
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [form, setForm] = useState({ name: "", locType: "internal" as "internal" | "supplier" | "transit" | "customer", partnerId: 0, address: "" });
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [filterPartner, setFilterPartner] = useState(0);

  async function load() {
    const [inv, pts] = await Promise.all([listInventory(), listPartners()]);
    setData(inv);
    setPartners(pts);
  }
  useEffect(() => {
    void load().catch((e) => setError(e instanceof Error ? e.message : "Error"));
  }, []);

  useEffect(() => {
    setEditing(null);
  }, [tab]);

  const locs = useMemo(() => {
    const all = data?.locations ?? [];
    const base = destinos ? all.filter((l) => l.loc_type === "customer") : all.filter((l) => l.loc_type !== "customer");
    if (destinos && filterPartner) return base.filter((l) => l.partner_id === filterPartner);
    return base;
  }, [data, destinos, filterPartner]);
  const valueOf = (id: number) =>
    (data?.quants ?? []).filter((q) => q.location_id === id).reduce((s, q) => s + num(q.quantity) * num(q.cost), 0);

  return (
    <AppShell>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{destinos ? "Destinos de entrega" : "Bodegas"}</h1>
          <p className="mt-0.5 text-sm text-muted">
            {destinos
              ? "Ranchos, campos y puntos donde se entrega al cliente. Se ligan a un cliente: en la solicitud salen primero los de ese cliente."
              : "Bodegas Azagro, en proveedor y tránsito. La existencia física no se borra: si hay stock, trásladalo primero."}
          </p>
        </div>
        <div className="flex gap-2">
          <Link to="/inventory" className="erp-btn">Existencias</Link>
          {destinos ? (
            <button
              type="button"
              className="erp-btn-primary"
              onClick={() => setEditing("new")}
            >
              Nuevo destino
            </button>
          ) : (
            <button
              type="button"
              className="erp-btn-primary"
              onClick={() => {
                setEditing("new");
                setForm({ name: "", locType: "internal", partnerId: 0, address: "" });
              }}
            >
              Nueva bodega
            </button>
          )}
        </div>
      </div>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      {msg && <p className="mb-3 text-sm text-ok">{msg}</p>}

      {destinos && (
        <div className="mb-4 max-w-sm">
          <Field label="Cliente vinculado">
            <SearchSelect
              value={filterPartner ? String(filterPartner) : ""}
              options={asOpts(partners.filter((p) => p.is_customer), (p) => p.id, (p) => `${p.code}  ${p.name}`)}
              onChange={(v) => setFilterPartner(Number(v) || 0)}
              allowEmpty
              emptyLabel="Todos los destinos"
              placeholder="Filtrar por cliente…"
            />
          </Field>
        </div>
      )}

      {destinos && editing === "new" && (
        <div className="mb-5">
          <DestinoForm
            customers={partners.filter((p) => p.is_customer)}
            onCancel={() => setEditing(null)}
            onSaved={async () => {
              setEditing(null);
              setMsg("Destino guardado");
              await load();
            }}
          />
        </div>
      )}

      {!destinos && editing !== null && (
        <form
          className="mb-5 grid gap-3 erp-card p-4 md:grid-cols-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              await saveLocation({
                data: {
                  id: editing === "new" ? undefined : editing,
                  name: form.name,
                  locType: form.locType,
                  partnerId: form.partnerId || undefined,
                  address: form.address,
                },
              });
              setEditing(null);
              setMsg("Bodega guardada");
              await load();
            } catch (err) {
              setError(err instanceof Error ? err.message : "No se pudo guardar");
            }
          }}
        >
          <Field label="Nombre">
            <input className="erp-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Bodega Central, Greenhow…" />
          </Field>
          <Field label="Tipo">
            <select className="erp-input" value={form.locType} onChange={(e) => setForm({ ...form, locType: e.target.value as typeof form.locType })}>
              <option value="internal">Bodega Azagro</option>
              <option value="supplier">Bodega de proveedor</option>
              <option value="transit">En tránsito</option>
            </select>
          </Field>
          {form.locType === "supplier" && (
            <Field label="Proveedor">
              <SearchSelect
                value={form.partnerId ? String(form.partnerId) : ""}
                options={asOpts(partners.filter((p) => p.is_supplier), (p) => p.id, (p) => p.name)}
                onChange={(v) => setForm({ ...form, partnerId: Number(v) })}
                placeholder="Vincular…"
              />
            </Field>
          )}
          <Field label="Dirección">
            <input className="erp-input" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          </Field>
          <div className="flex items-end gap-2">
            <button type="button" className="erp-btn" onClick={() => setEditing(null)}>Cancelar</button>
            <button className="erp-btn-primary">Guardar</button>
          </div>
        </form>
      )}

      {destinos && typeof editing === "number" && (
        <form
          className="mb-5 grid gap-3 erp-card p-4 md:grid-cols-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              await saveLocation({
                data: {
                  id: editing,
                  name: form.name,
                  locType: "customer",
                  partnerId: form.partnerId || undefined,
                  address: form.address,
                },
              });
              setEditing(null);
              setMsg("Destino guardado");
              await load();
            } catch (err) {
              setError(err instanceof Error ? err.message : "No se pudo guardar");
            }
          }}
        >
          <Field label="Nombre">
            <input className="erp-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Dirección / campo">
            <input className="erp-input" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          </Field>
          <Field label="Cliente">
            <SearchSelect
              value={form.partnerId ? String(form.partnerId) : ""}
              options={asOpts(partners.filter((p) => p.is_customer), (p) => p.id, (p) => p.name)}
              onChange={(v) => setForm({ ...form, partnerId: Number(v) || 0 })}
              allowEmpty
              emptyLabel="Sin cliente"
              placeholder="Vincular…"
            />
          </Field>
          <div className="flex items-end gap-2">
            <button type="button" className="erp-btn" onClick={() => setEditing(null)}>Cancelar</button>
            <button className="erp-btn-primary">Guardar</button>
          </div>
        </form>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {locs.map((l) => (
          <article key={l.id} className="erp-card p-4">
            <p className="text-[11px] uppercase tracking-wide text-muted">{TYPE_LABEL[l.loc_type] ?? l.loc_type}</p>
            <p className="mt-1 text-base font-semibold">{l.name}</p>
            {l.partner_name ? (
              <p className="text-[13px] text-muted">Cliente: {l.partner_name}</p>
            ) : destinos ? (
              <p className="text-[13px] text-warn">Sin cliente vinculado</p>
            ) : null}
            {l.address ? <p className="text-[12px] text-muted">{l.address}</p> : null}
            {destinos ? null : <p className="mt-3 text-lg tabular-nums">{money(valueOf(l.id))}</p>}
            {l.loc_type === "customer" ? <StatusPill tone="muted">No es stock</StatusPill> : null}
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                className="erp-btn h-8 text-[12px]"
                onClick={() => {
                  setEditing(l.id);
                  setForm({
                    name: l.name,
                    locType: l.loc_type as typeof form.locType,
                    partnerId: l.partner_id ?? 0,
                    address: l.address ?? "",
                  });
                }}
              >
                Editar
              </button>
              <button
                type="button"
                className="erp-btn h-8 text-[12px] text-danger"
                onClick={async () => {
                  if (!confirm(`¿Eliminar ${l.name}?`)) return;
                  setError(null);
                  try {
                    await deleteLocation({ data: { id: l.id } });
                    setMsg("Eliminada");
                    await load();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "No se pudo borrar");
                  }
                }}
              >
                Eliminar
              </button>
            </div>
          </article>
        ))}
        {locs.length === 0 && (
          <p className="col-span-full py-10 text-center text-sm text-muted">
            {destinos
              ? "Aún no hay destinos. Alta aquí o desde la solicitud, «+ Nuevo destino»."
              : "Sin bodegas cargadas."}
          </p>
        )}
      </div>
    </AppShell>
  );
}
