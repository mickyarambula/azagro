import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { DocFiles } from "@/components/doc-files";
import { useAccess } from "@/lib/access";
import { resyncCompaq } from "@/lib/erp/catalogs";
import { applyOpenInvoices, applyStockSnap, dbStatus, exportBackup, previewOpenInvoices, previewStockSnap } from "@/lib/erp/cutover";
import { listCreditPolicies } from "@/lib/erp/ops";
import { BACKUP_NOTE, clearLiveSince, LIVE_CLEAR_PHRASE, purgePreview, purgeTestData, setLiveSince } from "@/lib/erp/purge";
import { dateTimeMx, humanError } from "@/lib/utils";

export const Route = createFileRoute("/importar")({ component: Page });

/** Nombre para pantalla de cada tabla que el borrado toca (§ 2 de BORRADO-PRUEBAS.md). */
const TABLE_LABEL: Record<string, string> = {
  expenses: "Gastos",
  bank_moves: "Movimientos de banco",
  payments: "Cobros / pagos",
  invoices: "Facturas (fuera del corte)",
  customer_pos: "OC de cliente",
  purchase_orders: "Órdenes de compra",
  sales_orders: "Pedidos",
  vendor_rfqs: "Solicitudes a proveedor (SC)",
  quotes: "Cotizaciones",
  customer_requests: "Solicitudes",
  stock_moves: "Movimientos de kardex (fuera del corte)",
  stock_quants: "Existencias (se reconstruyen)",
  documents: "Documentos",
  doc_files: "Archivos adjuntos (fuera del corte)",
  notifications: "Avisos",
  folio_counters: "Contadores de folio (se re-siembran)",
};

