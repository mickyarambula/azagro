import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { BackBar } from "@/components/erp";
import { PartnerFields, type PartnerDraft } from "@/components/partner-form";
import { savePartner, nextPartnerCode } from "@/lib/azagro";
import { listLookups, saveLookup } from "@/lib/erp/catalogs";

export const Route = createFileRoute("/partners/nuevo")({
  validateSearch: (s: Record<string, unknown>): { tipo: "cliente" | "proveedor" } => ({
    tipo: s.tipo === "proveedor" ? "proveedor" : "cliente",
  }),
  component: Nuevo,
});

function Nuevo() {
  const { tipo } = Route.useSearch();
  const navigate = useNavigate();
  const isProv = tipo === "proveedor";
  const [form, setForm] = useState<PartnerDraft>({
    code: "",
    name: "",
    legal_name: "",
    rfc: "",
    group_name: "",
    city: "",
    address: "",
    email: "",
    phone: "",
    notes: "",
    credit_limit: 0,
    payment_days: 0,
    // Informativa. La mora real usa TIIE del vencimiento (tabla) + spread de
    // Ajustes; aquí no se propone ningún número.
    late_rate: 0,
    is_customer: !isProv,
    is_supplier: isProv,
  });
  const [lookups, setLookups] = useState<Awaited<ReturnType<typeof listLookups>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const [code, l] = await Promise.all([
        nextPartnerCode({ data: { kind: tipo } }),
        listLookups().catch(() => null),
      ]);
      setLookups(l);
      setForm((f) => ({
        ...f,
        code: code.code,
        is_customer: tipo !== "proveedor",
        is_supplier: tipo === "proveedor",
        payment_days: 0,
        late_rate: 0,
      }));
    })();
  }, [tipo]);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await savePartner({ data: form });
      await navigate({
        to: "/partners/$partnerId",
        params: { partnerId: String(res.id) },
        search: { tab: isProv ? "proveedores" : "clientes", q: "" },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSave} className="mx-auto max-w-4xl">
      <BackBar to="/partners" label={isProv ? "Proveedores" : "Clientes"} search={{ tab: isProv ? "proveedores" : "clientes", q: "" }} />
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold">{isProv ? "Nuevo proveedor" : "Nuevo cliente"}</h1>
          <p className="mt-0.5 text-sm text-muted">
            El plazo de la ficha es sugerencia. Las condiciones reales van en el pedido.
          </p>
        </div>
        <button className="erp-btn-primary" disabled={busy} type="submit">
          Guardar
        </button>
      </div>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      <PartnerFields
        form={form}
        setForm={setForm}
        groups={lookups?.groups ?? []}
        onCreateGroup={async (code, name) => {
          await saveLookup({ data: { kind: "partner_group", code, name } });
          setLookups(await listLookups());
          setForm((f) => ({ ...f, group_name: name }));
        }}
      />
    </form>
  );
}
