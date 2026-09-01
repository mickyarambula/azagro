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

/** Azagro opera en Sinaloa: UTC-7 todo el año, sin horario de verano. */
const AZAGRO_TZ = "America/Mazatlan";

/**
 * Fecha de operación de Azagro (YYYY-MM-DD en hora de Los Mochis).
 *
 * ÚNICO lugar del sistema donde se decide "qué día es hoy" para una fecha
 * de negocio: factura, vencimiento, pago, kardex, corte, vigencia. Nunca usar
 * `new Date().toISOString().slice(0, 10)` (eso es el día en UTC: desde las
 * 5:00 p.m. de Los Mochis ya marca mañana) ni `current_date` en SQL (depende
 * del timezone de la sesión de Postgres, que en Neon es UTC).
 *
 * Los sellos de tiempo de auditoría (created_at, bitácora) NO pasan por aquí:
 * siguen siendo instantes UTC y solo se convierten al mostrar (dateTimeMx).
 *
 * `now` es inyectable para pruebas; en producción se omite.
 */
export function todayMx(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: AZAGRO_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
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

/**
 * Fecha Y HORA tal como las vive Los Mochis — solo para MOSTRAR en pantalla
 * o papel. No toca cómo se guarda: la base sigue en UTC/timestamptz: esto
 * solo convierte al formatear. Espera un instante inequívoco (ISO con "Z" o
 * con offset explícito); si no lo trae, no se puede convertir con certeza y
 * se muestra tal cual llegó.
 */
export function dateTimeMx(iso: string | null | undefined) {
  if (!iso) return "—";
  const hasZone = /Z$|[+-]\d{2}:?\d{2}$/.test(iso.trim());
  if (!hasZone) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("es-MX", {
    timeZone: AZAGRO_TZ,
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}:${get("second")}`;
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