function Page() {
  const [msg, setMsg] = useState<string | null>(null);
  // Decisión 66: las filas que no entraron, con su razón, para corregir el
  // CSV o el catálogo y volver a pegar (lo cargado no se duplica).
  const [rejects, setRejects] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [db, setDb] = useState("");
  const [csvInv, setCsvInv] = useState("");
  const [csvStock, setCsvStock] = useState("");
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewOpenInvoices>> | null>(null);
  const [stockPreview, setStockPreview] = useState<Awaited<ReturnType<typeof previewStockSnap>> | null>(null);
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
      {rejects.length > 0 && (
        <div className="mt-2 max-w-2xl rounded border border-warn/40 bg-warn/5 p-3 text-[12px]">
          <p className="font-medium">No entraron {rejects.length} filas — corrige y vuelve a pegar (lo ya cargado no se duplica):</p>
          <ul className="mt-1 list-disc pl-4">
            {rejects.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}

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
                    `Cartera de corte: ${r.inserted} nuevas, ${r.skipped} ya estaban (no se duplicaron)${r.rejected.length ? `, ${r.rejected.length} rechazadas` : ""}. Política ${pol?.name ?? policyCode}.`,
                  );
                  setRejects(r.rejected.map((x) => x.reason));
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
            <div className="mt-2 text-[12px] text-muted">
              <p>
                {preview.open} entrarían · {preview.skipped} ya están · {preview.rows.filter((r) => !r.partnerId).length} sin catálogo
                {preview.differing > 0 && <span className="text-warn"> · {preview.differing} con otros importes</span>}
              </p>
              {preview.differing > 0 && (
                <ul className="mt-1 list-disc pl-4 text-warn">
                  {preview.rows.filter((r) => r.differs).map((r) => (
                    <li key={r.key}>{r.differs}</li>
                  ))}
                </ul>
              )}
            </div>
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
          <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            className="erp-btn"
            disabled={busy || !csvStock.trim()}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                setStockPreview(await previewStockSnap({ data: { csv: csvStock } }));
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
            disabled={busy || !csvStock.trim()}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const r = await applyStockSnap({ data: { csv: csvStock } });
                setMsg(
                  `Inventario de corte: ${r.inserted} partidas, ${r.skipped} ya estaban${r.rejected.length ? `, ${r.rejected.length} rechazadas` : ""}.`,
                );
                setRejects(r.rejected.map((x) => x.reason));
                setStockPreview(null);
              } catch (e) {
                setError(humanError(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Cargar existencias
          </button>
          </div>
          {stockPreview && (
            <div className="mt-2 text-[12px] text-muted">
              <p>
                {stockPreview.open} entrarían · {stockPreview.skipped} ya están · {stockPreview.problems} con problema
                {stockPreview.differing > 0 && <span className="text-warn"> · {stockPreview.differing} con otros números</span>}
              </p>
              {(stockPreview.differing > 0 || stockPreview.problems > 0) && (
                <ul className="mt-1 list-disc pl-4">
                  {stockPreview.rows.filter((r) => r.differs || r.problem).map((r, i) => (
                    <li key={i} className={r.differs ? "text-warn" : undefined}>{r.differs ?? r.problem}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
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
        <PurgeSection />
      </ol>
      <DocFiles kind="cutover" entityId={0} />
    </AppShell>
  );
}

/**
 * BLOQUE C4 — Borrar datos de prueba, paso 5. Solo administrador (B6, el
 * mismo candado que en el servidor). Preview de solo lectura (foto: no
 * bloquea filas, puede cambiar entre el clic y el borrado); la protección
 * real es el nombre de la empresa tecleado, que el plan compara adentro de
 * la transacción antes de la primera sentencia.
 */
function PurgeSection() {
  const { role } = useAccess();
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof purgePreview>> | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [confirmName, setConfirmName] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const [liveDialog, setLiveDialog] = useState<"start" | "stop" | null>(null);
  const [liveName, setLiveName] = useState("");
  const [livePhrase, setLivePhrase] = useState("");
  const [liveReason, setLiveReason] = useState("");
  const [liveBusy, setLiveBusy] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);

  // Candado B6: solo administrador dispara el preview — la misma condición
  // que el servidor exige otra vez adentro de purgePreview / purgeTestData.
  useEffect(() => {
    if (role === "admin") void loadPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  async function loadPreview() {
    setLoadingPreview(true);
    setPreviewError(null);
    try {
      setPreview(await purgePreview());
    } catch (e) {
      setPreviewError(humanError(e));
    } finally {
      setLoadingPreview(false);
    }
  }

  if (role !== "admin") return null;

  const nameMatches = Boolean(preview) && confirmName.trim() !== "" && confirmName.trim() === preview!.company.name.trim();
  const canPurge = Boolean(preview) && preview!.allowed && nameMatches && Boolean(reason.trim()) && !busy;
  const totalRows = preview?.counts.reduce((s, c) => s + c.count, 0) ?? 0;

  async function doPurge() {
    if (!canPurge) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await purgeTestData({ data: { confirmName: confirmName.trim(), reason: reason.trim() } });
      const deleted = r.deleted.filter((d) => d.kind === "delete" && d.count > 0).map((d) => `${TABLE_LABEL[d.table] ?? d.table}: ${d.count}`);
      setResult(`Borrado en «${r.company.name}»: ${deleted.length ? deleted.join(", ") : "no había nada que borrar"}.`);
      setConfirmName("");
      setReason("");
      await loadPreview();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  }

  function openLiveDialog(which: "start" | "stop") {
    setLiveDialog(which);
    setLiveName("");
    setLivePhrase("");
    setLiveReason("");
    setLiveError(null);
  }

  async function doLive() {
    if (!liveDialog) return;
    setLiveBusy(true);
    setLiveError(null);
    try {
      if (liveDialog === "start") {
        await setLiveSince({ data: { confirmName: liveName.trim(), reason: liveReason.trim() } });
      } else {
        await clearLiveSince({
          data: { confirmName: liveName.trim(), phrase: livePhrase.trim(), reason: liveReason.trim() },
        });
      }
      setLiveDialog(null);
      await loadPreview();
    } catch (e) {
      setLiveError(humanError(e));
    } finally {
      setLiveBusy(false);
    }
  }

  return (
    <li className="erp-card border-warn p-4">
      <p className="font-semibold">Datos de prueba</p>
      <p className="mt-1 text-muted">
        Borra lo capturado en la app que no es del corte de Compaq: pedidos, OC, cotizaciones, solicitudes, cobros, pagos,
        gastos, movimientos de banco y de kardex, documentos y avisos. El corte (facturas con folio del corte, existencias
        iniciales, sus CSV) y los catálogos, Ajustes, personas y la bitácora <strong>se conservan siempre</strong>. Es la única
        excepción a "no se borra" del sistema, y solo existe antes de que arranque la operación real.
      </p>

      {preview?.liveSince ? (
        <div className="mt-3 rounded-md border border-danger bg-cream px-3 py-2 text-[12px] text-danger">
          <p className="font-semibold">
            «{preview.company.name}» arrancó la operación real el {dateTimeMx(preview.liveSince).slice(0, 8)}: los datos de
            prueba ya no se pueden borrar.
          </p>
          <button type="button" className="erp-btn mt-2 h-7 text-[12px]" onClick={() => openLiveDialog("stop")}>
            Regresar a pruebas…
          </button>
        </div>
      ) : (
        <button type="button" className="erp-btn mt-3 h-8 text-[12px]" onClick={() => openLiveDialog("start")}>
          Arrancó la operación real…
        </button>
      )}

      {loadingPreview && <p className="mt-3 text-[12px] text-muted">Revisando qué se borraría…</p>}
      {previewError && <p className="mt-3 text-[12px] text-danger">{previewError}</p>}

      {preview && !preview.liveSince ? (
        <>
          <p className="mt-3 text-[12px] font-semibold">
            Foto de lo que se borraría ahora mismo{totalRows ? ` — ${totalRows} fila${totalRows === 1 ? "" : "s"} en total` : ""}:
          </p>
          <p className="mt-1 text-[12px] text-muted">
            Es una foto, no un número exacto: no bloquea filas, y puede cambiar si alguien captura algo entre este preview y
            el borrado. La protección real no es este conteo — es que el nombre de la empresa tecleado abajo coincida,
            exacto, antes de que se borre una sola fila.
          </p>
          {totalRows > 0 ? (
            <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[12px] text-ink-soft sm:grid-cols-3">
              {preview.counts
                .filter((c) => c.count > 0)
                .map((c) => (
                  <li key={c.table}>
                    {TABLE_LABEL[c.table] ?? c.table}: <span className="font-medium">{c.count}</span>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="mt-2 text-[12px] text-ok">No hay nada que borrar: solo queda el corte y los catálogos.</p>
          )}
          {preview.warnings.length ? (
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[12px] text-warn">
              {preview.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          ) : null}
          <p className="mt-2 text-[12px] text-muted">{BACKUP_NOTE}</p>

          {preview.blockers.length ? (
            <div className="mt-3 rounded-md border border-danger bg-cream px-3 py-2 text-[12px] text-danger">
              <ul className="list-disc space-y-1 pl-5">
                {preview.blockers.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            </div>
          ) : (
            <>
              <label className="mt-3 grid gap-1 text-[12px] font-medium">
                Nombre exacto de la empresa («{preview.company.name}»)
                <input
                  className="erp-input"
                  value={confirmName}
                  onChange={(e) => setConfirmName(e.target.value)}
                  placeholder={preview.company.name}
                />
              </label>
              <label className="mt-2 grid gap-1 text-[12px] font-medium">
                Motivo (obligatorio)
                <textarea className="erp-input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Por qué se borra…" />
              </label>
              <button type="button" className="erp-btn mt-3 h-8 text-[12px] text-danger" disabled={!canPurge} onClick={() => void doPurge()}>
                {busy ? "Borrando…" : "Borrar datos de prueba"}
              </button>
            </>
          )}
        </>
      ) : null}

      {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
      {result && <p className="mt-2 text-[12px] text-ok">{result}</p>}

      {liveDialog ? (
        <div className="fixed inset-0 z-[90] grid place-items-center bg-ink/40 p-4" onClick={() => !liveBusy && setLiveDialog(null)}>
          <div className="w-full max-w-md rounded-xl border border-line bg-cream p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-base font-semibold">{liveDialog === "start" ? "Arrancó la operación real" : "Regresar a pruebas"}</h2>
            <p className="mt-1 text-[12px] text-muted">
              {liveDialog === "start"
                ? "Desde aquí el borrado de datos de prueba se niega para siempre en esta empresa."
                : `Difícil a propósito: se niega si hay documentos o bitácora posteriores al arranque. Teclea «${LIVE_CLEAR_PHRASE}» exacto.`}
            </p>
            <label className="mt-3 grid gap-1 text-[12px] font-medium">
              Nombre exacto de la empresa{preview ? ` («${preview.company.name}»)` : ""}
              <input className="erp-input" value={liveName} onChange={(e) => setLiveName(e.target.value)} />
            </label>
            {liveDialog === "stop" ? (
              <label className="mt-2 grid gap-1 text-[12px] font-medium">
                Escribe «{LIVE_CLEAR_PHRASE}»
                <input className="erp-input" value={livePhrase} onChange={(e) => setLivePhrase(e.target.value)} placeholder={LIVE_CLEAR_PHRASE} />
              </label>
            ) : null}
            <label className="mt-2 grid gap-1 text-[12px] font-medium">
              Motivo (obligatorio)
              <textarea className="erp-input" rows={2} value={liveReason} onChange={(e) => setLiveReason(e.target.value)} />
            </label>
            {liveError && <p className="mt-2 text-[12px] text-danger">{liveError}</p>}
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                className="erp-btn-primary"
                disabled={liveBusy || !liveName.trim() || !liveReason.trim() || (liveDialog === "stop" && !livePhrase.trim())}
                onClick={() => void doLive()}
              >
                {liveBusy ? "Guardando…" : "Confirmar"}
              </button>
              <button type="button" className="erp-btn ml-auto" disabled={liveBusy} onClick={() => setLiveDialog(null)}>
                Cerrar
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </li>
  );
}
