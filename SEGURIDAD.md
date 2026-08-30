# Auditoría de seguridad y permisos — Azagro ERP

Fecha: 30 de agosto de 2026. Solo diagnóstico; no se cambió nada de código.
Contexto: hoy opera un solo usuario (administrador). Esta auditoría evalúa si
los permisos aguantan cuando entre el equipo (almacén, ventas, contabilidad).

**Conclusión en una línea: NO des de alta al equipo todavía.** El sistema de
permisos existe y está bien diseñado (roles, módulos, niveles ver/editar),
pero las operaciones más delicadas — cobrar, pagar, recibir y entregar
mercancía, cambiar la tasa de interés — no lo consultan: solo revisan que el
usuario "sea de la empresa", sin importar su rol, e incluso sin importar si
está desactivado. Con un solo usuario esto no se nota; con empleados, es la
puerta abierta. La buena noticia: el arreglo es corto (uno o dos días de
trabajo) porque la pieza que valida permisos ya existe y ya se usa en la
mitad del sistema — solo falta conectarla en la otra mitad.

---

## Cómo funciona hoy (para entender los hallazgos)

Cada botón de la pantalla llama a una "función del servidor". Es importante
entender esto: **esconder un botón no protege nada**. Cualquier empleado con
sesión iniciada puede llamar a cualquier función del servidor directamente
desde su navegador (con conocimientos básicos o un tutorial de YouTube),
aunque el botón no le aparezca. La única protección real es que la función
misma, del lado del servidor, pregunte "¿este usuario tiene permiso?".

El sistema tiene esa pregunta implementada (se llama `assertCan`: revisa rol,
módulo y nivel, y además exige que el usuario esté activo). El problema es
que muchas funciones no la hacen: usan un chequeo más flojo que solo
pregunta "¿este usuario pertenece a la empresa?" — sin rol y sin revisar si
está activo o desactivado.

---

## Punto 1 — Función por función: ¿valida el rol en el servidor?

### SÍ validan rol (están bien protegidas)

| Operación | Permiso que exige |
|---|---|
| Trasladar stock entre bodegas (`transferStock`) | Inventario: editar |
| Ajustar existencias (`adjustStock`) | Inventario: editar |
| Crear pedido de venta (`createSale`) | Ventas: editar |
| Devolver mercancía / nota de crédito (`returnSale`) | Ventas: editar |
| Importar saldos de corte (`applyOpenInvoices` y su vista previa) | Configuración: editar |
| Importar existencias de corte (`applyStockSnap`) | Inventario: editar |
| Cargar catálogos Compaq (`resyncCompaq`) | Configuración: editar |
| Movimientos y saldos iniciales de bancos (`addBankMove`, `saveBankOpening`) | Bancos: editar |
| Guardar configuración de la empresa (`saveSettings`) | Configuración: editar |
| Cotizaciones: crear, revisar, decidir | Cotizaciones: editar |
| Pedidos: guardar, guía, marcar recibido | Ventas: editar |
| Gastos (las 4 funciones) | Gastos |
| Contactos y productos (guardar) | Su módulo: editar |
| Borrar solicitud (`deleteRequest`) | Cotizaciones: editar |
| Usuarios: aprobar, rechazar, cambiar rol | Usuarios: editar (solo admin) |

### NO validan rol (solo revisan "es de la empresa")

| Operación | Qué puede hacer quien no debería |
|---|---|
| **Cobrar / pagar** (`registerPayment`) | Cualquier empleado registra cobros de clientes y **pagos a proveedores** (dinero saliendo del banco), y marca facturas como pagadas. |
| **Recibir mercancía** (`receivePurchase`) | Cualquier empleado mete mercancía al kardex y genera la factura por pagar al proveedor. |
| **Entregar mercancía** (`deliverSale`) | Cualquier empleado saca mercancía del kardex y genera la factura de venta. |
| **Crear orden de compra** (`createPurchase`) | Cualquier empleado compromete compras a proveedores. |
| **Facturar mora** (`applyLateInterest`, `invoiceLiveMora`) | Cualquier empleado genera (o deja de generar) facturas de intereses a clientes. |
| **Cambiar la TIIE** (`saveTiie`) | Cualquier empleado altera la tasa con la que se calculan TODOS los intereses de la cartera. |
| **Cambiar el tipo de cambio** (`saveFx`) | Ídem para las operaciones en dólares. |
| **Conciliar banco** (`reconcileMove`) | Cualquier empleado marca o desmarca movimientos bancarios como conciliados. |
| Guardar contactos de un cliente (`saveContact`), documentos (`saveDocument`), márgenes y fletes de solicitudes | Menor impacto, pero igual sin rol. |

Y hay un grupo de **lecturas** sin validación de rol: el estado de cuenta
vivo de la cartera completa, el expediente de cada operación (que incluye a
qué proveedor se compró y con qué margen), las cotizaciones, y la
configuración de la empresa. Cualquier rol — incluido almacén o "solo
consulta" — puede leerlas llamando la función directamente.

