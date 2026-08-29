import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function money(n: number | string | null | undefined) {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  return new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency: "MXN",
    maximumFractionDigits: 2,
  }).format(Number.isFinite(v) ? v : 0);
}

export function qty(n: number | string | null | undefined, digits = 2) {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  return new Intl.NumberFormat("es-MX", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(Number.isFinite(v) ? v : 0);
}

export function num(n: number | string | null | undefined) {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  return Number.isFinite(v) ? v : 0;
}

export function moneyIn(n: number | string | null | undefined, currency: string = "MXN") {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  return new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency: currency === "USD" ? "USD" : "MXN",
    maximumFractionDigits: 2,
  }).format(Number.isFinite(v) ? v : 0);
}

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/** Fecha como en los papeles de Azagro: 10/03/26 */
export function dateDMY(iso: string | null | undefined) {
  if (!iso) return "—";
  const p = String(iso).slice(0, 10).split("-");
  if (p.length !== 3) return String(iso);
  return `${p[2]}/${p[1]}/${p[0].slice(2)}`;
}

export function fmtDate(iso: string | null | undefined) {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}

/** Mensaje usable. Esconde basura técnica (ssr/cookies) al operador. */
export function humanError(err: unknown) {
  const raw = err instanceof Error ? err.message : String(err ?? "Error");
  if (/setCookie|ssr_exports|intermediate value/i.test(raw)) {
    return "No se pudo guardar. Recarga la página e inténtalo otra vez. Si el cliente ya había aceptado, el pedido puede estar en Pedidos de venta.";
  }
  if (raw === "Unauthorized" || /unauthorized/i.test(raw)) {
    return "La sesión caducó. Vuelve a entrar.";
  }
  if (/cross-site|Forbidden/i.test(raw)) {
    return "No se pudo verificar la sesión. Recarga la página.";
  }
  return raw || "Error";
}
