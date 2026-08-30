import { Link, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  BarChart3,
  ClipboardList,
  ChevronDown,
  HelpCircle,
  Menu,
  Moon,
  Search,
  Settings,
  Star,
  Sun,
  Users,
  Warehouse,
  Wallet,
  X,
} from "lucide-react";
import { RedirectToSignIn, SignOutButton, UserButton } from "@/lib/auth/gates";
import { AlertsBell } from "@/components/alerts-bell";
import { LogoLockup, LogoMark } from "@/components/brand";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { AccessProvider } from "@/lib/access";
import { createCompany } from "@/lib/azagro";
import { getAlertDigest } from "@/lib/erp/alerts";
import { getAccessState, requestAccess } from "@/lib/erp/users";
import { pathModule, type AclLevel, type ModuleId } from "@/lib/erp/acl";
import { MODULES, moduleForPath, sectionForPath, tabTone, type ModuleDef } from "@/lib/nav";
import { applyTheme, readThemePref, resolvedTheme, type ThemePref } from "@/lib/theme";
import { rememberPath } from "@/lib/trail";
import { cn } from "@/lib/utils";

const DocPreviewHost = lazy(() =>
  import("@/components/doc-preview").then((m) => ({ default: m.DocPreviewHost })),
);
const RAIL_ICONS: Record<string, typeof Star> = {
  favorites: Star,
  orders: ClipboardList,
  warehouse: Warehouse,
  contacts: Users,
  finance: Wallet,
  reports: BarChart3,
  settings: Settings,
};

type AccessPayload = Awaited<ReturnType<typeof getAccessState>>;

let accessCache: { at: number; data: AccessPayload; userId: string } | null = null;

let digestCache: { at: number; data: Awaited<ReturnType<typeof getAlertDigest>> } | null = null;
let navPinned = "";

function tabFromSearch(search: string) {
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return q.get("tab");
}

