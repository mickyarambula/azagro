import { Link } from "@tanstack/react-router";

function Node({ to, search, children }: { to: string; search?: Record<string, string>; children: string }) {
  return (
    <Link
      to={to as "/"}
      search={search as never}
      className="shrink-0 rounded-md border border-line bg-cream px-2.5 py-1.5 text-[12px] font-semibold text-ink hover:border-accent/50 hover:text-brand"
    >
      {children}
    </Link>
  );
}

function Arrow() {
  return <span className="shrink-0 text-muted">→</span>;
}

function Lane({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</p>
      <p className="text-[11px] text-muted">{hint}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

export function FlujoAzagro({ compact }: { compact?: boolean }) {
  return (
    <div className="erp-card p-4">
      <p className="text-sm font-semibold">Cómo fluye una operación</p>
      {!compact && (
        <p className="mt-0.5 text-[12px] text-muted">
          El expediente es este hilo. Clic para entrar. La existencia se mueve solo en Recibir / Entregar / Devolver.
        </p>
      )}
      <Lane title="Venta al cliente" hint="SOL es la columna. Kardex entra al recibir la OC y sale al entregar el PV.">
        <Node to="/solicitudes">1. Solicitud</Node>
        <Arrow />
        <Node to="/rfq">2. Cotizar proveedor</Node>
        <Arrow />
        <Node to="/quotes">3. Cotizar cliente</Node>
        <Arrow />
        <Node to="/sales" search={{ tab: "todos", q: "" }}>
          4. Pedido PV
        </Node>
        <Arrow />
        <Node to="/purchases" search={{ tab: "all" }}>
          5. OC y recibir
        </Node>
        <Arrow />
        <Node to="/sales" search={{ tab: "todos", q: "" }}>
          6. Entregar
        </Node>
        <Arrow />
        <Node to="/credit" search={{ lado: "cobrar" }}>
          7. FV y cobro
        </Node>
      </Lane>
      <Lane title="Reponer bodega" hint="Sin cliente. El stock queda en el charco; no se amarra a una venta futura.">
        <Node to="/rfq/nuevo">Pedir para inventario</Node>
        <Arrow />
        <Node to="/purchases" search={{ tab: "all" }}>
          OC
        </Node>
        <Arrow />
        <Node to="/inventory">Recibir → kardex</Node>
      </Lane>
      <Lane title="Devolución del cliente" hint="Solo pedido ya entregado. Entra otra vez al kardex y baja el saldo con nota de crédito.">
        <Node to="/sales" search={{ tab: "done", q: "" }}>
          Pedido entregado
        </Node>
        <Arrow />
        <span className="shrink-0 rounded-md border border-line bg-paper-2 px-2.5 py-1.5 text-[12px] font-semibold">Devolver</span>
        <Arrow />
        <Node to="/inventory">DEV al kardex</Node>
        <Arrow />
        <Node to="/credit" search={{ lado: "cobrar" }}>
          NC
        </Node>
      </Lane>
    </div>
  );
}
