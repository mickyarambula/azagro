import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { BackBar } from "@/components/erp";
import { applyPartnerDefaults, duesPreview, OrderFields, type OrderDraft, type OrderLookups } from "@/components/order-form";
import { inheritCircuit } from "@/lib/erp/circuits";
import { orderLookups, saveOrder } from "@/lib/erp/orders";
import { validateDueDates } from "@/lib/erp/credit";
import { useAccess } from "@/lib/access";
import { num, todayMx } from "@/lib/utils";

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
    date: todayMx(),
    ocCliente: "",
    termKind: "credit_days",
    // Plazos de Ajustes (factura / crédito) y TC propuesto de la tabla (0 =
    // tabla vacía: el servidor no deja guardar en dólares sin capturarlo).
    invoiceDays: lookups.terms.invoiceDays,
    creditDays: lookups.terms.creditDays,
    invoiceDue: todayMx(),
    creditDue: todayMx(),
    currency: "USD",
    fxRate: lookups.fx?.rate ?? 0,
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
  const access = useAccess();
  const [lookups, setLookups] = useState<OrderLookups | null>(null);
  const [form, setForm] = useState<OrderDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [overrideCredit, setOverrideCredit] = useState(false);
  // Circuito de financiamiento del pedido directo (paso 2): propone la
  // regla según el plazo; el administrador puede tocarlo. circuitTouched
  // distingue "lo eligió" (se manda al guardar) de "lo dejó como venía".
  const [circuitCode, setCircuitCode] = useState<"CONTADO" | "ASR">("CONTADO");
  const [circuitTouched, setCircuitTouched] = useState(false);
  const dues = form ? duesPreview(form) : null;
  useEffect(() => {
    if (!circuitTouched) setCircuitCode((c) => inheritCircuit(c, dues?.creditDays ?? 0) as "CONTADO" | "ASR");
  }, [dues?.creditDays, circuitTouched]);

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
      const res = await saveOrder({ data: { ...form, confirm, overrideCredit, circuitCode: circuitTouched ? circuitCode : undefined } });
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
      {access.role === "admin" && error?.includes("límite de crédito") && (
        <label className="mb-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={overrideCredit}
            onChange={(e) => setOverrideCredit(e.target.checked)}
          />
          Autorizo exceder el límite de crédito (queda en bitácora)
        </label>
      )}
      <OrderFields
        form={form}
        setForm={setForm}
        lookups={lookups}
        circuit={{
          value: circuitCode,
          editable: access.role === "admin",
          onChange: (code) => {
            setCircuitCode(code);
            setCircuitTouched(true);
          },
        }}
      />
    </form>
  );
}
