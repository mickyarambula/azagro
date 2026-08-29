import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/partners/")({
  component: Empty,
});

function Empty() {
  return (
    <div className="grid h-full min-h-[360px] place-items-center">
      <div className="text-center">
        <p className="text-[15px] font-semibold">Selecciona un contacto</p>
        <p className="mt-1 max-w-sm text-sm text-muted">
          La lista a la izquierda es el directorio. La ficha se edita aquí, con personas, plazo sugerido y crédito.
        </p>
      </div>
    </div>
  );
}
