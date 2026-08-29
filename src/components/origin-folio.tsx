import { Link } from "@tanstack/react-router";

export function OriginFolio({ origin }: { origin: string }) {
  const t = (origin || "").trim();
  if (!t || t === "Traslado" || t === "Saldo inicial") return t ? <span>{t}</span> : null;
  const cls = "font-medium text-accent hover:underline";
  if (/^OC-/i.test(t)) {
    return (
      <Link to="/purchases" search={{ tab: "all" }} className={cls}>
        {t}
      </Link>
    );
  }
  if (/^PV-/i.test(t)) {
    return (
      <Link to="/sales" search={{ tab: "todos", q: t }} className={cls}>
        {t}
      </Link>
    );
  }
  if (/^SC-/i.test(t)) {
    return (
      <Link to="/rfq" className={cls}>
        {t}
      </Link>
    );
  }
  if (/^SOL-/i.test(t)) {
    return (
      <Link to="/solicitudes" className={cls}>
        {t}
      </Link>
    );
  }
  if (/^COT-/i.test(t)) {
    return (
      <Link to="/quotes" className={cls}>
        {t}
      </Link>
    );
  }
  if (/^FP-/i.test(t)) {
    return (
      <Link to="/credit" search={{ lado: "pagar" }} className={cls}>
        {t}
      </Link>
    );
  }
  if (/^FV-|^NC-/i.test(t)) {
    return (
      <Link to="/credit" search={{ lado: "cobrar" }} className={cls}>
        {t}
      </Link>
    );
  }
  return <span>{t}</span>;
}
