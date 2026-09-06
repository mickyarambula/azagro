import { CIRCUIT_CODES, CIRCUIT_LABEL, circuitLabel, isSelectableCircuit, SELECTABLE_CIRCUITS, type CircuitCode } from "@/lib/erp/circuits";

/**
 * Selector de circuito de financiamiento (paso 2, 5-sep-2026). El sistema
 * PROPONE (el `value` que recibe ya viene calculado con la regla del plazo);
 * la persona confirma o cambia — nunca decide solo, y nunca fuerza a elegir
 * (siempre hay un valor, propuesto). Solo Contado y Circuito ASR se pueden
 * elegir; Línea Santa Rosa y Línea propia salen apagadas, "por construir".
 *
 * `editable` ya trae adentro las dos condiciones de la decisión del dueño:
 * solo ADMINISTRADOR, y solo mientras el documento no tenga candado — quien
 * llama decide eso, este componente solo pinta según lo que le dan.
 */
export function CircuitSelect({
  value,
  onChange,
  editable,
  disabled,
}: {
  value: CircuitCode;
  /** Solo dispara con un código elegible: Línea Santa Rosa y Línea propia no se pueden elegir todavía. */
  onChange: (code: "CONTADO" | "ASR") => void;
  editable: boolean;
  disabled?: boolean;
}) {
  if (!editable) {
    return <p className="text-sm">{circuitLabel(value)}</p>;
  }
  return (
    <select
      className="erp-input w-full border-0 bg-transparent px-0"
      disabled={disabled}
      value={value}
      onChange={(e) => {
        if (isSelectableCircuit(e.target.value)) onChange(e.target.value);
      }}
    >
      {CIRCUIT_CODES.map((code) => (
        <option key={code} value={code} disabled={!SELECTABLE_CIRCUITS.includes(code)}>
          {CIRCUIT_LABEL[code]}
          {SELECTABLE_CIRCUITS.includes(code) ? "" : " (por construir)"}
        </option>
      ))}
    </select>
  );
}
