import type { ReactNode } from "react";
import { useAccess, type AccessState } from "@/lib/access";

/**
 * `useAccess()` solo tiene contexto DENTRO de `<AppShell>` (que lo provee).
 * Cuando la misma función que renderiza `<AppShell>` llama `useAccess()`
 * ANTES del `return`, ese hook corre fuera del árbol y siempre ve el valor
 * por omisión (`role: ""`, `can: () => false`) — el defecto de contexto de
 * los hallazgos #16 y #17 de la auditoría (17-sep-2026).
 *
 * Este componente se coloca donde ya se necesita el resultado, DENTRO de
 * `<AppShell>` en el JSX (mismo patrón que `InicioBody` en index.tsx y
 * `CloseShortPurchaseButton` en purchases.tsx, aquí como render-prop para
 * no reescribir toda la pantalla alrededor).
 */
export function AccessGate({ children }: { children: (access: AccessState) => ReactNode }) {
  return <>{children(useAccess())}</>;
}
