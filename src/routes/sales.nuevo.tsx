import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { BackBar } from "@/components/erp";
import { applyPartnerDefaults, duesPreview, OrderFields, type OrderDraft, type OrderLookups } from "@/components/order-form";
import { orderLookups, saveOrder } from "@/lib/erp/orders";
import { validateDueDates } from "@/lib/erp/credit";
import { num, todayISO } from "@/lib/utils";

export const Route = createFileRoute("/sales/nuevo")({
  component: Nuevo,
});

function empty(lookups: OrderLookups): OrderDraft {
  const first = lookups.customers[0];
  const loc = lookups.locations.find((l) => l.loc_type === "internal") ?? lookups.locations[0];
  const prod = lookups.products[0];
  const base: OrderDraft = {
    name: lookups.nextName,
    partnerId: first?.id ?? 0,
    date: todayISO(),
    ocCliente: "",
    termKind: "credit_days",
    invoiceDays: 30,
    creditDays: 30,
    invoiceDue: todayISO(),
    creditDue: todayISO(),
    currency: "USD",
    fxRate: lookups.fxRate || 18,
    routeKind: "own",
    asrPartnerId: lookups.asr[0]?.id ?? null,
    locationId: loc?.id ?? 0,
    policyCode: lookups.policies.find((p) => p.code === "NONE")?.code ?? lookups.policies[0]?.code ?? "NONE",
    priceMode: "custom",
    deliveryTo: "",
    notes: "",
    lines: [
      {
        productId: prod?.id ?? 0,
        qty: 1,
        unitPrice: num(prod?.list_price),
        uom: prod?.uom ?? "TM",
      },
    ],
  };
  return first ? applyPartnerDefaults(base, first) : base;
}

function Nuevo() {
  const navigate = useNavigate();
  const [lookups, setLookups] = useState<OrderLookups | null>(null);
  const [form, setForm] = useState<OrderDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void orderLookups()
      .then((l) => {
        setLookups(l);
        setForm(empty(l));
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Error"));
  }, []);

  async function onSave(confirm: boolean) {
    if (!form) return;
    if (!form.partnerId) {
      setError("Selecciona un cliente");
      return;
    }
    const dues = duesPreview(form);
    if (dues) {
      const chk = validateDueDates({
        issue: form.date,
        due: dues.creditDue,
        invoiceDue: dues.invoiceDue,
        days: form.termKind === "credit_days" ? dues.creditDays : undefined,
        allowPast: true,
      });
      if (!chk.ok) {
        setError(chk.errors[0] ?? "Revisa las fechas de vencimiento");
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      const res = await saveOrder({ data: { ...form, confirm } });
      await navigate({ to: "/sales/$orderId", params: { orderId: String(res.id) } });
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar");
    } finally {
      setBusy(false);
    }
  }

  if (!lookups || !form) {
    return <p className="text-sm text-muted">{error ?? "Cargando…"}</p>;
  }

  return (
    <form
      className="p-5"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void onSave(false);
      }}
    >
      <BackBar to="/sales" label="Pedidos de venta" search={{ tab: "todos", q: "" }} />
      <div className="mb-4 flex flex-wrap items-center justify-end gap-2">
        <button className="erp-btn" disabled={busy} type="submit">
          Guardar borrador
        </button>
        <button className="erp-btn-primary" disabled={busy} type="button" onClick={() => void onSave(true)}>
          Confirmar pedido
        </button>
      </div>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      <OrderFields form={form} setForm={setForm} lookups={lookups} />
    </form>
  );
}
