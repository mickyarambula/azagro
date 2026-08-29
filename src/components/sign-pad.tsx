import { useEffect, useRef, type PointerEvent } from "react";

/** Firma a mano alzada (tablet / mouse). Se guarda como imagen en el documento. */
export function SignPad({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (dataUrl: string) => void;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);

  function ctx() {
    const c = ref.current;
    if (!c) return null;
    const g = c.getContext("2d");
    if (!g) return null;
    g.lineWidth = 2.4;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.strokeStyle = "#14201c";
    return g;
  }

  useEffect(() => {
    const c = ref.current;
    const g = ctx();
    if (!c || !g) return;
    g.clearRect(0, 0, c.width, c.height);
    if (!value) return;
    const img = new Image();
    img.onload = () => g.drawImage(img, 0, 0, c.width, c.height);
    img.src = value;
  }, [value]);

  function pt(e: PointerEvent<HTMLCanvasElement>) {
    const c = ref.current!;
    const r = c.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * c.width,
      y: ((e.clientY - r.top) / r.height) * c.height,
    };
  }

  function commit() {
    const c = ref.current;
    if (!c) return;
    onChange(c.toDataURL("image/png"));
  }

  return (
    <div>
      <canvas
        ref={ref}
        width={640}
        height={180}
        className="w-full touch-none rounded-md border border-line bg-white"
        style={{ height: 132 }}
        onPointerDown={(e) => {
          if (disabled) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drawing.current = true;
          const g = ctx();
          const p = pt(e);
          g?.beginPath();
          g?.moveTo(p.x, p.y);
        }}
        onPointerMove={(e) => {
          if (!drawing.current || disabled) return;
          const g = ctx();
          const p = pt(e);
          g?.lineTo(p.x, p.y);
          g?.stroke();
        }}
        onPointerUp={() => {
          if (!drawing.current) return;
          drawing.current = false;
          commit();
        }}
        onPointerCancel={() => {
          drawing.current = false;
        }}
      />
      <div className="mt-1 flex justify-end">
        <button
          type="button"
          className="erp-btn h-8 text-[12px]"
          disabled={disabled || !value}
          onClick={() => {
            const g = ctx();
            const c = ref.current;
            if (g && c) g.clearRect(0, 0, c.width, c.height);
            onChange("");
          }}
        >
          Borrar firma
        </button>
      </div>
    </div>
  );
}