export function AppShell({ children, flush }: { children: React.ReactNode; flush?: boolean }) {
  const { user, isPending } = useCurrentUserState();
  const [state, setState] = useState<AccessPayload | null>(accessCache?.data ?? null);
  const [bootStuck, setBootStuck] = useState(false);
  const [themePref, setThemePref] = useState<ThemePref>("system");
  const [open, setOpen] = useState(false);
  const [modOpen, setModOpen] = useState(false);
  const [secOpen, setSecOpen] = useState(false);
  const [find, setFind] = useState(false);
  const [digest, setDigest] = useState(digestCache?.data ?? null);
  const [navHover, setNavHover] = useState("");
  const [navOpen, setNavOpen] = useState(navPinned || "");
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const search = useRouterState({ select: (s) => s.location.searchStr || "" });
  const navigate = useNavigate();
  const router = useRouter();

  useEffect(() => {
    rememberPath(pathname + search);
  }, [pathname, search]);

  async function refresh(force = false) {
    const uid = user?.id ?? "";
    try {
      if (
        !force &&
        accessCache &&
        accessCache.userId === uid &&
        accessCache.data.status === "ok" &&
        Date.now() - accessCache.at < 90_000
      ) {
        setState(accessCache.data);
        return;
      }
      const data = await getAccessState();
      // A blip that returns "none" must not kick a logged-in member to "crear empresa".
      if (
        !force &&
        data.status !== "ok" &&
        accessCache?.data.status === "ok" &&
        accessCache.userId === uid
      ) {
        setState(accessCache.data);
        return;
      }
      accessCache = { at: Date.now(), data, userId: uid };
      setState(data);
    } catch (err) {
      console.error(err);
      if (accessCache?.data && accessCache.userId === uid) {
        setState(accessCache.data);
        return;
      }
    }
  }

  useEffect(() => {
    if (!user) return;
    setBootStuck(false);
    const t = window.setTimeout(() => setBootStuck(true), 8000);
    void refresh().finally(() => window.clearTimeout(t));
    return () => window.clearTimeout(t);
  }, [user]);

  useEffect(() => {
    if (!state || state.status !== "ok") return;
    if (digestCache && Date.now() - digestCache.at < 180_000) {
      setDigest(digestCache.data);
      return;
    }
    void getAlertDigest()
      .then((d) => {
        digestCache = { at: Date.now(), data: d };
        setDigest(d);
      })
      .catch(() => undefined);
  }, [state?.status]);

  useEffect(() => {
    if (!digest?.enabled) return;
    if (digest.cxc + digest.cxp === 0) return;
    const key = "azagro-daily-alert";
    const last = Number(localStorage.getItem(key) || 0);
    if (Date.now() - last < 20 * 60 * 60 * 1000) return;
    localStorage.setItem(key, String(Date.now()));
    void import("@/lib/erp/alerts")
      .then(({ sendDueAlerts }) => sendDueAlerts())
      .catch(() => undefined);
  }, [digest]);

  useEffect(() => {
    const pref = readThemePref();
    setThemePref(pref);
    applyTheme(pref);
  }, []);

  const acl: Record<string, AclLevel> = state?.workspace?.acl ?? {};
  const access = useMemo(
    () => ({
      role: state?.workspace?.role ?? "",
      roleLabel: state?.workspace?.roleLabel ?? "",
      ownOnly: state?.workspace?.ownOnly ?? false,
      acl,
      can: (mod: ModuleId, need: AclLevel = "view") => {
        const have = acl[mod] ?? "none";
        if (need === "view") return have !== "none";
        return have === "edit";
      },
    }),
    [state, acl],
  );

  if (isPending || (user && !state)) {
    return (
      <div className="grid min-h-dvh place-items-center bg-paper">
        <div className="text-center">
          <LogoLockup height="h-12" />
          <p className="mt-3 text-sm text-muted">Cargando…</p>
          {bootStuck ? (
            <div className="mt-3 flex flex-col items-center gap-2">
              <button type="button" className="erp-btn" onClick={() => { setBootStuck(false); void refresh(); }}>
                Seguir esperando / reintentar
              </button>
              <SignOutButton />
            </div>
          ) : null}
        </div>
      </div>
    );
  }
  if (!user) return <RedirectToSignIn />;
  if (!state) return <RedirectToSignIn />;
  if (state.status === "disabled") {
    return (
      <main className="grid min-h-dvh place-items-center bg-paper px-4">
        <div className="w-full max-w-md erp-card p-7 text-center">
          <LogoLockup height="h-14" />
          <h1 className="mt-4 text-xl font-semibold">Usuario desactivado</h1>
          <p className="mt-2 text-sm text-muted">Habla con el administrador de tu empresa para reactivarlo.</p>
          <SignOutButton className="erp-btn mt-5 w-full" />
        </div>
      </main>
    );
  }
  if (state.status === "pending" || state.status === "none") {
    return <Onboard state={state} onDone={refresh} />;
  }

  const ws = state.workspace!;
  const canSeePath = (to: string) => {
    const mod = pathModule(to);
    return (acl[mod] ?? "none") !== "none";
  };
  const visibleModules = MODULES.filter((m) => {
    if (m.id === "favorites") return (acl.dashboard ?? "none") !== "none";
    if (m.id === "settings") return (acl.settings ?? "none") !== "none" || (acl.users ?? "none") !== "none";
    return m.sections.some((s) => canSeePath(s.to));
  });
  const mod = moduleForPath(pathname);
  const section = sectionForPath(pathname, search);
  const tone = tabTone(pathname);
  const searchTab = tabFromSearch(search);
  const currentTab =
    pathname.startsWith("/sales/nuevo") || pathname.startsWith("/solicitudes/nuevo")
      ? "nuevo"
      : searchTab || section.tabs?.[0]?.tab || "all";
  const blocked = (acl[pathModule(pathname)] ?? "none") === "none";
  const dark = resolvedTheme(themePref) === "dark";
  const bleed =
    flush ||
    pathname === "/" ||
    ["/sales", "/purchases", "/partners", "/products"].some((p) => pathname === p || pathname.startsWith(p + "/"));

  function toggleTheme() {
    const next: ThemePref = dark ? "light" : "dark";
    setThemePref(next);
    applyTheme(next);
  }

  function sectionOn(s: (typeof mod.sections)[number]) {
    if (s.to === "/") return pathname === "/";
    if (!pathname.startsWith(s.to)) return false;
    if (s.search?.lado) {
      const lado = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("lado");
      return (lado || "cobrar") === s.search.lado;
    }
    if (s.search?.tab) {
      const tab = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("tab");
      if (s.to === "/bodegas") return (tab || "bodegas") === s.search.tab;
      return tab === s.search.tab;
    }
    return true;
  }

  function folderOpen(id: string) {
    return navHover === id || navOpen === id || mod.id === id;
  }

  function renderFolders(onGo?: () => void) {
    return visibleModules.map((m) => {
      const Icon = RAIL_ICONS[m.id] ?? ClipboardList;
      const openFolder = folderOpen(m.id);
      return (
        <div
          key={m.id}
          className="mb-0.5"
          onMouseEnter={() => setNavHover(m.id)}
          onMouseLeave={() => setNavHover("")}
        >
          <button
            type="button"
            className={cn(
              "flex w-full min-h-10 items-center gap-2 rounded-md px-2 text-[13px] font-medium",
              mod.id === m.id ? "bg-brand-soft text-forest" : "text-ink hover:bg-paper",
            )}
            onClick={() => {
              const next = navOpen === m.id && m.id !== mod.id ? "" : m.id;
              navPinned = next;
              setNavOpen(next);
            }}
          >
            <Icon className="size-4 shrink-0" />
            <span className="flex-1 text-left">{m.label}</span>
            <ChevronDown className={cn("size-3.5 text-muted transition", openFolder && "rotate-180")} />
          </button>
          {openFolder
            ? m.sections.map((s) => (
                <Link
                  key={s.to + s.label + JSON.stringify(s.search ?? {})}
                  to={s.to as "/"}
                  search={(s.search ?? {}) as never}
                  preload="intent"
                  onClick={onGo}
                  className={cn(
                    "ml-6 flex min-h-9 items-center rounded-md px-2 text-[13px]",
                    sectionOn(s) ? "font-medium text-forest" : "text-muted hover:bg-paper hover:text-ink",
                  )}
                >
                  {s.label}
                </Link>
              ))
            : null}
        </div>
      );
    });
  }

  return (
    <AccessProvider value={access}>
      <div className="min-h-dvh bg-paper text-ink lg:grid lg:grid-cols-[14rem_1fr]">
        <aside className="hidden overflow-y-auto border-r border-line bg-cream lg:flex lg:flex-col">
          <Link to="/" className="flex items-center gap-2 px-3 py-3" aria-label="Azagro">
            <LogoMark className="h-8" />
            <span className="text-sm font-semibold">Azagro</span>
          </Link>
          <nav className="flex-1 px-2 pb-4">{renderFolders()}</nav>
        </aside>

        <div className="flex min-w-0 flex-col">
          <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-line bg-cream px-2 sm:px-4">
            <button
              type="button"
              className="flex size-11 items-center justify-center rounded-md hover:bg-paper lg:hidden"
              onClick={() => setOpen((v) => !v)}
              aria-label="Menú"
            >
              {open ? <X className="size-5" /> : <Menu className="size-5" />}
            </button>
            {pathname !== "/" ? (
              <button
                type="button"
                className="flex size-9 items-center justify-center rounded-md text-muted hover:bg-paper hover:text-ink"
                aria-label="Volver"
                title="Volver"
                onClick={() => router.history.back()}
              >
                <ArrowLeft className="size-4" />
              </button>
            ) : null}

            <div className="relative flex min-w-0 items-center gap-1">
              <button
                type="button"
                className="flex h-9 items-center gap-1 rounded-md px-2 text-sm font-semibold hover:bg-paper"
                onClick={() => {
                  setModOpen((v) => !v);
                  setSecOpen(false);
                }}
              >
                {mod.label}
                <ChevronDown className="size-4 text-muted" />
              </button>
              {modOpen ? (
                <MenuList
                  items={visibleModules
                    .filter((m) => m.id !== "favorites" && m.id !== "settings")
                    .map((m) => ({ to: m.to, label: m.label }))}
                  onClose={() => setModOpen(false)}
                />
              ) : null}
              <span className="hidden text-line sm:inline">|</span>
              <button
                type="button"
                className="flex h-9 min-w-0 items-center gap-1 rounded-md px-2 text-sm font-medium hover:bg-paper"
                onClick={() => {
                  setSecOpen((v) => !v);
                  setModOpen(false);
                }}
              >
                <span className="truncate">{section.label}</span>
                <Star className={cn("size-3.5", section.starred ? "fill-warn text-warn" : "text-muted")} />
                <ChevronDown className="size-4 text-muted" />
              </button>
              {secOpen ? (
                <MenuList
                  className="left-16"
                  items={mod.sections.map((s) => ({ to: s.to, label: s.label, search: s.search }))}
                  onClose={() => setSecOpen(false)}
                />
              ) : null}
            </div>

            <div className="ml-auto flex items-center gap-1 sm:gap-2">
              <button
                type="button"
                className="flex size-9 items-center justify-center rounded-md text-muted hover:bg-paper"
                aria-label="Buscar"
                onClick={() => setFind(true)}
              >
                <Search className="size-4" />
              </button>
              <button
                type="button"
                className="flex size-9 items-center justify-center rounded-md text-muted hover:bg-paper"
                aria-label="Tema"
                title={dark ? "Modo claro" : "Modo oscuro"}
                onClick={toggleTheme}
              >
                {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
              </button>
              <AlertsBell />
              <div className="hidden items-center gap-2 sm:flex">
                <LogoMark className="h-8 w-auto" />
                <div className="leading-tight">
                  <div className="text-xs font-semibold">{ws.companyName}</div>
                  <div className="text-[11px] text-muted">{ws.roleLabel || "Equipo"}</div>
                </div>
              </div>
              <UserButton />
            </div>
          </header>

          {digest && digest.enabled && digest.cxc + digest.cxp > 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-warn/10 px-4 py-2 text-[13px]">
              <p>
                Alertas: {digest.cxc} por cobrar · {digest.cxp} por pagar
                <Link to="/vencimientos" className="ml-2 font-medium text-accent hover:underline">
                  Ver tabla
                </Link>
              </p>
              {digest.mailto || digest.resendReady ? (
                <button
                  type="button"
                  className="erp-btn h-8 text-[12px]"
                  onClick={async () => {
                    const { sendDueAlerts } = await import("@/lib/erp/alerts");
                    const res = await sendDueAlerts();
                    if (res.sent === "mailto" && res.mailto) window.location.href = res.mailto;
                    else if (res.notice) window.alert(res.notice);
                  }}
                >
                  Enviar correo
                </button>
              ) : (
                <Link to="/settings" className="text-[12px] font-medium text-accent">
                  Configurar correo
                </Link>
              )}
            </div>
          ) : null}

          {section.tabs?.length ? (
            <div
              className={cn(
                "flex h-11 items-center gap-1 overflow-x-auto px-3",
                tone === "buyer" && "bg-tab text-tab-fg",
                tone === "seller" && "bg-seller text-seller-fg",
                tone === "light" && "border-b border-line bg-cream",
              )}
            >
              {section.tabs.map((t) => {
                const tabVal = t.tab || "all";
                const isActive = currentTab === tabVal;
                return (
                  <button
                    key={t.label}
                    type="button"
                    onClick={() => {
                      if (t.href) {
                        void navigate({ to: t.href as "/sales/nuevo" });
                        return;
                      }
                      void navigate({
                        to: section.to as "/",
                        search: { ...(section.search ?? {}), tab: tabVal } as never,
                      });
                    }}
                    className={cn(
                      "relative h-11 shrink-0 px-3 text-sm font-medium",
                      tone === "light"
                        ? isActive
                          ? "text-accent"
                          : "text-muted hover:text-ink"
                        : isActive
                          ? "text-white"
                          : "text-white/70 hover:text-white",
                    )}
                  >
                    {t.label}
                    {isActive ? (
                      <span className={cn("absolute inset-x-2 bottom-0 h-0.5 rounded-full", tone === "light" ? "bg-accent" : "bg-white")} />
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : null}

          {open ? (
            <div className="fixed inset-0 z-40 bg-ink/40 lg:hidden" onClick={() => setOpen(false)}>
              <div className="absolute left-0 top-0 flex h-full w-72 flex-col bg-cream p-4 shadow-lg" onClick={(e) => e.stopPropagation()}>
                <div className="mb-4 flex items-center gap-2">
                  <LogoMark className="h-9" />
                </div>
                <nav className="flex flex-col gap-1 overflow-y-auto">{renderFolders(() => setOpen(false))}</nav>
              </div>
            </div>
          ) : null}

          {find ? (
            <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/40 p-4 pt-[12vh]" onClick={() => setFind(false)}>
              <div className="w-full max-w-lg rounded-lg border border-line bg-cream p-3 shadow-xl" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center gap-2 border-b border-line px-2 pb-2">
                  <Search className="size-4 text-muted" />
                  <input autoFocus className="h-10 flex-1 bg-transparent text-sm outline-none" placeholder="Buscar pedidos, clientes, productos…" />
                </div>
                <p className="px-2 py-3 text-xs text-muted">Salta a un módulo desde el menú, o abre un pedido desde su lista.</p>
              </div>
            </div>
          ) : null}

          <main className={cn("min-w-0 flex-1 bg-paper", bleed || flush ? "flex flex-col overflow-hidden" : "px-5 py-5 md:px-8")}>
            {blocked ? (
              <div className="erp-card m-5 p-6">
                <h1 className="text-lg font-semibold">Sin permiso</h1>
                <p className="mt-1 text-sm text-muted">Tu rol no incluye este módulo. Pide al administrador que te dé acceso.</p>
              </div>
            ) : (
              children
            )}
          </main>
          <Suspense fallback={null}>
            <DocPreviewHost />
          </Suspense>
        </div>
      </div>
    </AccessProvider>
  );
}

function MenuList({
  items,
  onClose,
  className,
}: {
  items: { to: string; label: string; search?: Record<string, string> }[];
  onClose: () => void;
  className?: string;
}) {
  return (
    <>
      <button type="button" className="fixed inset-0 z-40 cursor-default" aria-label="Cerrar" onClick={onClose} />
      <div className={cn("absolute top-10 z-50 min-w-48 rounded-md border border-line bg-cream py-1 shadow-lg", className)}>
        {items.map((it) => (
          <Link
            key={it.to + it.label}
            to={it.to as "/"}
            search={(it.search ?? {}) as never}
            onClick={onClose}
            className="flex min-h-10 items-center px-3 text-sm hover:bg-paper"
          >
            {it.label}
          </Link>
        ))}
      </div>
    </>
  );
}

function Onboard({ state, onDone }: { state: AccessPayload; onDone: () => void }) {
  const [name, setName] = useState("Azagro");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await createCompany({ data: { name } });
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo crear");
    } finally {
      setBusy(false);
    }
  }

  async function request() {
    setBusy(true);
    setError(null);
    try {
      await requestAccess();
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo enviar");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-paper px-4">
      <div className="w-full max-w-md erp-card p-7">
        <LogoLockup height="h-14" />
        {state.status === "pending" ? (
          <>
            <h1 className="mt-2 text-xl font-semibold">Cuenta lista</h1>
            <p className="mt-2 text-sm text-muted">Un administrador te asigna rol y módulos. Cuando lo haga, entra de nuevo.</p>
            <button type="button" className="erp-btn mt-5 w-full" onClick={() => void onDone()}>
              Ya me asignaron
            </button>
          </>
        ) : state.canCreate ? (
          <>
            <h1 className="mt-2 text-xl font-semibold">Primera configuración</h1>
            <p className="mt-1 text-sm text-muted">Quedas como administrador. El resto crea su cuenta y tú les das acceso.</p>
            <label className="mt-5 grid gap-1 text-sm font-medium">
              Empresa
              <input className="erp-input" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <button type="button" disabled={busy} onClick={() => void create()} className="erp-btn-primary mt-3 w-full">
              Crear empresa
            </button>
          </>
        ) : (
          <>
            <h1 className="mt-2 text-xl font-semibold">Solicitar acceso</h1>
            <p className="mt-1 text-sm text-muted">El administrador te asignará rol y qué puedes ver o editar.</p>
            <button type="button" disabled={busy} onClick={() => void request()} className="erp-btn-primary mt-5 w-full">
              Pedir acceso
            </button>
          </>
        )}
        {error && <p className="mt-3 text-sm text-danger">{error}</p>}
        <div className="mt-4 text-center">
          <SignOutButton />
        </div>
      </div>
    </main>
  );
}

