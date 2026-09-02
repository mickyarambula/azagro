import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { formatDealLine, getDealTrail, type DealHop, type DealKind } from "@/lib/erp/deal";
import { cn } from "@/lib/utils";

function HopLink({ hop, current }: { hop: DealHop; current: boolean }) {
  const cls = cn(
    "rounded-full px-2.5 py-0.5 font-semibold",
    current ? "bg-brand text-white" : "bg-paper-2 text-ink hover:text-brand",
  );
  if (current) return <span className={cls}>{hop.name}</span>;
  if (hop.kind === "request") {
    return (
      <Link to="/solicitudes/$solicitudId" params={{ solicitudId: String(hop.id) }} className={cls}>
        {hop.name}
      </Link>
    );
  }
  if (hop.kind === "rfq") {
    return (
      <Link to="/rfq/$rfqId" params={{ rfqId: String(hop.id) }} className={cls}>
        {hop.name}
      </Link>
    );
  }
  if (hop.kind === "quote") {
    return (
      <Link to="/quotes" search={{ ver: hop.id }} className={cls}>
        {hop.name}
      </Link>
    );
  }
  if (hop.kind === "sale") {
    return (
      <Link to="/sales/$orderId" params={{ orderId: String(hop.id) }} className={cls}>
        {hop.name}
      </Link>
    );
  }
  if (hop.kind === "purchase") {
    return (
      <Link to="/purchases" search={{ tab: "all" }} className={cls}>
        {hop.name}
      </Link>
    );
  }
  return (
    <Link to="/credit" search={{ lado: hop.side === "supplier" ? "pagar" : "cobrar" }} className={cls}>
      {hop.name}
    </Link>
  );
}

export function Expediente({
  kind,
  id,
  onLine,
}: {
  kind: DealKind;
  id: number;
  onLine?: (line: string) => void;
}) {
  const [hops, setHops] = useState<DealHop[]>([]);
  useEffect(() => {
    if (!id) return;
    void getDealTrail({ data: { kind, id } })
      .then((d) => {
        setHops(d.hops);
        onLine?.(d.line);
      })
      .catch(() => setHops([]));
  }, [kind, id]);

  if (hops.length < 1) return null;
  const groups: DealKind[] = ["request", "rfq", "quote", "sale", "purchase", "invoice"];
  const shown = groups.map((g) => hops.filter((h) => h.kind === g)).filter((g) => g.length);

  return (
    <nav className="mb-4 flex flex-wrap items-center gap-x-1 gap-y-1 text-[12px]" aria-label="Expediente">
      <span className="mr-1 font-medium uppercase tracking-wide text-muted">Expediente</span>
      {shown.map((group, gi) => (
        <span key={group[0]!.kind} className="flex flex-wrap items-center gap-1">
          {gi > 0 ? <span className="px-0.5 text-muted">→</span> : null}
          {group.map((hop, i) => (
            <span key={`${hop.kind}-${hop.id}`} className="flex items-center gap-1">
              {i > 0 ? <span className="text-muted">·</span> : null}
              <HopLink hop={hop} current={hop.kind === kind && hop.id === id} />
            </span>
          ))}
        </span>
      ))}
    </nav>
  );
}

export { formatDealLine };
