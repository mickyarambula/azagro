import { cn } from "@/lib/utils";

/** Marca AZ (rail, favicon visual). Fondo ya es transparente. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <img
      src="/brand/azagro-mark.png"
      alt="Azagro"
      className={cn("h-8 w-auto object-contain", className)}
      draggable={false}
    />
  );
}

/** Lockup completo: AZ + AZ AGRO + Insumos agrícolas. Cambia en oscuro. */
export function LogoLockup({ className, height = "h-14" }: { className?: string; height?: string }) {
  return (
    <span className={cn("relative inline-flex items-center", className)}>
      <img
        src="/brand/azagro-logo.png"
        alt="Azagro · Insumos agrícolas"
        className={cn("logo-light w-auto object-contain", height)}
        draggable={false}
      />
      <img
        src="/brand/azagro-logo-dark.png"
        alt=""
        className={cn("logo-dark w-auto object-contain", height)}
        draggable={false}
      />
    </span>
  );
}