---

## Punto 2 — Casos concretos de "sesión sí, permiso no"

Todos estos son posibles hoy, verificados en el código:

1. **El empleado de almacén cobra una factura.** Su rol no tiene acceso a
   bancos ni cartera; el botón no le sale. Pero llama la función de cobro
   directo y el sistema se lo acepta: registra el pago, mueve el saldo del
   banco y marca la factura como pagada.
2. **El de "solo consulta" cambia la TIIE.** Baja la tasa un mes, los
   intereses de mora salen más bajos para el cliente que él quiera favorecer,
   y **no queda huella** (los cambios de tasa no se registran en la bitácora).
3. **La persona de ventas paga a un "proveedor".** El pago a proveedor saca
   dinero del banco. Combinado con que también puede crear la orden de compra
   y "recibirla", puede fabricar el ciclo completo compra→factura→pago.
4. **Un empleado DESPEDIDO sigue operando.** Al desactivar a alguien en
   Usuarios, las funciones bien protegidas lo rechazan — pero todas las de la
   tabla "NO validan rol" **siguen aceptándolo**, porque su chequeo ni
   siquiera mira si el usuario está activo. Desactivar a un ex-empleado hoy
   NO le quita la capacidad de cobrar, pagar, recibir ni entregar.

**Clasificación: CRÍTICO** (los cuatro casos permiten alterar o extraer
dinero). **Dificultad del arreglo: baja.** Es agregar la validación que ya
existe a unas diez funciones, y hacer que el chequeo de membresía exija
estado activo. Uno o dos días de trabajo con pruebas.

---

## Punto 3 — Asignación del administrador y correos desconocidos

**Lo que está bien:**

- La primera cuenta que entra al sistema crea la empresa y queda como
  administrador; a partir de ahí, nadie más puede crear otra empresa. Como tú
  ya eres ese primer usuario, esa puerta ya está cerrada.
- El flujo normal para un correo desconocido es sano: la persona crea su
  cuenta, queda "pendiente" sin acceso a nada, y un administrador la aprueba
  asignándole rol. Nadie puede auto-asignarse administrador por ese camino.
- Solo quien tiene el módulo Usuarios en "editar" (el admin) puede aprobar
  gente o cambiar roles.

**Lo que está mal:**

- **Existe una puerta trasera: el "código de equipo"** (`joinCompany`).
  Cualquier persona que cree una cuenta y tenga ese código entra DIRECTO como
  miembro activo, sin aprobación de nadie. Y el código se le muestra en
  pantalla a **todos** los miembros, no solo al admin. La pantalla actual no
  tiene botón para usar esta puerta, pero la función del servidor existe y se
  puede llamar directo. Encadenado con el punto 1: un empleado le pasa el
  código a un tercero, el tercero crea una cuenta con cualquier correo (no se
  verifica el correo), entra como miembro activo, y ya puede cobrar, pagar,
  recibir y entregar. **CRÍTICO** por la cadena completa. Arreglo fácil:
  eliminar esa función (o hacer que deje a la persona en "pendiente") y
  mostrar el código solo al admin.
- El que entra por esa puerta recibe un rol que ni siquiera existe en el
  catálogo de roles ("operator"), y el sistema, al no reconocerlo, le da la
  plantilla de "solo consulta" — que de todos modos no lo frena en las
  funciones del punto 1.
- **Un admin puede quitarse su propio rol de admin** (o degradar al último
  admin que quede). El sistema solo impide auto-desactivarse, no
  auto-degradarse: la empresa puede quedarse sin ningún administrador y nadie
  podría volver a administrar usuarios. **MENOR** (es un accidente más
  probable que un ataque). Arreglo fácil.
- Las altas de usuarios y los cambios de rol **no quedan en la bitácora**.
  Si alguien aprueba a un cómplice o le sube permisos, no hay registro de
  quién lo hizo ni cuándo. **IMPORTANTE.** Arreglo fácil.

---

## Punto 4 — ¿Una empresa puede ver los datos de otra?

Riesgo bajo en la práctica: el sistema está diseñado para UNA sola empresa
(la creación de una segunda está bloqueada), así que hoy no hay "otra
empresa" de la cual protegerse. Revisando de todos modos:

- Casi todas las consultas filtran correctamente por empresa.
- Encontré un puñado de consultas que no filtran (por ejemplo, la suma de
  cartera al validar el límite de crédito de un cliente). Con una sola
  empresa es inofensivo; si algún día se activara multi-empresa, habría que
  barrerlas antes. **MENOR** — anotado para el futuro, no bloquea nada hoy.

---

## Punto 5 — Datos sensibles expuestos

- **Claves en el código: ninguna.** El secreto compartido de la plantilla de
  Grok Build se eliminó en la sesión anterior (commit del 29 de agosto). Las
  claves reales (base de datos, Google, Better Auth, correo) viven en
  variables de entorno, como debe ser.
