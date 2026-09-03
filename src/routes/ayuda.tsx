import { createFileRoute, Link } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { FlujoAzagro } from "@/components/flujo";

export const Route = createFileRoute("/ayuda")({ component: Page });

function Page() {
  return (
    <AppShell>
      <h1 className="text-xl font-semibold">Cómo se trabaja Azagro</h1>
      <p className="mt-1 text-sm text-muted">
        El pedido es el centro. Lo demás (OC, inventario, factura, cobro, pago al proveedor, mora) es consecuencia.
        En cada ficha ves el <strong>expediente</strong>: SOL → SC → COT → PV → OC → FV. Clic para saltar. La compra de inventario se queda en SC → OC (no se amarra a una venta).
      </p>
      <div className="mt-4">
        <FlujoAzagro />
      </div>

      <ol className="mt-6 space-y-5 text-sm">
        <Step n="1" title="Solicitud del cliente" to="/solicitudes">
          Pedidos → Solicitudes → Nueva solicitud. Producto, cantidad, UoM y destino. Destinos: Almacén → Destinos, ficha del cliente, o «+ Nuevo destino» en la solicitud. Al vender o comprar, el producto y el destino se ligan solos al cliente o proveedor (ficha → Productos vinculados). Si te equivocas: ábrela, Corregir o Borrar (mientras no tenga cotización). La flecha de volver está en la barra de arriba en todo el ERP.
        </Step>
        <Step n="2" title="Pedir precio a proveedores" to="/rfq">
          Si hay solicitud de cliente: desde ahí se manda RFQ (correo / WhatsApp). El cliente no aparece. En la comparativa escribes el precio debajo de cada proveedor y marcas ganador.
          Si nomas quieres inventariar: Pedidos → Cotizar proveedores → Pedir para inventario. Producto, cantidad, bodega y a quién cotizas. Al elegir ganador se emite la OC; Recibir la mete al kardex.
        </Step>
        <Step n="3" title="Cotizar al cliente" to="/quotes">
          Cotización formal Azagro. Se puede mandar precio de contado, a crédito, o ambos. En la ficha ves tu costo y margen (el cliente no). Si pide otro número, se renegocia (Rev. 2) sin abrir otra. Documento / Enviar. Registrar si aceptó de contado, a crédito, parcial o rechazó: se abre el pedido.
        </Step>
        <Step n="4" title="Pedido de venta" to="/sales">
          Al aceptar se abre PV-xxxx. Confirmar (plazo en días exactos, política de mora, bodega). Si hay ganador, se emiten OC al proveedor (internas).
        </Step>
        <Step n="5" title="Comprar / surtir" to="/purchases">
          OC inventario: Recibir en bodega Azagro o del productor — entra al kardex y el costo promedio de esa bodega se recalcula. Cada partida dice dónde entregar (pueden ser varias). OC directa: no se recibe, va en camino. Guía de carga: folio, fecha, cliente, origen, destino, producto, cantidad, línea fletera, chofer, marca, placas. Recibe se firma en pantalla. Entregar descuenta del kardex y factura. Luego Marcar recibido.
        </Step>
        <Step n="6" title="Cobrar al cliente" to="/credit">
          Finanzas → Por cobrar. Elige la factura, Cobro, cuenta de banco e importe. El dinero entra a esa cuenta y baja el saldo del cliente.
        </Step>
        <Step n="7" title="Pagar al proveedor" to="/credit">
          Finanzas → Por pagar. Solo si hay saldo en el banco. Si no, primero cobra o pon saldo inicial en Bancos.
        </Step>
        <Step n="8" title="Devolución del cliente" to="/sales">
          Pedido ya entregado → Devolución. Cantidad por partida y motivo. Entra al kardex (DEV) en la misma bodega y se emite NC. Si la FV sigue abierta, se abona sola. Si ya estaba pagada, queda crédito para el siguiente cobro. Pedido directo: no hay movimiento de bodega Azagro, solo la nota.
        </Step>
      </ol>

      <h2 className="mt-8 text-base font-semibold">Correos: Azagro vs Plein Produce</h2>
      <ol className="mt-3 max-w-2xl space-y-2 text-sm text-muted">
        <li><strong>1.</strong> Ajustes → Correo de Azagro → Guardar.</li>
        <li><strong>2.</strong> Outlook → Configuración → Cuentas → agregar el correo de Azagro (el de Plein se queda).</li>
        <li><strong>3.</strong> En el ERP, Enviar → en Outlook cambia <em>De:</em> a Azagro → Enviar.</li>
      </ol>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        “Resend / API” es un cartero automático opcional. Hoy no se configura. No lo mezcles con Plein Produce.
      </p>
      <ul className="mt-2 space-y-2 text-sm">
        <li><strong>Cuánto me deben y cuándo vence:</strong> Finanzas → <em>Por cobrar</em> y <em>Vencimientos</em>.</li>
        <li><strong>Cuánto debo y cuándo pago:</strong> Finanzas → <em>Por pagar</em> (FP de las OC). Registrar pago ahí.</li>
        <li><strong>Estado de cuenta para revisar y mandar:</strong> Finanzas → Estados de cuenta. No es el export crudo de Compaq (código, serie, folio, cargo, abono, saldo). Azagro le agrega lo del Excel de trabajo: plazo, fecha de pago, días vence, días vencidos, interés s/ días, comisión + FEGA (lo que diga Ajustes) y total. MXN y USD en bloques aparte; si filtras un grupo, sale el consolidado. Interés = Cargo × (TIIE del vencimiento, de la tabla + spread de Ajustes) × días / 360 (con signo: negativo = pronto pago). Toca la cifra para ver el desglose. Documento / Enviar cuando ya cuadra. Los saldos pagados de 2024–2026 no se pegan; el saldo abierto entra después por Importar.</li>
        <li><strong>Cuánto debo y cuándo pago:</strong> Facturas (Proveedor) y Cadena de crédito (columna derecha).</li>
        <li><strong>Alertas de vencimiento:</strong> en Cartera (pastilla roja), Cadena, Inicio (facturas vencidas). No hay correo automático todavía: hay que entrar al tablero.</li>
        <li><strong>P&L de un pedido:</strong> dentro del PV, abajo. Utilidad para el periodo.</li>
        <li><strong>Inventario:</strong> Almacén. Propio / en proveedor / tránsito. Por recibir y reservado.</li>
        <li><strong>Corte Compaq:</strong> Ajustes → Importar / corte. Catálogos, luego CSV de saldos abiertos y existencias. Subirlo otra vez no duplica. Respaldo JSON ahí mismo. Bitácora: quién recibió, entregó, cobró.</li>
        <li><strong>Bancos:</strong> movimientos y conciliación contra facturas.</li>
      </ul>

      <h2 className="mt-8 text-base font-semibold">Tu prueba PV-0001</h2>
      <p className="mt-2 text-sm text-muted">
        Solicitud → cotización a SL Agrícola en USD al TC de la tabla (o el pactado) → aceptó → PV-0001 crédito 60 d exactos (vence 22/oct/2026), política Grupo SL, entrega proveedor, guía Juan Ramon / VRG-2435.
        OC-0001 Greenhow y OC-0002 Tepeyac en directo (bien: no se reciben). Entregado y recibido. FV-0001 abierta por USD 143,062.47.
        Margen ~7% con flete $3,000 y costo de OC. Eso está bien armado.
      </p>
      <p className="mt-2 text-sm text-muted">
        Siguiente en esa operación: Finanzas → Facturas → Cliente → SL Agrícola → registrar cobro cuando paguen.
        Finanzas → Facturas → Proveedor → FP de OC-0001 y OC-0002 → pagar según su vencimiento.
        Estado de cuenta: filtrar SL Agrícola (ahora solo salen los que tienen saldo).
      </p>
    </AppShell>
  );
}

function Step({ n, title, to, children }: { n: string; title: string; to: string; children: React.ReactNode }) {
  return (
    <li className="erp-card p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Paso {n}</p>
      <p className="mt-0.5 font-semibold">
        <Link to={to as "/"} className="hover:underline">{title}</Link>
      </p>
      <p className="mt-1 text-muted">{children}</p>
    </li>
  );
}
