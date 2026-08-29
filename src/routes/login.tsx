import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { LogoLockup } from "@/components/brand";
import { GROK_PROVIDERS, authClient, authEnabled, captureSessionToken, signIn } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

export const Route = createFileRoute("/login")({ component: Login });

function Login() {
  const { user } = useCurrentUserState();
  const nav = useNavigate();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (user) {
    void nav({ to: "/" });
    return null;
  }

  async function onEmail(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "up") {
        const res = await authClient.signUp.email({
          email,
          password,
          name: name || email.split("@")[0],
          callbackURL: "/",
        });
        if (res.error) throw new Error(res.error.message || "No se pudo crear la cuenta");
        captureSessionToken((res.data as { token?: string } | null)?.token);
      } else {
        const res = await authClient.signIn.email({ email, password, callbackURL: "/" });
        if (res.error) throw new Error(res.error.message || "Correo o contraseña incorrectos");
        captureSessionToken((res.data as { token?: string } | null)?.token);
      }
      await nav({ to: "/" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error de acceso");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-paper px-4">
      <div className="w-full max-w-[420px]">
        <div className="mb-8 flex justify-center">
          <LogoLockup height="h-16" />
        </div>
        <section className="erp-card p-7">
          <h1 className="text-xl font-semibold">{mode === "in" ? "Iniciar sesión" : "Crear cuenta"}</h1>
          <p className="mt-1 text-[13px] text-muted">
            Tu usuario. El administrador te asigna rol y módulos.
          </p>

          {authEnabled ? (
            <div className="mt-5 grid gap-2">
              {GROK_PROVIDERS.map((p) => (
                <button key={p.providerId} type="button" onClick={() => signIn(p.providerId, { callbackURL: "/" })} className="erp-btn w-full">
                  Continuar con {p.label}
                </button>
              ))}
            </div>
          ) : (
            <p className="mt-4 text-sm text-muted">El acceso está desactivado.</p>
          )}

          <div className="my-5 flex items-center gap-3 text-[11px] uppercase tracking-[0.14em] text-muted">
            <span className="h-px flex-1 bg-line" />
            correo
            <span className="h-px flex-1 bg-line" />
          </div>

          <form className="grid gap-3" onSubmit={onEmail}>
            {mode === "up" && (
              <label className="grid gap-1 text-[13px] font-medium">
                Nombre
                <input className="erp-input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
              </label>
            )}
            <label className="grid gap-1 text-[13px] font-medium">
              Correo
              <input type="email" required className="erp-input" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
            </label>
            <label className="grid gap-1 text-[13px] font-medium">
              Contraseña
              <div className="relative">
                <input
                  type={showPw ? "text" : "password"}
                  required
                  minLength={8}
                  className="erp-input w-full pr-16"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={mode === "up" ? "new-password" : "current-password"}
                />
                <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-[12px] text-muted" onClick={() => setShowPw((v) => !v)}>
                  {showPw ? "Ocultar" : "Ver"}
                </button>
              </div>
            </label>
            {error && <p className="text-sm text-danger">{error}</p>}
            <button type="submit" disabled={busy || !authEnabled} className="erp-btn-primary mt-1">
              {busy ? "Entrando…" : mode === "in" ? "Entrar" : "Crear cuenta"}
            </button>
          </form>

          <p className="mt-4 text-center text-[13px] text-muted">
            {mode === "in" ? "¿Eres nuevo?" : "¿Ya tienes cuenta?"}{" "}
            <button
              type="button"
              className="font-semibold text-accent"
              onClick={() => {
                setMode(mode === "in" ? "up" : "in");
                setError(null);
              }}
            >
              {mode === "in" ? "Crear cuenta" : "Iniciar sesión"}
            </button>
          </p>
        </section>
      </div>
    </main>
  );
}