- **La clave del servicio de correo (Resend) NO viaja al navegador** — la
  pantalla de configuración solo recibe un "listo/no listo". Bien hecho.
- **El código de equipo sí viaja a todos los miembros** — ver punto 3; es la
  pieza que convierte la puerta trasera en riesgo real. **IMPORTANTE.**
- **Cualquier miembro puede mandar correos a nombre de la empresa**
  (recordatorios de pago y correo libre con asunto y texto a quien sea),
  porque las funciones de correo tampoco validan rol. Un empleado molesto
  puede escribirle a todos los clientes desde la dirección oficial de Azagro.
  **IMPORTANTE.** Arreglo fácil (misma validación del punto 1).
- **Mensajes de error:** los errores del servidor llegan crudos a la
  pantalla. Los escritos a mano están en buen español y no revelan nada, pero
  un error inesperado de la base de datos llegaría con su texto técnico
  completo (nombres de tablas, etc.). **MENOR.**
- Las lecturas sin rol (cartera completa, márgenes, a qué proveedor se
  compra y a qué precio) exponen internamente información que no todo rol
  debería ver — el vendedor puede ver el costo y el margen de todo, almacén
  puede ver toda la cartera. **IMPORTANTE** si esos datos se consideran
  reservados; es más trabajo de decidir "quién ve qué" que de programación.

---

## Punto 6 — Acciones destructivas: confirmación y registro

**Lo que está bien:**

- **El kardex es inmutable y firmado:** cada movimiento de inventario guarda
  quién lo hizo, y no se edita ni se borra — se corrige con otro movimiento.
  Igual los pagos y los movimientos bancarios: todos llevan autor.
- **La bitácora registra las operaciones grandes:** recibir, entregar,
  devolver, cobrar/pagar, traslados, ajustes de inventario, el corte y los
  archivos subidos — con usuario, acción y folio.
- **La pantalla pide confirmación** antes de borrar bodegas, contactos de un
  cliente y solicitudes.
- No existe un "borrar factura" ni "borrar pago": lo hecho, hecho está, y se
  corrige con devolución o contramovimiento. Eso es correcto para un ERP.

**Lo que falta:**

- **Huecos de bitácora:** no se registran los cambios de TIIE ni de tipo de
  cambio (los números que mueven los intereses), ni conciliar/desconciliar
  banco, ni facturar mora, ni las altas de usuarios ni los cambios de rol, ni
  decidir una cotización. Justo varias de esas son las funciones sin
  validación de rol: hoy son a la vez **libres e invisibles**. **IMPORTANTE.**
- **El borrado de solicitudes es borrado de verdad** (las filas desaparecen,
  no se marcan como canceladas) y no deja rastro en bitácora. Es el único
  borrado duro de documentos que encontré. Pide confirmación en pantalla y
  exige permiso de cotizaciones, así que el riesgo es acotado, pero un
  registro de "quién borró qué" costaría poco. **MENOR.**

---

## Resumen ejecutivo

| # | Hallazgo | Nivel | Arreglo |
|---|---|---|---|
| 1 | Cobrar/pagar sin validar rol (dinero entra y sale del banco) | CRÍTICO | Fácil |
| 2 | Recibir, entregar, crear OC y facturar mora sin validar rol | CRÍTICO | Fácil |
| 3 | Empleado desactivado sigue pudiendo operar todo lo anterior | CRÍTICO | Fácil |
| 4 | Cualquiera cambia TIIE / tipo de cambio, sin rol y sin bitácora | CRÍTICO | Fácil |
| 5 | Puerta trasera del código de equipo (entra activo sin aprobación) | CRÍTICO | Fácil |
| 6 | Lecturas sin rol: cartera, márgenes, costos visibles a todos | IMPORTANTE | Medio |
| 7 | Cualquier miembro manda correos a nombre de la empresa | IMPORTANTE | Fácil |
| 8 | Sin bitácora: roles, altas, TIIE/FX, conciliación, borrados | IMPORTANTE | Fácil |
| 9 | Conciliación bancaria sin rol | IMPORTANTE | Fácil |
| 10 | Errores técnicos crudos llegan a la pantalla | MENOR | Fácil |
| 11 | Un admin puede dejarse (o dejar) la empresa sin ningún admin | MENOR | Fácil |
| 12 | Consultas sin filtro de empresa (solo relevante si hubiera 2) | MENOR | Fácil |
| 13 | El registro no verifica el correo (contenido por la aprobación) | MENOR | Medio |

**Orden sugerido antes de dar de alta al equipo:** arreglar 1–5 y 7–9 (es en
esencia el mismo arreglo repetido: conectar la validación de rol que ya
existe, exigir estado activo, cerrar la puerta del código de equipo y
completar la bitácora). El punto 6 requiere que decidas quién puede ver
márgenes y cartera, y se puede hacer en una segunda pasada. Los MENORES no
bloquean el alta del equipo.
