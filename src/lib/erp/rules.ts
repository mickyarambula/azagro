/**
 * Fuente única de las reglas de negocio Azagro (texto). El motor y la pantalla
 * de Ajustes leen esto.
 *
 * Aquí NO hay tasas, plazos ni umbrales: todo número de negocio (TIIE, spread,
 * comisión, FEGA, plazos, umbral de pronto pago, tipo de cambio) vive en
 * Ajustes o en su tabla. Lo único fijo es la convención del año comercial.
 */

/** Año comercial: el factor de interés es días exactos / 360. Convención, no parámetro. */
export const YEAR_DAYS = 360;

export const BUSINESS_RULES = [
  {
    id: "days",
    title: "Días exactos",
    body: "Los plazos se cuentan en días calendario, no en meses de 30. Si el crédito es 60 días y la venta es el 22-ago, vence el 21-oct. La mora corre desde el día siguiente al vencimiento hasta el día en que pagan, inclusive.",
  },
  {
    id: "interest",
    title: "Año comercial 360",
    body: "El conteo de días es exacto; el factor de interés es días/360 (uso comercial mexicano). Aplica igual al costo de línea en el precio y a la mora.",
  },
  {
    id: "finance",
    title: "Financiamiento dentro del precio",
    body: "Si hay días de crédito, el precio incluye por unidad: costo × comisión ASR (Ajustes, una sola vez) + costo × (1 + comisión ASR) × (TIIE de la tabla vigente al cotizar + spread ASR de Ajustes) × días / 360. La línea adelanta costo + comisión, por eso el (1 + comisión). De contado es $0, comisión incluida. Eso no es mora.",
  },
  {
    id: "mora",
    title: "Mora aparte",
    body: "TIIE de la tabla en la fecha del plazo financiero + spread de cobro (Ajustes) sobre el cargo, × días exactos / 360 (puede ser negativo si pagaron antes: pronto pago). Comisión + FEGA (Ajustes) una sola vez sobre el cargo. En el estado de cuenta se ven las tres columnas del Excel. La factura FI solo sale si ya venció y hay TIIE en la tabla para esa fecha; no se suma al precio ni a la factura del producto.",
  },
  {
    id: "ec",
    title: "Estado de cuenta",
    body: "Compaq solo lanza código, serie, folio, fechas, cargo, abono, saldo y utilidad cambiaria. El papel de Azagro le agrega lo del Excel de trabajo: plazo, fecha de pago, días vence, días vencidos, interés s/ días, comisión + FEGA y total. MXN y USD aparte, y consolidado por grupo. No se pegan saldos pagados de años anteriores: eso entra por Importar cuando haya saldo abierto.",
  },
  {
    id: "oc",
    title: "Orden de compra",
    body: "Se emite cuando la decisión de comprar ya es definitiva: el cliente aceptó y hay proveedor ganador, o Azagro compra para inventario. Es el documento que formaliza con el proveedor. Lleva sus días de crédito, exactos.",
  },
  {
    id: "receive",
    title: "Recibir mercancía",
    body: "Solo en operación de inventario. Puede recibirse en bodega Azagro o en bodega del productor/proveedor: el stock es de Azagro, la ubicación física es externa. En brokeraje / directo no hay recepción: va en camino al cliente.",
  },
  {
    id: "stock",
    title: "Stock propio vs bodega externa",
    body: "Tres relojes: bodega Azagro, bodega de proveedor (nuestro inventario en su sitio) y tránsito. No se mezclan para saber qué se puede surtir hoy desde casa. Un punto de entrega del cliente no es bodega.",
  },
  {
    id: "privacy",
    title: "Pared de privacidad",
    body: "El cliente no ve al proveedor. El proveedor no ve al cliente. Azagro vende y compra.",
  },
  {
    id: "fx",
    title: "Tipo de cambio",
    body: "El dólar pactado solo aplica en USD y se propone del renglón más reciente de la tabla de tipo de cambio (Ajustes), mostrando de qué fecha es; sin tabla no se guarda un documento en dólares. En MXN no hay TC. En el estado de cuenta, la columna Ut. cambiaria es Importe USD × (TC pactado − TC pagado).",
  },
  {
    id: "buy",
    title: "Compra propia",
    body: "Sin cliente de por medio: Pedido de compra. La solicitud/cotización es para cuando hay un cliente.",
  },
] as const;
