import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { DestinoForm } from "@/components/destino-form";
import { BackBar } from "@/components/erp";
import { PartnerFields, type PartnerDraft } from "@/components/partner-form";
import { PartnerProducts } from "@/components/partner-products";
import { useAccess } from "@/lib/access";
import { getPartner, savePartner } from "@/lib/azagro";
import { listLookups, saveLookup } from "@/lib/erp/catalogs";
import { deleteLocation, listDeliveryPoints } from "@/lib/erp/locations";
import { saveContact } from "@/lib/erp/ops";
import { money, num } from "@/lib/utils";

export const Route = createFileRoute("/partners/$partnerId")({
  component: Ficha,
});

function Ficha() {
  const { partnerId } = Route.useParams();
  const id = Number(partnerId);
  const { can } = useAccess();
  const canEdit = can("partners", "edit");
  const [lookups, setLookups] = useState<Awaited<ReturnType<typeof listLookups>> | null>(null);
  const [form, setForm] = useState<PartnerDraft | null>(null);
  const [meta, setMeta] = useState<{ ar: string; ap: string }>({ ar: "0", ap: "0" });
  const [people, setPeople] = useState<Array<{ id: number; name: string; role: string; email: string; phone: string; is_billing: boolean }>>([]);
  const [destinos, setDestinos] = useState<Array<{ id: number; name: string; address: string; partner_id: number | null; partner_name: string | null }>>([]);
  const [addDest, setAddDest] = useState(false);
  const [cform, setCform] = useState({ name: "", role: "Cobranza", email: "", phone: "", isBilling: true });
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const [d, l, loc] = await Promise.all([getPartner({ data: { id } }), listLookups().catch(() => null), listDeliveryPoints().catch(() => null)]);
    setLookups(l);
    const p = d.partner;
    setForm({
      code: p.code,
      name: p.name,
      legal_name: p.legal_name,
      rfc: p.rfc,
      group_name: p.group_name,
      city: p.city,
      address: p.address ?? "",
      email: p.email,
      phone: p.phone,
      notes: p.notes ?? "",
      credit_limit: num(p.credit_limit),
      payment_days: p.payment_days,
      late_rate: num(p.late_rate),
      is_customer: p.is_customer,
      is_supplier: p.is_supplier,
    });
    setMeta({ ar: p.ar, ap: p.ap });
    setPeople(d.contacts);
    setDestinos((loc?.rows ?? []).filter((r) => r.partner_id === id));
  }

  useEffect(() => {
    setForm(null);
    void load().catch((e) => setError(e instanceof Error ? e.message : "Error"));
  }, [id]);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setError(null);
    try {
      await savePartner({ data: { ...form, id } });
      setMsg("Guardado");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar");
    }
  }

  if (!form) {
    return <p className="text-sm text-muted">{error ?? "Cargando ficha…"}</p>;
  }

  return (
    <form onSubmit={onSave} className="mx-auto max-w-4xl">
      <BackBar to="/partners" label={form.is_supplier && !form.is_customer ? "Todos los proveedores" : "Todos los clientes"} search={{ tab: form.is_supplier && !form.is_customer ? "proveedores" : "clientes", q: "" }} />
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold">
            {form.is_supplier && !form.is_customer ? "Editar proveedor" : "Editar cliente"}
          </h1>
          <p className="mt-0.5 text-sm text-muted">
            {form.code} · {form.group_name || "sin grupo"}
            {form.is_customer ? ` · por cobrar ${money(meta.ar)}` : ""}
            {form.is_supplier ? ` · por pagar ${money(meta.ap)}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {form.is_customer && (
            <Link to="/statements" className="erp-btn grid place-items-center">
              Estado de cuenta
            </Link>
          )}
          {canEdit && (
            <button className="erp-btn-primary" type="submit">
              Guardar
            </button>
          )}
        </div>
      </div>
      {msg && <p className="mb-3 text-sm text-ok">{msg}</p>}
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}

      <PartnerFields
        form={form}
        setForm={setForm}
        groups={lookups?.groups ?? []}
        onCreateGroup={async (code, name) => {
          await saveLookup({ data: { kind: "partner_group", code, name } });
          setLookups(await listLookups());
          setForm({ ...form, group_name: name });
        }}
      />

      <h2 className="mt-8 text-[13px] font-semibold">Personas de contacto</h2>
      <p className="mt-0.5 text-sm text-muted">A quién se envían facturas y estados de cuenta.</p>
      {canEdit && (
        <div className="mt-3 grid gap-2 md:grid-cols-5">
          <input className="erp-input" placeholder="Nombre" value={cform.name} onChange={(e) => setCform({ ...cform, name: e.target.value })} />
          <input className="erp-input" placeholder="Puesto" value={cform.role} onChange={(e) => setCform({ ...cform, role: e.target.value })} />
          <input className="erp-input" placeholder="Correo" type="email" value={cform.email} onChange={(e) => setCform({ ...cform, email: e.target.value })} />
          <input className="erp-input" placeholder="Teléfono" value={cform.phone} onChange={(e) => setCform({ ...cform, phone: e.target.value })} />
          <button
            type="button"
            className="erp-btn-primary"
            onClick={async () => {
              if (!cform.name.trim()) return;
              await saveContact({ data: { partnerId: id, ...cform } });
              setCform({ name: "", role: "Cobranza", email: "", phone: "", isBilling: true });
              await load();
            }}
          >
            Agregar
          </button>
        </div>
      )}
      <ul className="mt-3">
        {people.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-line py-3 text-sm">
            <div>
              <p className="font-medium">
                {c.name} {c.is_billing && <span className="erp-chip ml-1">Facturación</span>}
              </p>
              <p className="text-muted">{c.role || "—"}</p>
            </div>
            <p className="text-muted">{[c.phone, c.email].filter(Boolean).join(" · ") || "Sin correo ni teléfono"}</p>
          </li>
        ))}
        {people.length === 0 && <li className="py-4 text-sm text-muted">Nadie registrado.</li>}
      </ul>

      <PartnerProducts
        partnerId={id}
        canEdit={canEdit}
        defaultKind={form.is_supplier && !form.is_customer ? "buy" : "sell"}
      />

      {form.is_customer && (
        <>
          <h2 className="mt-8 text-[13px] font-semibold">Destinos de entrega</h2>
          <p className="mt-0.5 text-sm text-muted">
            Ranchos y campos de este cliente. Si en una solicitud o pedido usas un destino sin dueño, se liga solo a este cliente.
          </p>
          {canEdit && !addDest && (
            <button type="button" className="erp-btn mt-3" onClick={() => setAddDest(true)}>
              Nuevo destino
            </button>
          )}
          {addDest && (
            <DestinoForm
              customers={[{ id, name: form.name, code: form.code }]}
              defaultPartnerId={id}
              onCancel={() => setAddDest(false)}
              onSaved={async () => {
                setAddDest(false);
                await load();
              }}
            />
          )}
          <ul className="mt-3">
            {destinos.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-line py-3 text-sm">
                <div>
                  <p className="font-medium">{d.name}</p>
                  <p className="text-muted">{d.address || "Sin dirección"}</p>
                </div>
                {canEdit && (
                  <button
                    type="button"
                    className="erp-btn h-8 text-[12px] text-danger"
                    onClick={async () => {
                      if (!confirm(`¿Eliminar ${d.name}?`)) return;
                      await deleteLocation({ data: { id: d.id } });
                      await load();
                    }}
                  >
                    Eliminar
                  </button>
                )}
              </li>
            ))}
            {destinos.length === 0 && (
              <li className="py-4 text-sm text-muted">
                Ningún destino ligado a este cliente.
                {canEdit && (
                  <>
                    {" "}
                    <button type="button" className="font-medium text-accent hover:underline" onClick={() => setAddDest(true)}>
                      Agregar ahora
                    </button>
                    {" · "}
                  </>
                )}
                <Link to="/bodegas" search={{ tab: "destinos" }} className="hover:underline">
                  Ver catálogo
                </Link>
              </li>
            )}
          </ul>
        </>
      )}
    </form>
  );
}
