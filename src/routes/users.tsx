import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { PageHead, StatusPill } from "@/components/erp";
import { useAccess } from "@/lib/access";
import { MODULES, ROLE_META, templateAcl, type AclLevel, type AppRole } from "@/lib/erp/acl";
import { approveAccess, listTeam, rejectAccess, updateMember } from "@/lib/erp/users";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/users")({ component: Page });

const ROLE_ORDER: AppRole[] = [
  "admin",
  "gerencia",
  "administracion",
  "ventas",
  "compras",
  "almacen",
  "cobranza",
  "consulta",
];

const GROUPS: { title: string; ids: string[] }[] = [
  { title: "Operación", ids: ["dashboard", "quotes", "sales", "purchases", "inventory"] },
  { title: "Finanzas", ids: ["credit", "gastos", "banks", "statements"] },
  { title: "Catálogos", ids: ["partners", "products"] },
  { title: "Sistema", ids: ["settings", "users"] },
];

function Page() {
  return (
    <AppShell>
      <UsersBody />
    </AppShell>
  );
}

function UsersBody() {
  const { can } = useAccess();
  const [data, setData] = useState<Awaited<ReturnType<typeof listTeam>> | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [rolePick, setRolePick] = useState<AppRole>("gerencia");
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"equipo" | "roles">("equipo");
  const canEdit = can("users", "edit");

  async function load() {
    setData(await listTeam());
  }
  useEffect(() => {
    void load().catch((e) => setError(e instanceof Error ? e.message : "Error"));
  }, []);

  const open = data?.members.find((m) => m.id === openId);

  return (
    <>
      <PageHead
        title="Usuarios y permisos"
        hint="El rol es la plantilla. Luego se puede afinar módulo por módulo: nada, ver o editar."
      />
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}

      <div className="mb-4 flex gap-1">
        <button type="button" className={tab === "equipo" ? "erp-btn-primary" : "erp-btn"} onClick={() => setTab("equipo")}>
          Equipo
        </button>
        <button type="button" className={tab === "roles" ? "erp-btn-primary" : "erp-btn"} onClick={() => setTab("roles")}>
          Roles
        </button>
      </div>

      {tab === "roles" ? (
        <RolesMatrix />
      ) : (
        <>
          <div className="erp-card mb-5 p-4 text-sm">
            <p className="font-semibold">Mañana, el director</p>
            <ol className="mt-2 space-y-1 text-muted">
              <li>1. Él entra al enlace publicado → <strong>Crear cuenta</strong> (su correo).</li>
              <li>2. Pulsa <strong>Solicitar acceso</strong>.</li>
              <li>3. Tú, en esta pantalla, eliges <strong>Gerencia</strong> y <strong>Aprobar</strong>.</li>
              <li>4. Si quieren menos o más, <strong>Permisos</strong> y se ajusta por módulo.</li>
            </ol>
          </div>

          {data && data.requests.length > 0 && (
            <div className="erp-card mb-5 border-accent p-4">
              <h2 className="text-sm font-semibold">Solicitudes pendientes</h2>
              <ul className="mt-3 grid gap-3">
                {data.requests.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3 last:border-0 last:pb-0">
                    <div>
                      <p className="font-medium">{r.name || r.email || "Usuario"}</p>
                      <p className="text-sm text-muted">{r.email || r.user_id}</p>
                    </div>
                    {canEdit && (
                      <div className="flex flex-wrap items-center gap-2">
                        <select className="erp-input" value={rolePick} onChange={(e) => setRolePick(e.target.value as AppRole)}>
                          {ROLE_ORDER.map((k) => (
                            <option key={k} value={k}>
                              {ROLE_META[k].label}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="erp-btn-primary"
                          onClick={() =>
                            approveAccess({ data: { requestId: r.id, role: rolePick } })
                              .then(load)
                              .catch((e) => setError(e instanceof Error ? e.message : "Error"))
                          }
                        >
                          Aprobar
                        </button>
                        <button type="button" className="erp-btn" onClick={() => rejectAccess({ data: { requestId: r.id } }).then(load)}>
                          Rechazar
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[12px] text-muted">{ROLE_META[rolePick].hint}</p>
            </div>
          )}

          <div className="overflow-x-auto erp-card">
            <table className="w-full min-w-[720px] text-left text-[13px]">
              <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Usuario</th>
                  <th className="px-3 py-2 font-medium">Rol</th>
                  <th className="px-3 py-2 font-medium">Alcance</th>
                  <th className="px-3 py-2 font-medium">Estado</th>
                  <th className="px-3 py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {data?.members.map((m) => (
                  <tr key={m.id} className="border-t border-line">
                    <td className="px-3 py-2.5">
                      <p className="font-medium">{m.name}</p>
                      <p className="text-xs text-muted">{m.email || m.user_id}</p>
                    </td>
                    <td className="px-3 py-2.5">{ROLE_META[m.role as AppRole]?.label ?? m.role}</td>
                    <td className="px-3 py-2.5 text-muted">{m.own_only ? "Solo su cartera" : "Toda la empresa"}</td>
                    <td className="px-3 py-2.5">
                      <StatusPill tone={m.status === "active" ? "ok" : "muted"}>
                        {m.status === "active" ? "Activo" : "Desactivado"}
                      </StatusPill>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {canEdit && (
                        <button type="button" className="erp-btn h-8 text-[12px]" onClick={() => setOpenId(m.id)}>
                          Permisos
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {open && (
        <MemberEditor
          member={open}
          onClose={() => setOpenId(null)}
          onSaved={async () => {
            setOpenId(null);
            await load();
          }}
          onError={setError}
        />
      )}
    </>
  );
}

function RolesMatrix() {
  return (
    <div className="erp-card overflow-x-auto p-4">
      <p className="text-sm text-muted">
        Plantillas de fábrica. Al aprobar a alguien se copian; luego se pueden cambiar persona por persona sin afectar a los demás.
      </p>
      <table className="mt-4 w-full min-w-[860px] text-left text-[12px]">
        <thead>
          <tr className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
            <th className="py-2 pr-3 font-medium">Módulo</th>
            {ROLE_ORDER.map((r) => (
              <th key={r} className="px-2 py-2 font-medium">
                {ROLE_META[r].label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {GROUPS.map((g) => (
            <Fragment key={g.title}>
              <tr>
                <td colSpan={ROLE_ORDER.length + 1} className="bg-paper px-0 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
                  {g.title}
                </td>
              </tr>
              {g.ids.map((id) => {
                const label = MODULES.find((m) => m.id === id)?.label ?? id;
                return (
                  <tr key={id} className="border-t border-line">
                    <td className="py-2 pr-3 font-medium">{label}</td>
                    {ROLE_ORDER.map((r) => {
                      const lv = templateAcl(r)[id as keyof ReturnType<typeof templateAcl>];
                      return (
                        <td key={r} className="px-2 py-2">
                          <LevelChip level={lv} />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </Fragment>
          ))}
        </tbody>
      </table>
      <ul className="mt-4 grid gap-2 text-[13px] text-muted sm:grid-cols-2">
        {ROLE_ORDER.map((r) => (
          <li key={r}>
            <strong className="text-ink">{ROLE_META[r].label}.</strong> {ROLE_META[r].hint}
          </li>
        ))}
      </ul>
    </div>
  );
}

function LevelChip({ level }: { level: AclLevel }) {
  if (level === "edit") return <span className="rounded bg-ok/15 px-1.5 py-0.5 font-medium text-ok">Editar</span>;
  if (level === "view") return <span className="rounded bg-accent/10 px-1.5 py-0.5 font-medium text-accent">Ver</span>;
  return <span className="text-muted">—</span>;
}

function MemberEditor({
  member,
  onClose,
  onSaved,
  onError,
}: {
  member: Awaited<ReturnType<typeof listTeam>>["members"][number];
  onClose: () => void;
  onSaved: () => void;
  onError: (s: string) => void;
}) {
  const [role, setRole] = useState<AppRole>(ROLE_META[member.role as AppRole] ? (member.role as AppRole) : "consulta");
  const [status, setStatus] = useState<"active" | "disabled">(member.status === "disabled" ? "disabled" : "active");
  const [ownOnly, setOwnOnly] = useState(member.own_only);
  const [acl, setAcl] = useState<Record<string, AclLevel>>(() => {
    const t = { ...Object.fromEntries(MODULES.map((m) => [m.id, "none" as AclLevel])) };
    return { ...t, ...member.acl };
  });
  const [busy, setBusy] = useState(false);

  function applyTemplate(r: AppRole) {
    setRole(r);
    setOwnOnly(ROLE_META[r].ownOnly);
    setAcl(templateAcl(r));
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/40 p-4">
      <div className="max-h-[90dvh] w-full max-w-2xl overflow-y-auto erp-card p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{member.name}</h2>
            <p className="text-sm text-muted">{member.email}</p>
          </div>
          <button type="button" className="erp-btn" onClick={onClose}>
            Cerrar
          </button>
        </div>
        <label className="mt-4 grid gap-1 text-sm font-medium">
          Rol (plantilla)
          <select className="erp-input" value={role} onChange={(e) => applyTemplate(e.target.value as AppRole)}>
            {ROLE_ORDER.map((k) => (
              <option key={k} value={k}>
                {ROLE_META[k].label}
              </option>
            ))}
          </select>
        </label>
        <p className="mt-1 text-sm text-muted">{ROLE_META[role].hint} Cambiar el rol pisa los ticks de abajo.</p>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={ownOnly} onChange={(e) => setOwnOnly(e.target.checked)} />
          Solo su cartera (vendedor: clientes, cotizaciones y pedidos propios)
        </label>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={status === "active"} onChange={(e) => setStatus(e.target.checked ? "active" : "disabled")} />
          Usuario activo
        </label>

        {GROUPS.map((g) => (
          <div key={g.title} className="mt-5">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">{g.title}</h3>
            <ul className="mt-2 divide-y divide-line">
              {g.ids.map((id) => {
                const label = MODULES.find((m) => m.id === id)?.label ?? id;
                const lv = acl[id] ?? "none";
                return (
                  <li key={id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span className="text-sm">{label}</span>
                    <div className="flex gap-1">
                      {(["none", "view", "edit"] as AclLevel[]).map((opt) => (
                        <button
                          key={opt}
                          type="button"
                          className={cn("h-8 rounded-md px-2.5 text-[12px] font-medium", lv === opt ? "bg-brand text-white" : "border border-line hover:bg-paper")}
                          onClick={() => setAcl({ ...acl, [id]: opt })}
                        >
                          {opt === "none" ? "Nada" : opt === "view" ? "Ver" : "Editar"}
                        </button>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}

        <button
          type="button"
          className="erp-btn-primary mt-5"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            updateMember({
              data: { memberId: member.id, role, status, ownOnly, acl, resetAcl: false },
            })
              .then(onSaved)
              .catch((e) => onError(e instanceof Error ? e.message : "Error"))
              .finally(() => setBusy(false));
          }}
        >
          Guardar permisos
        </button>
      </div>
    </div>
  );
}
