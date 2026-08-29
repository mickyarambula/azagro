import { Bell } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { getAlertDigest, listNotifications, markNotificationsRead, sendDueAlerts } from "@/lib/erp/alerts";

export function AlertsBell() {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Awaited<ReturnType<typeof listNotifications>>["rows"]>([]);
  const [unread, setUnread] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    const n = await listNotifications();
    setRows(n.rows);
    setUnread(n.unread);
  }

  useEffect(() => {
    void load().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    void getAlertDigest()
      .then((d) => {
        if (!d.enabled || d.cxc + d.cxp === 0) return;
        const key = `azagro-push-${d.asOf}-${d.cxc}-${d.cxp}`;
        if (sessionStorage.getItem(key)) return;
        if (Notification.permission === "granted") {
          new Notification("Azagro · vencimientos", {
            body: `${d.cxc} por cobrar · ${d.cxp} por pagar`,
          });
          sessionStorage.setItem(key, "1");
        }
      })
      .catch(() => undefined);
  }, []);

  async function enablePush() {
    if (!("Notification" in window)) {
      setMsg("Este navegador no permite avisos.");
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      setMsg("Permiso denegado.");
      return;
    }
    setMsg("Avisos del navegador activados.");
    const d = await getAlertDigest();
    if (d.cxc + d.cxp > 0) {
      new Notification("Azagro · vencimientos", { body: `${d.cxc} por cobrar · ${d.cxp} por pagar` });
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        className="relative flex size-9 items-center justify-center rounded-md text-muted hover:bg-paper"
        aria-label="Avisos"
        onClick={() => {
          setOpen((v) => !v);
          setMsg(null);
        }}
      >
        <Bell className="size-4" />
        {unread > 0 ? (
          <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-danger text-[10px] font-semibold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="absolute right-0 z-50 mt-1 w-80 overflow-hidden rounded-lg border border-line bg-cream shadow-xl">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <p className="text-sm font-semibold">Avisos</p>
            <button
              type="button"
              className="text-[11px] font-medium text-accent"
              onClick={async () => {
                await markNotificationsRead({ data: {} });
                await load();
              }}
            >
              Marcar leídos
            </button>
          </div>
          <ul className="max-h-72 overflow-y-auto text-[13px]">
            {rows.map((r) => (
              <li key={r.id} className={`border-b border-line px-3 py-2 ${r.read_at ? "text-muted" : "text-ink"}`}>
                <p className="font-medium">{r.title}</p>
                <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-[12px]">{r.body}</p>
              </li>
            ))}
            {rows.length === 0 && <li className="px-3 py-6 text-center text-muted">Sin avisos aún.</li>}
          </ul>
          <div className="flex flex-col gap-1 border-t border-line p-2">
            {msg ? <p className="px-1 text-[12px] text-ok">{msg}</p> : null}
            <button type="button" className="erp-btn h-8 text-[12px]" onClick={() => void enablePush()}>
              Activar avisos del navegador
            </button>
            <button
              type="button"
              className="erp-btn-primary h-8 text-[12px]"
              onClick={async () => {
                const res = await sendDueAlerts();
                setMsg(res.notice);
                if (res.sent === "mailto" && res.mailto) window.location.href = res.mailto;
                await load();
              }}
            >
              Enviar alerta ahora
            </button>
            <Link to="/vencimientos" className="px-1 py-1 text-center text-[12px] text-accent" onClick={() => setOpen(false)}>
              Tabla de vencimientos
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
