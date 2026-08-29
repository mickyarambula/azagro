import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";

export const Route = createFileRoute("/sales")({
  validateSearch: (s: Record<string, unknown>): { tab?: string; q?: string } => ({
    tab: typeof s.tab === "string" ? s.tab : undefined,
    q: typeof s.q === "string" ? s.q : undefined,
  }),
  component: () => (
    <AppShell flush>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Outlet />
      </div>
    </AppShell>
  ),
});
