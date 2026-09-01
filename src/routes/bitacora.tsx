import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { listAudit } from "@/lib/erp/audit";
import { humanError } from "@/lib/utils";

export const Route = createFileRoute("/bitacora")({ component: Page });

const ACTION: Record<string, string> = {
  recibir: "Recibió OC",
  entregar: "Entregó pedido",
  devolver: "Devolución",
  cobro: "Cobro",
  pago: "Pago",
  traslado: "Traslado",
  ajuste: "Ajuste de stock",
  archivo: "Archivo",
  corte: "Corte / importación",
  "importacion-fallida": "Importación FALLIDA",
  tiie: "Cambio de TIIE",
  "tipo-cambio": "Cambio de tipo de cambio",
  parametros: "Cambio de parámetros",
  "facturar-mora": "Facturó mora (FI)",
  "pronto-pago": "Descuento pronto pago",
  "ajuste-tc": "Ajuste TC (por cobrar/devolver)",
  "diferencial-tc": "Diferencial TC (utilidad)",
  "autorizar-credito": "Autorizó exceder límite",
  "rechazado-credito": "RECHAZADO por límite",
  "rechazado-permiso": "RECHAZADO sin permiso",
  conciliar: "Concilió banco",
  desconciliar: "Desconcilió banco",
  "saldo-banco": "Cambió saldo inicial banco",
  "credito-cliente": "Cambió crédito de cliente",
  "precio-producto": "Cambió costo/precio producto",
  "crear-solicitud": "Creó solicitud",
  "editar-solicitud": "Editó solicitud",
  "borrar-solicitud": "Borró solicitud",
  margen: "Cambió margen",
  "elegir-proveedor": "Eligió proveedor",
  "crear-cotizacion": "Creó cotización",
  "renegociar-cotizacion": "Renegoció cotización",
  "decidir-cotizacion": "Decidió cotización",
  "crear-pedido": "Creó pedido",
  "editar-pedido": "Editó pedido",
  "crear-oc": "Creó orden de compra",
  "alta-usuario": "Alta de usuario",
  "rechazar-solicitud": "Rechazó solicitud de acceso",
  "permisos-usuario": "Cambió permisos de usuario",
  correo: "Correo enviado",
  recordatorio: "Recordatorio de cobro",
};

type Payload = Awaited<ReturnType<typeof listAudit>>;

function Page() {
  const [data, setData] = useState<Payload | null>(null);
  const [rows, setRows] = useState<Payload["rows"]>([]);
  const [q, setQ] = useState("");
  const [action, setAction] = useState("");
  const [userId, setUserId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function load(offset = 0) {
    setBusy(true);
    setError(null);
    try {
      const d = await listAudit({
        data: { q: q || undefined, action: action || undefined, userId: userId || undefined, from: from || undefined, to: to || undefined, limit: 100, offset },
      });
      setData(d);
      setRows((prev) => (offset === 0 ? d.rows : [...prev, ...d.rows]));
      setDone(d.rows.length < 100);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, action, userId, from, to]);

  return (
    <AppShell>
      <h1 className="text-xl font-semibold">Bitácora</h1>
      <p className="mt-0.5 text-sm text-muted">
        Todo movimiento con quién, cuándo y qué cambió. No se edita ni se borra. Busca por folio, usuario, fecha o tipo.
      </p>
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}

      <div className="mt-4 flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-[11px] font-medium uppercase tracking-wide text-muted">
          Folio o texto
          <input className="erp-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="FV-0003, cliente, 5706…" />
        </label>
        <label className="grid gap-1 text-[11px] font-medium uppercase tracking-wide text-muted">
          Tipo
          <select className="erp-input" value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">Todos</option>
            {(data?.actions ?? []).map((a) => (
              <option key={a} value={a}>
                {ACTION[a] ?? a}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-[11px] font-medium uppercase tracking-wide text-muted">
          Usuario
          <select className="erp-input" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Todos</option>
            {(data?.users ?? []).map((u) => (
              <option key={u.user_id} value={u.user_id}>
                {u.who}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-[11px] font-medium uppercase tracking-wide text-muted">
          Desde
          <input type="date" className="erp-input" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="grid gap-1 text-[11px] font-medium uppercase tracking-wide text-muted">
          Hasta
          <input type="date" className="erp-input" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        {(q || action || userId || from || to) && (
          <button
            type="button"
            className="erp-btn"
            onClick={() => {
              setQ("");
              setAction("");
              setUserId("");
              setFrom("");
              setTo("");
            }}
          >
            Limpiar
          </button>
        )}
      </div>

      <div className="mt-4 overflow-x-auto erp-card">
        <table className="w-full min-w-[720px] text-left text-[13px]">
          <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3 font-medium">Cuándo</th>
              <th className="px-3 py-3 font-medium">Quién</th>
              <th className="px-3 py-3 font-medium">Qué</th>
              <th className="px-3 py-3 font-medium">Folio</th>
              <th className="px-3 py-3 font-medium">Detalle</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-line align-top">
                <td className="px-4 py-2 whitespace-nowrap tabular-nums text-muted">{r.created_at.replace("T", " ").slice(0, 19)}</td>
                <td className="px-3 py-2">{r.who}</td>
                <td className="px-3 py-2">{ACTION[r.action] ?? r.action}</td>
                <td className="px-3 py-2 font-medium">{r.name || "—"}</td>
                <td className="px-3 py-2 text-muted">{r.detail || "—"}</td>
              </tr>
            ))}
            {rows.length === 0 && !busy && (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-sm text-muted">
                  Nada con esos filtros.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {!done && rows.length > 0 && (
        <div className="mt-3 flex justify-center">
          <button type="button" className="erp-btn" disabled={busy} onClick={() => void load(rows.length)}>
            {busy ? "Cargando…" : "Cargar más"}
          </button>
        </div>
      )}
    </AppShell>
  );
}
