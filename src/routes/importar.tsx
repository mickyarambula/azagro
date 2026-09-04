import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { DocFiles } from "@/components/doc-files";
import { resyncCompaq } from "@/lib/erp/catalogs";
import { applyOpenInvoices, applyStockSnap, dbStatus, exportBackup, previewOpenInvoices } from "@/lib/erp/cutover";
import { listCreditPolicies } from "@/lib/erp/ops";
import { humanError } from "@/lib/utils";

export const Route = createFileRoute("/importar")({ component: Page });

function Page() {
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [db, setDb] = useState("");
  const [csvInv, setCsvInv] = useState("");
  const [csvStock, setCsvStock] = useState("");
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewOpenInvoices>> | null>(null);
  // Con qué política de cobro entran los saldos del corte. Nace vacía a
  // propósito: hasta hoy entraban en "NONE" (Sin mora) por omisión de la
  // columna, y eso es un número de negocio decidido por el sistema.
  const [policies, setPolicies] = useState<Awaited<ReturnType<typeof listCreditPolicies>>>([]);
  const [policyCode, setPolicyCode] = useState("");

  useEffect(() => {
    void dbStatus()
      .then((d) => setDb(d.label))
      .catch(() => undefined);
    void listCreditPolicies()
      .then(setPolicies)
      .catch(() => undefined);
  }, []);

  return (
    <AppShell>
      <h1 className="text-xl font-semibold">Corte y catálogos Compaq</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Primero los maestros. Luego solo <strong>saldos abiertos</strong> y existencias del día de corte. Si lo subes dos veces, no duplica: el folio ya cortado se brinca. No pegues el año cobrado.
      </p>
      {db && <p className="mt-1 text-[12px] text-muted">Base: {db}</p>}
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      {msg && <p className="mt-3 text-sm text-ok">{msg}</p>}

      <ol className="mt-5 max-w-2xl space-y-3 text-sm">
        <li className="erp-card p-4">
          <p className="font-semibold">1. Catálogos Compaq</p>
          <p className="mt-1 text-muted">Clientes, proveedores, productos y almacenes. RFC y límite de crédito incluidos.</p>
          <button
            type="button"
            className="erp-btn-primary mt-3"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const r = await resyncCompaq();
                setMsg(`Catálogos: ${r.partners} contactos, ${r.products} productos, ${r.locations} almacenes.`);
              } catch (e) {
                setError(humanError(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Cargando…" : "Cargar / actualizar catálogos"}
          </button>
        </li>

        <li className="erp-card p-4">
          <p className="font-semibold">2. Saldos abiertos (CxC / CxP)</p>
          <p className="mt-1 text-muted">
            Pega CSV o TSV: <code className="text-[12px]">código, folio, fecha, vence, cargo, abono, saldo, moneda, lado</code>.
            Solo filas con saldo. Lado = cliente o proveedor.
          </p>
          <textarea
            className="erp-input mt-2 min-h-28 font-mono text-[12px]"
            value={csvInv}
            onChange={(e) => setCsvInv(e.target.value)}
            placeholder={"CL0001,A-292,2025-11-01,2026-04-01,150000,20000,130000,MXN,cliente"}
          />
          <label className="mt-3 grid gap-1 text-[11px] font-medium uppercase tracking-wide text-muted">
            Política de cobro de estos saldos
            <select
              className={policyCode ? "erp-input" : "erp-input border-warn"}
              value={policyCode}
              onChange={(e) => setPolicyCode(e.target.value)}
            >
              <option value="">Elige la política…</option>
              {policies.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <p className="mt-1 text-[12px] text-muted">
            Decide si estas facturas generan mora y si se les cobra comisión y FEGA. No hay valor por omisión: sin
            elegirla no se pega nada. Se cambia después factura por factura, no aquí.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className="erp-btn"
              disabled={busy || !csvInv.trim()}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  setPreview(await previewOpenInvoices({ data: { csv: csvInv } }));
                } catch (e) {
                  setError(humanError(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Previsualizar
            </button>
            <button
              type="button"
              className="erp-btn-primary"
              disabled={busy || !csvInv.trim() || !policyCode}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const r = await applyOpenInvoices({ data: { csv: csvInv, policyCode } });
                  const pol = policies.find((p) => p.code === policyCode);
                  setMsg(
                    `Cartera de corte: ${r.inserted} nuevas, ${r.skipped} ya estaban (no se duplicaron). Política ${pol?.name ?? policyCode}.`,
                  );
                  setPreview(null);
                } catch (e) {
                  setError(humanError(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Cargar saldos
            </button>
          </div>
          {preview && (
            <p className="mt-2 text-[12px] text-muted">
              {preview.open} entrarían · {preview.skipped} ya están · {preview.rows.filter((r) => !r.partnerId).length} sin catálogo
            </p>
          )}
        </li>

        <li className="erp-card p-4">
          <p className="font-semibold">3. Existencias de corte</p>
          <p className="mt-1 text-muted">
            CSV: <code className="text-[12px]">código producto, bodega, cantidad, costo</code>. Entra al kardex como saldo inicial. Si ya hay INI de corte de ese producto/bodega, se brinca.
          </p>
          <textarea
            className="erp-input mt-2 min-h-24 font-mono text-[12px]"
            value={csvStock}
            onChange={(e) => setCsvStock(e.target.value)}
            placeholder={"ALB-10,001,25,18.5"}
          />
          <button
            type="button"
            className="erp-btn-primary mt-2"
            disabled={busy || !csvStock.trim()}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const r = await applyStockSnap({ data: { csv: csvStock } });
                setMsg(`Inventario de corte: ${r.inserted} partidas, ${r.skipped} ya estaban.`);
              } catch (e) {
                setError(humanError(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Cargar existencias
          </button>
        </li>

        <li className="erp-card p-4">
          <p className="font-semibold">Respaldo</p>
          <p className="mt-1 text-muted">Baja un JSON con facturas abiertas y existencias. Guárdalo fuera. No sustituye el respaldo de Postgres en producción.</p>
          <button
            type="button"
            className="erp-btn mt-3"
            onClick={async () => {
              try {
                const d = await exportBackup();
                const blob = new Blob([JSON.stringify(d, null, 2)], { type: "application/json" });
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = `azagro-respaldo-${d.at.slice(0, 10)}.json`;
                a.click();
              } catch (e) {
                setError(humanError(e));
              }
            }}
          >
            Descargar respaldo
          </button>
        </li>
      </ol>
      <DocFiles kind="cutover" entityId={0} />
    </AppShell>
  );
}
