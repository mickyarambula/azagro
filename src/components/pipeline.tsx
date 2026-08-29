import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

const STEPS = [
  { id: "solicitud", label: "Solicitud", to: "/solicitudes" },
  { id: "compra", label: "Proveedores", to: "/rfq" },
  { id: "cotizar", label: "Cotizar", to: "/quotes" },
  { id: "pedido", label: "Pedido", to: "/sales" },
  { id: "surtir", label: "Surtir", to: "/sales" },
  { id: "cobrar", label: "Cobrar", to: "/credit" },
] as const;

export function OpsPipeline({ current }: { current: (typeof STEPS)[number]["id"] }) {
  return (
    <ol className="mb-5 flex flex-wrap gap-1 text-[11px]">
      {STEPS.map((s, i) => {
        const on = s.id === current;
        return (
          <li key={s.id} className="flex items-center gap-1">
            <Link
              to={s.to as "/"}
              className={cn(
                "rounded-full px-2.5 py-1 font-semibold",
                on ? "bg-brand text-white" : "bg-paper-2 text-muted hover:text-ink",
              )}
            >
              {i + 1}. {s.label}
            </Link>
            {i < STEPS.length - 1 ? <span className="text-muted">→</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
