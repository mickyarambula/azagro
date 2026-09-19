# Guía de pruebas — para el dueño de Azagro

Esta guía no es para programadores. Es para que te sientes frente al sistema
como si fueras a trabajar con él todos los días, con datos inventados pero
concretos, y vayas marcando qué funciona, qué te estorba y qué falta.

**Cómo usarla:** sigue los pasos en orden dentro de cada escenario. Cada paso
dice **qué hacer**, **qué debe pasar** y **qué hacer si no pasa**. Marca la
casilla cuando el paso te haya salido bien. Si un paso depende de otro
anterior, te lo digo antes de empezarlo.

No necesitas saber nada de cómo está hecho el sistema por dentro. Solo
necesitas los datos que te doy en cada paso — cópialos tal cual, para no
perder tiempo inventando tú los números.

---

## Antes de empezar: lo que tiene que estar capturado

El sistema tiene una regla de fondo: **nunca inventa un número de dinero**.
Si falta un dato de estos, la pantalla se detiene con un aviso claro (en rojo
o ámbar) en vez de calcular con un número inventado. Así que antes de probar
nada, entra a **Ajustes** y confirma que está esto. Si algo falta, cápturalo
ahí mismo — no hace falta salir de la pantalla.

Todo esto vive en Ajustes → panel **"Reglas de negocio"**, salvo donde digo
otra cosa. Usa estos valores — son los que ya están documentados como la
forma de operar de Azagro, no números inventados para la prueba:

- [ ] **Plazo factura (días)** — cuándo vence la factura frente al cliente. Usa **120**.
- [ ] **Plazo financiero / mora (días)** — desde cuándo corre el interés si no paga. Usa **150**.
- [ ] **Umbral pronto pago (días)** — hasta qué día se le bonifica por pagar antes. Usa **10** (ajústalo después al que realmente uses).
- [ ] **Vigencia de cotización (días)** — cuántos días dura viva una cotización antes de vencer. Esto es nuevo, antes no existía: si no lo capturas, **ninguna cotización se puede generar**. Usa **15**.
- [ ] **Comisión + FEGA (única vez, fracción)** — usa **0.0304** (3.04%).
- [ ] **Comisión dentro de «comisión + FEGA» (fracción)** — usa **0.01** (1%).
- [ ] **Spread mora (factura de intereses, fracción)** — usa **0.09** (9%).
- [ ] **Spread ASR / de línea (en precio, tasa +, fracción)** — usa **0.04** (4%).
- [ ] **Escalera de plazos de la cotización** — usa **0, 30, 60, 90, 120, 150**.
- [ ] Al terminar estos ocho campos y la escalera, pulsa **"Guardar política"** al fondo del panel.

Más abajo en la misma pantalla de Ajustes:

- [ ] Panel **"Políticas de cobro (comisión y FEGA por cliente)"**: las tres políticas (Grupo SL, Estándar, Sin mora) deben decir **Sí/Sí**, **No/No** y **No/No** — no deben decir "sin capturar". Si alguna lo dice, elige Sí o No en los dos menús de esa fila y pulsa **Guardar** en esa fila.
- [ ] Panel **"Tabla TIIE"**: debe tener al menos un renglón con fecha de hoy o antes, con la tasa TIIE del día. Si está vacía, agrega uno.
- [ ] Panel **"Tipo de cambio USD/MXN"**: debe tener al menos un renglón con fecha de hoy o antes. Necesario solo para el Escenario 3 (venta en dólares), pero captúralo ya para no detenerte a media prueba.
- [ ] Panel **"Circuitos de financiamiento"**, fila **ASR**, columna **"Comisión de apertura"**: debe decir un número, no "sin capturar". Usa **0.01** (1%). **Esto es obligatorio incluso para vender de contado** — el sistema lo revisa siempre, aunque la venta no lleve financiamiento.

Con esto capturado, ya puedes empezar. Si en cualquier escenario ves un
aviso que menciona "Ajustes" o "sin capturar" y no está en esta lista,
anótalo en la sección de "Lo que encontré" al final — es una pieza que se
me pasó a mí, no un error tuyo.

---

## ESCENARIO 1 — Una venta a crédito, de punta a punta

Es el camino completo: cliente nuevo, solicitud, cotizar a dos proveedores,
elegir ganador, cotizar al cliente a 150 días, que acepte, pedido, orden de
compra, recibir, entregar y facturar, capturar el folio de Compaq, cobrar,
ver el estado de cuenta.

### 1.1 Dar de alta al cliente nuevo

- [ ] Ve a **Contactos** → pestaña **Clientes** → botón **"+ Alta"**.
- [ ] Captura: Nombre comercial **"Rancho Los Álamos SPR de RL"**, Teléfono **"668 123 4567"**, Correo **"compras@ranchoalamos.mx"**, RFC **"RAL120500XX1"**, Plazo sugerido **150**, Límite de crédito **500000**. Deja **Grupo** en blanco (así el sistema lo trata como cliente Estándar, no Grupo SL).
- [ ] Guarda. **Debe pasar:** el sistema te asigna un código (algo como CL0123). **Anótalo** — lo vas a necesitar en el Escenario 5.
- [ ] **Si no pasa:** si te dice que falta un campo obligatorio, complétalo; si dice que ya existe un cliente con ese nombre o RFC, cambia el RFC por otro inventado y repite.

### 1.2 Dar de alta a los dos proveedores

- [ ] Ve a **Contactos** → pestaña **Proveedores** → **"+ Alta"**. Captura **"Fertilizantes del Fuerte SA de CV"**, con un RFC inventado.
- [ ] Repite para **"Agroquímicos del Valle SA de CV"**, con otro RFC inventado.
- [ ] **Debe pasar:** los dos aparecen en la lista de proveedores. **Si no pasa:** revisa que hayas marcado "Proveedor" y no "Cliente" al capturarlos.

### 1.3 Dar de alta el producto (si no existe ya)

- [ ] Ve a **Productos** → **"Nuevo producto"**.
- [ ] Captura: Nombre **"Urea granular 46-0-0"**, Tipo **Fertilizantes**, Unidad de medida **TM** (toneladas métricas), Precio de lista **11000**, Mínimo de existencia **0**. Deja Costo en 0 — todavía no lo sabes, lo vas a fijar con la cotización a proveedores.
- [ ] Guarda. **Debe pasar:** te manda a la ficha del producto con un código asignado. **Si no pasa:** si ya existe un producto con ese nombre, úsalo directamente y sáltate este paso.

### 1.4 Crear la solicitud

*(Depende de 1.1 y 1.3 — necesitas el cliente y el producto ya dados de alta.)*

- [ ] Ve a **Solicitudes** → **"Nueva solicitud"**.
- [ ] **Cliente:** Rancho Los Álamos. **Cómo se entrega:** En bodega. **Producto:** Urea granular 46-0-0. **Cantidad:** **25** TM.
- [ ] Pulsa **"Registrar solicitud"**. **Debe pasar:** se abre la solicitud con un folio SOL-####. **Si no pasa:** revisa que el cliente y el producto estén bien elegidos (no solo escritos, sino seleccionados de la lista).

### 1.5 Cotizar a los dos proveedores

*(Depende de 1.2 y 1.4.)*

- [ ] Dentro de la solicitud, en la sección **"2. A quién se pide cotización (interno)"**, marca la casilla de Urea granular para los dos proveedores.
- [ ] Pulsa **"Armar lista a proveedores"**. **Debe pasar:** aparece un recuadro por cada proveedor con un botón **"Enviar a [nombre]"** (abre tu correo o WhatsApp; no hace falta mandarlo de verdad para seguir la prueba).

### 1.6 Capturar lo que cotizó cada proveedor y elegir ganador

- [ ] Baja a la sección **"3. Comparativa (interno)"**.
- [ ] En la columna de **Fertilizantes del Fuerte**, escribe **9650** en el precio de Urea granular.
- [ ] En la columna de **Agroquímicos del Valle**, escribe **9500**.
- [ ] Junto al precio de Agroquímicos del Valle, pulsa **"Usar este"**. **Debe pasar:** esa columna se pinta y dice **"Ganador"**, y en la fila del producto aparece "Ganador: Agroquímicos del Valle SA de CV".
- [ ] **Si no pasa:** si "Usar este" no responde, confirma que ya escribiste el precio antes de pulsarlo — no deja marcar ganador sin precio.

### 1.7 Poner el margen y cotizar al cliente

- [ ] Baja a la sección **"4. Cotización al cliente"**.
- [ ] En **Plazo días**, escribe **150**.
- [ ] En la columna **Margen contado** de Urea granular, deja el selector en **%** y escribe **12**.
- [ ] En la columna **Margen crédito**, deja **%** y escribe **15**.
- [ ] **Debe pasar:** en cuanto escribes los dos márgenes, aparecen precios en la escalera de plazos (columnas 0, 30, 60… 150) y en "Financiero /u" aparece un número mayor a cero en la columna de 150 días. Ese número es el financiamiento — es la prueba de que aquí SÍ se está cobrando, y en el Escenario 2 (contado) NO va a aparecer.
- [ ] **Si no pasa:** si ves "Sin comisión capturada en el catálogo del circuito", regresa a Ajustes → Circuitos de financiamiento y captura la comisión ASR (ver la lista de arriba). Si ves "Sin TIIE en la tabla", captura un renglón en Ajustes → Tabla TIIE.
- [ ] Anota la **Vigencia** que te propone (debería ser hoy + 15 días).
- [ ] Pulsa **"Crear y enviar cotización al cliente"**. **Debe pasar:** te confirma el folio (algo como COT-0001).

### 1.8 El cliente acepta

- [ ] Ve a **Cotizaciones**, busca COT-0001, pulsa **"Ver"**.
- [ ] En el panel de aceptar, deja **Tipo de operación** en **Inventario**, elige una bodega en **"Bodega de recepción"**.
- [ ] Pulsa **"Aceptó a crédito → pedido"**.
- [ ] **Debe pasar:** te confirma que se abrió un pedido (PV-####), y en el mismo paso el sistema ya generó **solo** por su cuenta una orden de compra (OC-####) para Agroquímicos del Valle — no la creas tú a mano.
- [ ] **Si no pasa:** si el botón está desactivado, revisa que hayas elegido bodega.

### 1.9 Confirmar el pedido

*(Depende de 1.8.)*

- [ ] Ve a **Ventas**, abre PV-####. Está en borrador.
- [ ] Revisa los datos y pulsa **"Confirmar"**.
- [ ] **Debe pasar:** el pedido cambia de estado; ya no se puede editar el precio ni el cliente, pero sigue pudiéndose entregar.

### 1.10 Recibir la orden de compra

*(Puede hacerse antes o después de 1.9 — son independientes.)*

- [ ] Ve a **Compras**, busca OC-####. Ya aparece como **"confirmada"** (nació así sola).
- [ ] Pulsa **"Recibir"**.
- [ ] **Debe pasar:** la orden pasa a "recibida" y las 25 TM entran al inventario (revisa en **Inventario** que sí aparezcan).
- [ ] **Si no pasa:** el botón "Recibir" solo aparece si la orden es de inventario, no directa/brokeraje — confirma que en el paso 1.8 elegiste "Inventario".

### 1.11 Entregar y facturar

*(Depende de 1.9 y 1.10 — necesitas el pedido confirmado y la mercancía ya recibida.)*

- [ ] Vuelve al pedido PV-####. Pulsa **"Entregar y facturar"**.
- [ ] **Debe pasar:** en el mismo clic se descuenta el inventario y se genera la factura al cliente (FV-####). No hay un paso aparte de "facturar" — es el mismo botón.
- [ ] **Si no pasa:** si dice que falta existencia, confirma que el paso 1.10 sí haya entrado al inventario correcto.

### 1.12 Capturar el folio que Compaq le va a dar a esa factura

*(Depende de 1.11. Compaq timbra la factura por fuera de este sistema — aquí solo anotas el folio y el UUID que te dé, para poder cruzarlos después.)*

- [ ] Ve a **Cartera** (por cobrar), busca FV-####. Junto al folio pulsa **"Folio fiscal"**.
- [ ] Captura, inventados: Folio fiscal **"A 4821"**, UUID **"3F2A9C1B-0000-4E11-8B77-1122334455AA"**.
- [ ] Guarda. **Debe pasar:** debajo del folio FV-#### aparece ese folio fiscal y el UUID, en letra chica.
- [ ] **Si no pasa:** este paso nunca bloquea nada — si Compaq todavía no ha timbrado, se puede dejar vacío y volver otro día.

### 1.13 Cobrar

*(Depende de 1.11.)*

- [ ] En **Cartera**, en la fila de FV-####, pulsa **"Pago"**.
- [ ] Deja la **Fecha** de hoy, elige una **Cuenta** de banco, y en **"Importe (pesos depositados)"** escribe el total completo de la factura (el que te muestra la pantalla).
- [ ] Pulsa **Aplicar**. **Debe pasar:** el mensaje confirma cuánto se aplicó y el saldo de la factura queda en $0.00; la factura desaparece de "Vencidas" (porque ya no debe nada).

### 1.14 Ver el estado de cuenta

*(Depende de 1.13, aunque también puedes verlo antes de cobrar.)*

- [ ] Ve a **Estados de cuenta**, elige **Rancho Los Álamos** en Cliente.
- [ ] **Debe pasar:** ves la factura FV-#### con su folio fiscal (columna nueva), el cargo, el abono que acabas de meter y el saldo en $0.00.

---

## ESCENARIO 2 — Una venta de contado

Igual que el Escenario 1 pero más corto, para comprobar que el Circuito
Contado se comporta distinto (no cobra financiamiento).

*(No depende del Escenario 1, pero puedes reutilizar al mismo cliente y a los mismos proveedores.)*

- [ ] Crea una nueva solicitud: mismo cliente (Rancho Los Álamos), producto **"Sulfato de amonio 21-0-0-24S"** (créalo si no existe, unidad TM), cantidad **10** TM.
- [ ] Cotiza a los dos proveedores igual que antes; precios inventados **$6,900** y **$6,800**; elige ganador al de **$6,800**.
- [ ] En la sección 4, deja **Plazo días** en **0**.
- [ ] Margen contado **10%**. **Debe pasar:** aquí NO aparece un campo de "Margen crédito" que pedir, y en "Financiero /u" el importe queda en "—" (nada que financiar) — a diferencia del Escenario 1, donde sí había un número.
- [ ] Cotiza, acepta ("Aceptó de contado → pedido" o "Cliente aceptó → pedido"), confirma el pedido, recibe la OC, entrega y factura, cobra.
- [ ] **Debe pasar:** todo el camino es igual de corto, sin ningún paso de financiamiento ni de plazo. El circuito de esta cotización, si te fijas en el recuadro "Circuito de financiamiento", debe decir **Contado**, no Circuito ASR.

---

## ESCENARIO 3 — Una venta en dólares

*(No depende de los anteriores, pero reutiliza al mismo cliente.)*

- [ ] Confirma que en Ajustes → Tipo de cambio USD/MXN haya un renglón con fecha de hoy. Anota esa tasa.
- [ ] Crea una solicitud para Rancho Los Álamos, producto **"Glifosato 480 SL"** (créalo, unidad TM), cantidad **5** TM.
- [ ] Cotiza a proveedores igual que antes, precios inventados en pesos (aunque el producto se venda en dólares, el costo al proveedor sigue siendo el que capturaste).
- [ ] En la sección 4, cambia **Moneda** a **USD**. **Debe pasar:** aparece un campo de tipo de cambio: si ya hay tabla, te propone la tasa de hoy con la leyenda "TC (tabla FECHA)"; si no, di "TC (sin tabla)" y tienes que escribir uno a mano, por ejemplo **18.50**.
- [ ] Plazo días **150**, márgenes igual que en el Escenario 1.
- [ ] Cotiza, acepta, confirma, recibe, entrega y factura.
- [ ] **Debe pasar:** la factura FV queda en dólares; en Cartera, junto al total, debe indicar la moneda USD y el tipo de cambio pactado.
- [ ] Al cobrar, en el modal de pago debe pedirte **capturar el tipo de cambio del pago** (obligatorio en dólares) antes de dejarte aplicar el importe en pesos depositados.
- [ ] **Si no pasa:** si te deja cobrar en dólares sin pedirte el tipo de cambio del pago, anótalo en "Lo que encontré" — es justamente lo que no debe pasar.

---

## ESCENARIO 4 — Una cotización rechazada y una que vence

Los dos caminos que se acaban de construir para no perder una cotización
vieja: se conserva tal cual, y nace una nueva sin volver a capturar todo
desde cero.

### 4.1 Rechazar y volver a cotizar desde la misma solicitud

*(Se puede probar en la misma sesión.)*

- [ ] Crea una solicitud nueva: mismo cliente, producto **"Cloruro de potasio 0-0-60"** (créalo), cantidad **8** TM. Cotiza a un solo proveedor si quieres ir más rápido (precio $7,200), elige ganador, margen contado 10%, plazo 0, cotiza al cliente.
- [ ] Ve a **Cotizaciones**, abre esa cotización, pulsa **"Cliente rechazó"**.
- [ ] **Debe pasar:** la cotización queda marcada **"Rechazada"** — se conserva, no se borra.
- [ ] Regresa a la **solicitud** de la que salió. **Debe pasar:** ya no dice "Ya existe… ver documento" — aparece un aviso amarillo diciendo que esa cotización se rechazó, y el botón vuelve a decir **"Cotizar de nuevo"**, con un campo de vigencia para llenar.
- [ ] Pulsa **"Cotizar de nuevo"** con una vigencia de hoy + 15 días. **Debe pasar:** se genera una cotización nueva con folio distinto (por ejemplo COT-0007), y la rechazada (COT-0006) se puede seguir viendo en Cotizaciones exactamente como quedó, sin que nadie la haya tocado.
- [ ] **Si no pasa:** si el botón sigue bloqueado o no aparece el aviso, anótalo — es justo lo que se acaba de arreglar.

### 4.2 Una cotización directa que vence (esta parte no se termina el mismo día)

*(Es independiente de 4.1. Necesita que pase al menos un día de calendario entre el primer paso y el segundo — no hay forma de probarlo todo en una sola sesión, porque el sistema no deja crear una cotización que nazca ya vencida.)*

**Hoy:**
- [ ] Ve a **Cotizaciones** → arma una cotización directa (sin pasar por solicitud) para Rancho Los Álamos: producto Urea granular, 5 TM, precio de contado $11,000, plazo 0.
- [ ] En **Vigencia**, deja la fecha de **hoy mismo**.
- [ ] Pulsa **"Guardar cotización"**. Anota el folio (por ejemplo COT-0008).

**Mañana o después (cuando vuelvas a probar):**
- [ ] Abre COT-0008 en Cotizaciones. **Debe pasar:** su estatus ahora dice **"Vigencia vencida"**.
- [ ] En la fila de esa cotización, pulsa **"Duplicar con tasas de hoy"**.
- [ ] **Debe pasar:** nace una cotización nueva, en borrador, con el mismo cliente, mismo producto, misma cantidad y mismo margen — pero con la tasa y la vigencia recalculadas con la fecha de ese día, no con las de cuando la creaste. La vieja (COT-0008) se queda igual, vencida, sin tocarse.

---

## ESCENARIO 5 — Un cliente que se atrasa y cae en mora

El interés de mora empieza el día 150 desde la factura (lo que capturaste en
Ajustes). Esperar 150 días de verdad no es práctico, así que aquí vamos a
simular un saldo ya vencido, tal como se hará el día que se pegue el corte
real de Compaq — es una función real que de todos modos vas a necesitar.

*(Depende del Escenario 1: necesitas el código del cliente que anotaste ahí — Rancho Los Álamos.)*

- [ ] Ve a **Ajustes** → **"Corte y catálogos Compaq"** (o al menú que diga "Importar").
- [ ] En el cuadro de **"Saldos abiertos (CxC / CxP)"**, pega este renglón, cambiando `CL0123` por el código real que anotaste del cliente:

  ```
  CL0123,A-500,2026-03-01,2026-06-01,80000,0,80000,MXN,cliente
  ```

  (Esto dice: cliente CL0123, folio A-500, factura del 1 de marzo, vence el 1 de junio, cargo $80,000, sin abonos, saldo $80,000, pesos, es un cliente.)
- [ ] En **"Política de cobro de estos saldos"**, elige **Estándar**.
- [ ] Pulsa **"Previsualizar"**. **Debe pasar:** te muestra el renglón, con el nombre del cliente ya resuelto.
- [ ] Pulsa el botón para aplicarlo de verdad (junto a Previsualizar). **Debe pasar:** confirma cuántas facturas entraron.
- [ ] Ve a **Cartera** o a **Vencimientos**. **Debe pasar:** esa factura ya aparece vencida, con días de atraso, y calcula un interés (mora) sobre el cargo original.
- [ ] Pulsa sobre el interés (o el botón de "Mora") para ver el desglose. **Debe pasar:** te explica la fórmula — cargo original × tasa × días / 360 — sin que tengas que adivinar nada.
- [ ] Ve a **Estados de cuenta** con Rancho Los Álamos. **Debe pasar:** la factura A-500 aparece con "Vence" (1 de junio) e "Interés desde" (también 1 de junio, porque un saldo importado no trae las dos fechas separadas) y el interés calculado.
- [ ] Cobra esa factura desde Cartera (Pago) por el saldo completo. **Debe pasar:** te dice cuánto de interés (mora) se facturó aparte, con su propio folio (FI-####).
- [ ] Como elegiste política **Estándar** (no Grupo SL), **no debe cobrar** comisión ni FEGA — solo interés. Si hubieras elegido Grupo SL, sí los cobraría. Ninguna de las dos es un error; son dos negociaciones distintas.

---

## ESCENARIO 6 — Roles: crear tres usuarios y comprobar que cada quien cierra su parte

Esta es la matriz de permisos que se acaba de corregir, y todavía no se ha
probado con personas de verdad. Vas a necesitar **tres correos distintos**
para las tres cuentas de prueba — si usas Gmail, puedes usar el mismo buzón
tres veces con el truco de agregarle un "+algo" antes de la arroba: por
ejemplo `tucorreo+ventas@gmail.com`, `tucorreo+almacen@gmail.com` y
`tucorreo+cobranza@gmail.com` — los tres correos son válidos y llegan al
mismo buzón, pero el sistema los trata como tres personas distintas. Abre
cada uno en una ventana de navegador **de incógnito** para no mezclar
sesiones.

### 6.1 Dar de alta a los tres

*(Repite esto tres veces, una por cada correo.)*

- [ ] En una ventana de incógnito, entra al sistema con ese correo y pulsa **"Pedir acceso"**.
- [ ] En tu ventana normal (como administrador), ve a **Usuarios** → pestaña **Equipo**. Debe aparecer en "Solicitudes pendientes".
- [ ] Elige el rol correspondiente (**Ventas** para el primero, **Almacén** para el segundo, **Cobranza** para el tercero) y pulsa **"Aprobar"**.
- [ ] Para el de Ventas, confirma que quedó marcada la casilla **"Solo su cartera (vendedor: clientes, cotizaciones y pedidos propios)"** — se marca sola al elegir el rol Ventas, pero verifícalo en "Permisos".

### 6.2 Ventas: cierra su tramo sin pedirle nada a nadie

*(Depende de 6.1. Usa la ventana de incógnito del correo +ventas.)*

- [ ] Da de alta un cliente nuevo, **"Agropecuaria Tres Ríos SA de CV"**, tú mismo como vendedor asignado.
- [ ] Crea una solicitud para ese cliente, con Urea granular, 15 TM.
- [ ] En la sección "2. A quién se pide cotización", marca a los dos proveedores del Escenario 1, arma la lista, y en la sección 3 escribe precios y elige ganador. **Debe pasar:** todo esto responde sin que te aparezca ningún aviso de "sin permiso" — antes de esta corrección, aquí se hubiera detenido.
- [ ] Cotiza al cliente y, en la pantalla de la cotización, pulsa **"Enviar como Azagro"** si aparece (si no está configurado el correo directo, verás la opción de abrir tu programa de correo — con eso basta). **Debe pasar:** no aparece bloqueado.
- [ ] En esa misma cotización, acéptala igual que en el Escenario 1 (Inventario, bodega, "Aceptó a crédito → pedido"). **Debe pasar:** también responde sin bloquearse — se abre el pedido y nace sola la orden de compra. Anota el folio de la orden (la vas a usar en 6.3).
- [ ] **Debe pasar en conjunto:** ventas completó solicitud → cotización → pedido sin que compras o un administrador tuvieran que intervenir.
- [ ] Ahora intenta entrar a **Compras**. **Debe pasar:** el menú ni siquiera muestra esa opción, o si entras por la liga directa, te dice que no tienes permiso.
- [ ] Ve a **Cartera**. **Debe pasar:** si "cartera propia" está activa, solo ves los documentos de Agropecuaria Tres Ríos (tu cliente) — no ves a Rancho Los Álamos, que es del administrador.

### 6.3 Almacén: recibe y entrega, no toca dinero

*(Depende de 6.1 y 6.2 — usa la orden de compra que quedó generada al aceptar la cotización en 6.2.)*

- [ ] Con la ventana de incógnito del correo +almacen, entra a **Compras** y recibe la orden de compra que anotaste en 6.2.
- [ ] Entra a **Ventas**, abre el pedido de 6.2 (todavía en borrador) y pulsa **"Confirmar"**. **Debe pasar:** responde sin bloquearse.
- [ ] En el mismo pedido, pulsa **"Entregar y facturar"**. **Debe pasar:** también responde sin bloquearse.
- [ ] Intenta entrar a **Cartera**. **Debe pasar:** no la ve, o le dice que no tiene permiso — almacén no debe ver dinero de clientes.
- [ ] Intenta entrar a **Bancos**. **Debe pasar:** tampoco la ve.

### 6.4 Cobranza: cobra y ve estados de cuenta, no toca inventario

*(Depende de 6.1 y de que exista al menos una factura abierta — la de Rancho Los Álamos o la de Agropecuaria Tres Ríos.)*

- [ ] Con la ventana de incógnito del correo +cobranza, entra a **Cartera** y registra un cobro sobre una factura abierta.
- [ ] Entra a **Estados de cuenta** y ábrelo para ese cliente. **Debe pasar:** lo ve completo, y puede enviarlo por correo/WhatsApp.
- [ ] Intenta entrar a **Inventario**. **Debe pasar:** no la ve.
- [ ] Intenta entrar a **Solicitudes** o **Cotizaciones**. **Debe pasar:** no las ve — cobranza no cotiza ni vende.

### 6.5 Lo que ningún rol distinto de administrador debe poder hacer

- [ ] Con cualquiera de las tres cuentas, ve a **Usuarios**. **Debe pasar:** no puede cambiar su propio rol ni sus propios permisos (el sistema lo bloquea aunque sea "administrador" de nombre).
- [ ] Como administrador, revisa **Bitácora**. **Debe pasar:** ves ahí registrado cada alta de usuario y cada cambio de rol que acabas de hacer, con fecha y quién lo hizo.

---

## ESCENARIO 7 — Los circuitos de financiamiento

*(Depende de los Escenarios 1 y 2 — reutiliza esas dos cotizaciones para comparar.)*

- [ ] Abre la cotización del Escenario 1 (crédito, 150 días). En el recuadro **"Circuito de financiamiento"** debe decir **Circuito ASR**.
- [ ] Abre la cotización del Escenario 2 (contado). Debe decir **Contado**.
- [ ] En la del Escenario 1, en la tabla de partidas, compara la columna **"Financiero /u"**: debe tener un número mayor a cero. En la del Escenario 2, esa misma columna debe estar en "—" o no aparecer.
- [ ] Crea una solicitud rápida más (mismo cliente, un producto, una cantidad cualquiera) y llega hasta la sección "4. Cotización al cliente" **sin pulsar todavía "Crear y enviar cotización al cliente"**. En el recuadro "Circuito de financiamiento" debe aparecer un menú (no un texto fijo) donde, como administrador, puedes elegir entre Contado y Circuito ASR (Línea Santa Rosa y Línea propia deben verse apagadas, "por construir" — no elegibles). Si entras con la cuenta de Ventas del Escenario 6 a esa misma solicitud, ese recuadro debe verse como texto fijo, no como menú — solo el administrador lo mueve.
- [ ] Ahora sí cotiza esa solicitud y acepta la cotización para que nazca el pedido. Abre el pedido ya **confirmado**. **Debe pasar:** ahí el circuito solo se ve, en ningún lado del pedido hay manera de tocarlo — quedó fijo desde que se cotizó, antes incluso de que existiera el pedido.

---

## ESCENARIO 8 — Compras en dólares (Decisiones 76-81, 17-sep-2026)

**El número que más importa:** una orden de compra de **10,000 USD a tipo de cambio 18.50** tiene que aparecer en Cuentas por pagar como **USD 10,000.00 · TC 18.5 · $185,000.00**, y los totales de esa pantalla tienen que sumar **$185,000.00** en pesos — nunca 10,000 sumados como si fueran pesos.

**Antes de empezar:** un proveedor con plazo de pago capturado (paso 3 lo arregla si no lo tiene) y un tipo de cambio capturado para hoy (paso 1).

1. Entra a "Ajustes". Baja hasta el panel "Tipo de cambio USD/MXN". Deja la fecha de hoy, escribe `18.5` en el campo del valor y pulsa "Agregar". Debes ver el renglón con la fecha de hoy y `18.5000`.
2. Ve a "Compras" → "Pedidos de compra" y pulsa "Nueva orden" (o la pestaña "Nueva"). En "Moneda" elige `USD`. Debes ver que aparece una caja nueva "Tipo de cambio" con `18.5` ya puesto y debajo el texto "Tabla: 18.5 (fecha). Es el TC del proveedor; corrígelo si pactaron otro." El campo se puede cambiar: es el tipo de cambio que te dio el proveedor, no el que se pactó con el cliente.
3. En la partida, en "Cant." escribe `10` y en "Costo / UOM" escribe `1000`. El "Total" debe decir `USD 10,000.00`. Pulsa "Colocar orden". Debes ver "Orden OC-… confirmada". En la pestaña "Todas", la orden aparece con `USD 10,000.00` y debajo `TC 18.5`.
4. Candado — orden en dólares sin tipo de cambio: en "Nueva", con "Moneda" en `USD`, borra el número del campo "Tipo de cambio" y pulsa "Colocar orden". Debes ver, en rojo: "Sin tipo de cambio para la orden de compra en dólares. Captúralo: la pantalla lo propone de la tabla (Ajustes → Tipo de cambio) y se puede corregir; sin renglón en la tabla no se guarda nada en dólares." Escribe de nuevo `18.5` y pulsa "Colocar orden": ahora sí se coloca (esa segunda orden la puedes cancelar después con "Cancelar").
5. Candado — fecha sin tipo de cambio en la tabla: en "Nueva", cambia "Fecha" a un día anterior al del renglón que capturaste en el paso 1 y elige `USD`. La caja "Tipo de cambio" debe decir "Sin renglón en la tabla para esta fecha: captúralo en Ajustes → Tipo de cambio." El camino: capturar en Ajustes un renglón con esa fecha, o regresar la fecha a hoy. Regresa la fecha a hoy.
6. En "Todas", en el renglón de la orden del paso 3 pulsa "Recibir" y luego "Recibir todo lo pendiente". Si el proveedor no tiene plazo de pago, debes ver en rojo: "Falta el plazo de pago de … Sin ese dato no se puede saber cuándo hay que pagarle esta compra, y por eso no se puede registrar la entrada. Pídele a compras, administración o gerencia que lo capture en la ficha del proveedor (si es de contado, se captura 0). En cuanto esté, vuelve a recibir." Entonces: "Contactos" → "Proveedores", busca el proveedor, en "Plazo de pago (días) — sin plazo: captúralo" escribe `30` y pulsa "Guardar". Regresa a "Compras" → "Pedidos de compra" → "Recibir" → "Recibir todo lo pendiente". La orden debe quedar en "Recibida".
7. Ve a "Cartera" → "Por pagar". Debes ver la factura del proveedor con "Total" `USD 10,000.00`, debajo `TC 18.5 · $185,000.00`, "Pagado" `USD 0.00` y "Saldo" `USD 10,000.00`. Arriba, "TOTAL FACTURADO" y "SALDO" deben decir `$185,000.00`. **Este es el número.**
8. Pulsa "Documento" en esa factura. El papel debe decir `US$10,000.00` en la partida y en "Saldo" — dólares, no pesos con signo de dólar.
9. Ficha de producto en dólares: "Almacén" → productos, abre cualquier producto (o "+ Alta"). En "Costo de referencia" escribe `1000` y en "Moneda en que lo capturas" elige `USD`; pulsa "Guardar". Vuelve a abrir la ficha: "Costo de referencia" debe decir `18500` (se guardó en pesos al tipo de cambio de hoy). En "Bitácora" el renglón dice "costo de referencia 0 → 18500 · capturado 1000 USD × TC 18.5".
10. Candado — costo de referencia en dólares sin tipo de cambio: si borras el renglón de tipo de cambio de hoy en "Ajustes" (o pruebas en una empresa sin ninguno) y repites el paso 9, debes ver "Sin tipo de cambio para el costo de referencia en dólares. Captúralo: …" y no se guarda nada. El camino: capturar el tipo de cambio en Ajustes y volver a guardar.
11. Corrección del tipo de cambio en una orden: solo aparece en órdenes en dólares que nacieron sin tipo de cambio real (las de antes de este cambio, marcadas "sin TC" con un campo y el botón "Guardar TC" bajo el total). Si no tienes ninguna, no verás el campo: es lo esperado. Si la orden ya tiene deuda viva, el botón se detiene con: "OC-… ya tiene deuda viva (FP-…) nacida con TC …: el TC no se cambia después. Si el TC estaba mal, revierte la recepción, corrige el TC y vuelve a recibir."

**Lo que todavía NO se prueba aquí (piezas siguientes):** pagar esa factura en dólares con su tipo de cambio y su diferencial (A.1b); comprar dólares como movimiento con tipo de cambio (A.1c); que el inventario valúe esa entrada en pesos — hoy el movimiento de inventario sigue en `1,000` por unidad mientras la deuda ya está en `18,500` (A.1c, Decisión 77).

## ESCENARIO 9 — Pagar en dólares: con pesos y desde la cuenta en dólares (Decisión 80, 17-sep-2026)

**El número que más importa:** la factura del proveedor de **10,000 USD a 18.50** (la del Escenario 8) pagada con **11,400 pesos a 19.00** tiene que aplicar **$11,100.00** al saldo, sacar **11,400** del banco y decir **"Diferencial TC: pérdida cambiaria 300.00"**. Los 300 son pesos que Azagro pagó de más por el movimiento del dólar; en un cliente serían utilidad.

**Antes de empezar:** la factura FP-0001 del Escenario 8 viva, y saldo en las dos cuentas: "Cartera" → "Bancos", en "Saldo inicial" de Banorte MXN escribe `50000` y de Banorte USD `2000` (se guarda al salir del campo). Debes ver `$50,000.00` y `$2,000.00`.

1. Ve a "Cartera" → "Por pagar" y pulsa "Pago" en el renglón de FP-0001. En "Cuenta" elige `Banorte USD · $2,000.00`. Debes ver que la etiqueta del importe cambia a "Importe (dólares que entran o salen de la cuenta)", que desaparecen "TC del pago" y "Diferencial contra el TC pactado", y que abajo dice "Factura en dólares contra la cuenta en dólares: sin diferencial cambiario; el importe se aplica al TC pactado."
2. En el importe escribe `400` y pulsa "Aplicar". Debes ver en verde: "Aplicado $7,400.00 en Banorte USD. Saldo factura $177,600.00. Caja $1,600.00." (400 × 18.50 = 7,400; la caja en dólares bajó de 2,000 a 1,600). El renglón dice "Pagado" `USD 400.00` y "Saldo" `USD 9,600.00`.
3. Pulsa "Pago" otra vez. Deja "Cuenta" en `Banorte MXN`. Ahora sí aparecen "Importe (pesos depositados)", "TC del pago (obligatorio: factura en dólares)" y el diferencial con dos opciones: "Dejarlo como utilidad/pérdida" y "Ajustar al pactado (por pagar / por cobrar al proveedor)".
4. Candado — sin tipo de cambio: deja "TC del pago" vacío, escribe `11400` en el importe y pulsa "Aplicar". Debes ver en rojo "Es factura en dólares: captura el tipo de cambio del pago." El camino: escribir el TC.
5. Escribe `19` en "TC del pago", deja "Dejarlo como utilidad/pérdida" y pulsa "Aplicar". Debes ver: "Aplicado $11,100.00 en Banorte MXN. Saldo factura $166,500.00. Caja $38,600.00. Diferencial TC: pérdida cambiaria 300.00." **Este es el número.** El renglón dice "Pagado" `USD 1,000.00` y "Saldo" `USD 9,000.00`.
6. Pulsa "Revertir último abono" en ese renglón. El resumen debe listar: el contra-pago por `−$11,100.00`, el contra-movimiento de Banorte MXN por `$11,400.00 MXN` sin conciliar, y "FP-0001 · pérdida cambiaria de este pago registrada en la factura → se regresa · $300.00 MXN"; y en "Vuelve a deber": `$166,500.00 → $177,600.00`. Pulsa "Cerrar" (no hace falta confirmarla; si la confirmas, escribe el motivo y verifica que la caja regresa a `$50,000.00`).
7. La otra opción del diferencial: pulsa "Pago", cuenta `Banorte MXN`, importe `18000`, TC `18`, elige "Ajustar al pactado (por pagar / por cobrar al proveedor)" y pulsa "Aplicar". Debes ver "Diferencial TC: POR PAGAR ATC-0001: 500.00": se le pagaron 18,000 pesos por 1,000 dólares que al pactado valen 18,500, así que quedan 500 pesos por pagarle, en su propio documento. En la lista aparece `ATC-0001` con saldo `$500.00`. (Si en vez de eso pagas a `19`, el documento dice "POR COBRAR AL PROVEEDOR": se le pagó de más.)
8. Cobrar a un cliente en dólares no cambió: en "Por cobrar", una factura en dólares cobrada con pesos sigue pidiendo TC y las dos opciones "Dejarlo como utilidad/pérdida" / "Ajustar al pactado (por cobrar / devolver)"; cobrada en `Banorte USD`, el importe es en dólares y no hay diferencial.

**Lo que todavía NO se prueba aquí:** comprar dólares (pasar pesos a la cuenta en dólares con su tipo de cambio) y ver el inventario valuado en pesos — A.1c. El P&L del pedido todavía no suma la pérdida o ganancia cambiaria del lado del proveedor.

## ESCENARIO 10 — Comprar dólares, recibir en pesos y ver el inventario cuadrar con la deuda (Decisiones 77 y 81, 18-sep-2026)

**El número que más importa:** una orden de **10 × 1,000 USD a 18.50** recibida tiene que dejar el inventario en **$18,500.00 por unidad y $185,000.00 en total**, y la factura del proveedor en **$185,000.00**: el mismo número en Almacén y en Cartera.

**Antes de empezar:** un tipo de cambio para hoy en "Ajustes" → "Tipo de cambio USD/MXN" (`18.5`, "Agregar"), el proveedor con "Plazo de pago (días)" capturado, y en "Cartera" → "Bancos" un "Saldo inicial" de `50000` en Banorte MXN (Banorte USD en `0`).

1. En "Bancos", en "Tipo de movimiento" pulsa "Compra de dólares". Deja "Cuenta" en `Banorte MXN`; en "Dólares" escribe `1000`; en "Tipo de cambio" debe aparecer el de la tabla (o escríbelo: `18.4`); en "Cuenta destino (dólares)" elige `Banorte USD`. Pulsa "Registrar compra de dólares". Debes ver: Banorte MXN `$31,600.00`; Banorte USD `USD 1,000.00` y debajo "TC promedio 18.4 · $18,400.00 en pesos"; y en la lista dos renglones "Compra de 1000.00 USD a 18.4": `$1,000.00` en Banorte USD y `−$18,400.00` en Banorte MXN.
2. Candado — transferencia entre monedas: pulsa "Transferencia", "Cuenta" `Banorte MXN`, "Importe" `100`, "Cuenta destino" `Banorte USD`, "Registrar transferencia". Debes ver en rojo: "Banorte MXN está en MXN y Banorte USD en USD: una transferencia no cambia de moneda. Usa «Compra de dólares», que pide el tipo de cambio." El camino es el paso 1.
3. Candado — sin saldo: "Compra de dólares" de `5000` dólares a `18.4` (91,999 pesos). Debes ver "No hay saldo suficiente en Banorte MXN (31600.00 MXN) para 92000.00 MXN. Cobra primero o captura saldo inicial." No se registra nada.
4. Ve a "Compras" → "Pedidos de compra" → "Nueva orden". "Moneda" `USD`, "Tipo de cambio" `18.5`, "Cant." `10`, "Costo / UOM" `1000`, "Colocar orden". En "Todas" la orden dice `USD 10,000.00` y `TC 18.5`.
5. Pulsa "Recibir" → "Recibir todo lo pendiente". La orden queda "Recibida".
6. Ve a "Almacén" → "Inventario". Arriba, "En proveedor · $185,000.00". En la tabla, el producto con "Cantidad" `10`, "Costo prom." `$18,500.00` y "Valor" `$185,000.00`. En el kardex, el renglón `REC/0001` con "Costo" `$18,500.00`. **Este es el número: 18,500 pesos por unidad, no 1,000.**
7. Ve a "Cartera" → "Por pagar". La factura del proveedor dice `USD 10,000.00 · TC 18.5 · $185,000.00` y "TOTAL FACTURADO" `$185,000.00`. **Inventario y deuda dicen lo mismo.**
8. Pulsa "Pago", "Cuenta" `Banorte USD · $1,000.00`, importe `1000`, "Aplicar". Debes ver "Aplicado $18,500.00 en Banorte USD. Saldo factura $166,500.00. Caja $0.00." (salieron los 1,000 dólares que compraste; no hay diferencial). En "Bancos", Banorte USD queda `USD 0.00` y "Sin dólares con TC".
9. Ve a "Inicio". "Caja" debe decir `$31,600.00` con "Saldos bancarios en pesos" (si quedaran dólares diría "Pesos · US$… en la cuenta en dólares"); "Por pagar" `$166,500.00` con "… · USD 9,000.00 en dólares"; "Inventario Azagro" con "Proveedor $185,000.00".
10. Si el producto ya tenía inventario en pesos, el "Costo prom." es el promedio ponderado de lo anterior con estos 18,500 — nunca un promedio entre 1,000 "dólares" y pesos.

**Lo que todavía NO se prueba aquí:** la posición cambiaria (cuánto se debe y nos deben en dólares por vencimiento, y qué está cubierto): va en el Escenario 13. Vender en dólares es el Escenario 11.

## ESCENARIO 11 — Vender en dólares: el precio se captura en dólares y todo lo enseña en dólares (Decisión 82, 18-sep-2026)

**El número que más importa:** una cotización de **10 × 1,000 USD a 18.50** tiene que dejar el pedido en **USD 10,000.00** (y por dentro 185,000 pesos), la factura en **USD 10,000.00 · TC 18.5 · $185,000.00**, y al devolver 5 la nota de crédito en **−USD 5,000.00** con la factura en **USD 5,000.00** de saldo. Nunca 18,500 dólares, nunca 54.05.

**Antes de empezar:** un producto con "Precio de lista" `18500` y "Costo de referencia" `9250` (pesos), existencia de ese producto en "Bodega Central Azagro" (una orden de compra recibida: 20 a `9250`, el proveedor con "Plazo de pago (días)" capturado), el cliente con "Plazo de pago (días)" en `0` (contado), y en "Ajustes" la "Política de crédito" completa y en "Circuitos de financiamiento" la comisión de apertura del "Circuito ASR" capturada (`0.01`, "Guardar").

1. Ve a "Ventas" → "Cotizaciones" y abre "Alta manual (sin solicitud)". "Moneda" queda en `USD`. En "Dólar pactado" escribe `18.5` y sal del campo con Tab. Debes ver que el precio de la partida, que decía `18500`, cambia solo a `1000`, la columna dice "P. contado (USD)" y el importe "USD 1,000.00". **Ese es el primer número: el precio de lista en pesos se propone en dólares.**
2. En "Precios" elige "Contado". En "Cliente" escribe `BERSE` y elige "AGRICOLA BERSE". En "Cant." escribe `10`. "Totales" dice "Contado USD 10,000.00". Pulsa "Guardar cotización". En la lista: "COT-0001 · AGRICOLA BERSE · Contado · USD · dólar pactado 18.5 · Vigente · USD 10,000.00".
3. Pulsa "Ver". En la tabla: "Costo puesto" `USD 500.00`, "Precio" `1000`, "Utilidad /u" `500`, "Margen %" `50`, "Importe" `USD 10,000.00`, y abajo "Sin cambios de precio." (nada de "Cambiaste precios" sin haber tocado nada, y nada de "Utilidad negativa").
4. Candado — sin tipo de cambio: en "Alta manual", con "Moneda" `USD`, borra el "Dólar pactado" (déjalo en `0`) y pulsa "Guardar cotización". Debes ver en rojo "Sin tipo de cambio: la tabla está vacía. Captúralo en Ajustes → Tipo de cambio o escribe el pactado." El camino legítimo es el paso 1.
5. De vuelta en "Ver" de COT-0001, en "Bodega de recepción" elige `Bodega Central Azagro` y pulsa "Cliente aceptó → pedido". Se abre "PV-0001 · Borrador" con "TOTAL USD 10,000.00", "PRECIO / UOM (USD)" `1000` e "IMPORTE" `USD 10,000.00`. Pulsa "Confirmar".
6. Pulsa "Entregar" → "Entregar todo lo pendiente". Aparece "ENTREGAS · ENV/0001 · ALB01 10 LTS" con "Facturar esta entrega". Púlsalo. Debes ver "FV-0001 emitida por la entrega ENV/0001". Abajo, en "Facturas de este pedido": "FV-0001 · USD 10,000.00 · open". En la tarjeta "VENTA" del pedido: `$185,000.00` (el P&L es en pesos, a propósito) y "MARGEN OPERACIÓN" `$92,500.00 · 50.0% sobre venta`.
7. En "Devolución del cliente", junto a "COFACTOR" debe decir `USD 1,000.00`. En "A DEVOLVER" escribe `5`, en "Motivo" `No ocupó`, pulsa "Registrar devolución". Debes ver "Se abonó USD 5,000.00 a FV-0001", y en "Facturas de este pedido": "FV-0001 · USD 5,000.00 · open" y "NC-0001 · USD 0.00 · paid".
8. Ve a "Ventas" → "Pedidos de venta". La lista dice "PV-0001 · Contado USD · Entregado · USD 10,000.00" (no US$185,000.00).
9. Ve a "Cartera" → "Por cobrar". "FV-0001": TOTAL `USD 10,000.00` y debajo `TC 18.5 · $185,000.00`, PAGADO `USD 5,000.00`, SALDO `USD 5,000.00`. "NC-0001": TOTAL `−USD 5,000.00`, PAGADO `−USD 5,000.00`, SALDO `USD 0.00`, "Pagada".
10. Ve a "Cartera" → "Estados de cuenta" y pulsa "Ver" en AGRICOLA BERSE. En el bloque "MONEDA: DÓLAR AMERICANO": la FV con CARGO `USD 10,000.00`, ABONOS `USD 5,000.00`, SALDO `USD 5,000.00`; la NC con CARGO `−USD 5,000.00`; el "Total" con SALDO `USD 5,000.00`; y en "Por producto — saldo pendiente": "COFACTOR USD 5,000.00". Arriba a la derecha, "Saldo $92,500.00" es la cartera del cliente en pesos (así se suma la línea de crédito), y el texto de "Enviar" lo dice: "total en pesos; los renglones en dólares van al tipo de cambio pactado".
11. Pulsa "Documento" en la cotización o en el pedido: el papel lleva "USD 1,000.00" por unidad y "USD 10,000.00" de total, "USD · dólar pactado 18.5". Ni un peso con signo US$.

**Lo que todavía NO se prueba aquí:** la posición cambiaria (va en el Escenario 13); y una factura en dólares que se haya capturado ANTES del 18-sep-2026 con el precio tecleado como pesos: esa no se corrige sola, se revisa a mano.

## ESCENARIO 12 — Tres avisos cerrados de L4a: el ajuste cambiario en pesos, el precio en 0 de la OC del cliente, el circuito sin elegir (18-sep-2026)

**El número que más importa:** una OC del cliente en dólares sin precio capturado en una partida ya NO se registra — antes se guardaba con precio `0` sin avisar.

**Antes de empezar:** esto se prueba en una empresa **nueva** (o en cualquiera donde el "Circuito ASR" de "Ajustes" → "Circuitos de financiamiento" todavía diga "Por construir" en "¿Elegible hoy?"). Si tu empresa ya tiene el ASR en "Sí", el paso 3 no aplica — pasa directo al paso 4.

1. Ve a "Ajustes" → "Circuitos de financiamiento". En el renglón "Circuito ASR", la columna "¿Elegible hoy?" debe decir **"Por construir"** (antes decía "Sí" sin que nadie hubiera capturado nada). El renglón "Contado" sigue en "Sí": no necesita nada capturado.
2. Candado — cotizar a crédito por ASR sin comisión: en "Ventas" → "Cotizaciones", "Alta manual", elige "Crédito" (o "Contado y crédito") y guarda. Debes ver en rojo un aviso de que falta la comisión de apertura del circuito, con la instrucción de capturarla en "Ajustes" → "Circuitos de financiamiento". El camino legítimo es el paso siguiente.
3. En "Ajustes" → "Circuitos de financiamiento", en el renglón "Circuito ASR", escribe `0.01` en "Comisión de apertura" y pulsa "Guardar". La columna "¿Elegible hoy?" de ESE renglón cambia sola a **"Sí"**. Los renglones "Línea Santa Rosa" y "Línea propia" siguen en "Por construir": capturarles algo ahí no los activa, porque su base todavía no está construida.
4. Ve a "Ventas" → "OC del cliente". Con "Moneda" en `USD`, agrega una partida y **no** toques "Precio / UOM": debe quedar en `0.00`. Escribe un número de OC del cliente y pulsa "Registrar OC". Debes ver en rojo "Falta el precio de \<código del producto\>: escríbelo en USD." y la OC no se registra (la lista de abajo sigue vacía o sin el renglón nuevo).
5. En la misma partida, escribe un precio (por ejemplo `1000`) y pulsa "Registrar OC" otra vez. Ahora sí se registra: aparece en la lista con "TOTAL" `USD 1,000.00` (o el importe que hayas capturado).
6. Ve a "Cartera" → "Estados de cuenta", abre el de un cliente con saldo en dólares y con columna "Ut. cambiaria" visible (aparece cuando hay algún ajuste por tipo de cambio). Esa columna, tanto en la fila como en "Total", debe verse con signo `$` (pesos) — nunca con `US$`, ni en el bloque de dólares ni en el de pesos. Es un número chico y pre-existente: si en tu cartera no hay ningún ajuste cambiario todavía, no hay nada que ver en este paso; el número correcto es que **nunca** diga `US$` en esa columna.
7. Con ese mismo cliente abierto, pulsa "Documento" (el papel que se manda). En la columna "Ut. cambiaria" del papel pasa exactamente lo mismo: siempre signo `$`, nunca `US$` — el papel tenía el mismo error que la pantalla y se corrigió junto.

## ESCENARIO 13 — La posición cambiaria: cuánto se debe en dólares, qué está cubierto y cuánto se mueve si sube el dólar (Decisiones 83-86, 18-sep-2026)

**El número que más importa:** con una factura del proveedor viva de **US$10,000**, una factura al cliente viva de **US$8,000** y **US$6,000** comprados en el banco, la pantalla tiene que decir **posición neta US$4,000** y **$4,000 por cada peso** que se mueva el dólar. Si el dólar sube un peso, se ganan 4,000 pesos; no 18,000 ni 24,000. Y de los US$10,000 que se deben, **US$6,000 salen como cubiertos** (los dólares que ya están comprados) y **US$4,000 como abiertos**.

**Antes de empezar:** en "Ajustes" → "Tipo de cambio" captura el dólar de hoy en **18.5**. Necesitas dos cuentas de banco: una en pesos con saldo (por ejemplo "Banorte MXN" con 200,000) y una en dólares ("Banorte USD"). Necesitas un proveedor con "Plazo de pago (días)" capturado (usa **60**) y un cliente. Y un producto con "Costo de referencia" y "Precio de lista" capturados.

### Parte A — Lo que se debe en dólares

1. Ve a "Compras" → "Alta manual". Elige el proveedor, "Moneda" `USD`, y comprueba que "Tipo de cambio" se propone solo en `18.5`, con el texto "Tabla: 18.5 … Es el TC del proveedor; corrígelo si pactaron otro." (lo toma de la tabla, no lo inventa). Captura una partida de `10` a `1000`. "Guardar orden" y luego "Confirmar".
2. Pulsa "Recibir" → "Recibir todo lo pendiente". Debes ver que nace **"FP-0001"** por **"USD 10,000.00 · TC 18.5 · $185,000.00"**. Esa es la deuda en dólares.

### Parte B — Los dólares comprados

3. Ve a "Cartera" → "Bancos". Arriba del formulario, en la fila de botones de tipo de movimiento, pulsa **"Compra de dólares"**. En "Cuenta" elige la de pesos y en "Cuenta destino (dólares)" la de dólares. El campo del importe se llama ahora **"Dólares"**: escribe `6000`. En "Tipo de cambio" escribe `18.4`. Pulsa **"Registrar compra de dólares"**. En la tarjeta de "Banorte USD" debe decir **"USD 6,000.00 · TC promedio 18.4 · $110,400.00 en pesos"**.

### Parte C — Lo que deben los clientes en dólares

4. Ve a "Ventas" → "Cotizaciones" → "Alta manual (sin solicitud)". "Moneda" `USD`, "Dólar pactado" `18.5`, "Precios" en "Contado", el cliente, `8` piezas a `1000` de precio. "Guardar cotización", luego "Ver" → elige la bodega → "Cliente aceptó → pedido" → "Confirmar" → "Entregar" → "Entregar todo lo pendiente" → "Facturar esta entrega". Debes ver **"FV-0001 · USD 8,000.00"**.

### Parte D — La pantalla

5. Ve a "Cartera" → **"Posición cambiaria"**. Arriba dice **"Corte 18/09/2026 · dólar de hoy 18.5 (tabla 18/09/2026)"**.
6. Las cuatro tarjetas de arriba deben decir, en este orden:
   - "Nos deben en dólares" **US$8,000.00**
   - "Debemos en dólares" **US$10,000.00**
   - "Dólares en caja" **US$6,000.00**, y debajo "TC promedio 18.4 · $110,400.00 en pesos"
   - "Posición neta" **US$4,000.00** en verde, con "Nos deben más de lo que debemos: si el dólar sube, se gana"
   **Ese es el número que más importa.** La posición neta es lo que nos deben más los dólares en caja, menos lo que debemos: 8,000 + 6,000 − 10,000.
7. En la tarjeta "Si el dólar se mueve", el "Movimiento supuesto (pesos por dólar)" viene en `1.00`. A la derecha debe decir **$4,000.00** en verde. Cambia el movimiento a `2` y debe decir **$8,000.00**; escribe `-1` y debe decir **−$4,000.00** en rojo. Es una simulación tuya: no se guarda ni sale de la pantalla.
8. En esa misma tarjeta, abajo: "Al dólar de hoy, lo vivo vale **$600.00** más o menos de lo que quedó registrado a su tipo de cambio pactado ($0.00 de los documentos y $600.00 de los dólares en caja)". Los 600 son de los dólares en caja: se compraron a 18.40 y hoy valen 18.50, o sea diez centavos por cada uno de los 6,000. Los documentos van en cero porque se pactaron **al mismo** tipo de cambio de hoy.
9. En la tabla "Por vencimiento": un renglón **"Hoy"** con "Nos deben" `US$8,000.00` (si además tienes un pedido en dólares confirmado y todavía sin facturar, su importe sale en "Venta comprometida", nunca sumado dos veces con la factura), y un renglón **"31-60 días"** con "Debemos" `US$10,000.00`, "Neto" `−US$10,000.00` en rojo, **"Cubierto con dólares" `US$6,000.00`** en verde y **"Abierto" `US$4,000.00`** en ámbar. Los dólares que ya están comprados tapan 6,000 de la deuda; los otros 4,000 quedan al aire.
10. En "Documento por documento": "FP-0001 · Factura del proveedor" con `−US$10,000.00`, "TC pactado" `18.5`, y "En pesos al pactado" y "En pesos al dólar de hoy" iguales ($185,000.00), "Diferencia" `—`. Y "FV-0001 · Factura al cliente" con `US$8,000.00`. Pulsa **"Exportar Excel"**: baja un archivo con esos mismos renglones.

### Parte E — Los candados de tipo de cambio

11. Ve a "Ajustes" → "Tipo de cambio" e intenta guardar un renglón con `1` (o con `0.05`). Debe rechazarlo con **"El tipo de cambio USD→MXN tiene que ser mayor que 1 (pesos por dólar)."** Antes se veía guardado y después detenía en silencio cotizar, recibir y facturar. El camino legítimo es capturar el dólar de verdad, como `18.5`.
12. Ve a "Cartera" → "Gastos". En "Forma de pago" deja **"Contado"** y en **"Sale de la cuenta"** elige la cuenta **en dólares**. Aparece un campo nuevo, "Tipo de cambio del gasto (cuenta en dólares)", **ya con 18.5 propuesto de la tabla**. En "Importe" escribe `5000`: debajo del campo debe decir **"Saldrían US$270.27."** Pulsa "Registrar gasto". En "Bancos", la cuenta en dólares baja **US$270.27**, no 5,000. Antes de esto, ese mismo gasto sacaba **5,000 dólares**.
13. Candado — borra el tipo de cambio (déjalo en `0`) y vuelve a pulsar "Registrar gasto". Debe detenerse con **"Sin tipo de cambio para el gasto pagado desde Banorte USD…"** y no registrar nada. El camino legítimo es el paso 12: el número que propone la tabla, o el que te haya dado el banco.

### Parte F — La tarjeta del inicio

14. Ve al inicio (el logotipo de arriba a la izquierda). Debe haber una tarjeta **"Exposición neta USD"** con el mismo número que la pantalla — si la pantalla dice US$4,000.00, la tarjeta dice US$4,000.00 — y debajo "Dólar de hoy 18.5 · $4,000.00 por cada peso que se mueva". Si los dos números no coinciden, avísame: salen del mismo lugar y no deberían poder diferir.

**Quién la puede ver:** "Posición cambiaria" vive dentro del permiso de **Bancos**. Quien no tenga Bancos no ve la pantalla ni la tarjeta del inicio. La parte de "Si el dólar se mueve" y la revaluación piden además permiso de ver márgenes (administrador, gerencia y administración): un usuario de Bancos sin eso ve los dólares y las cubetas, pero no el resultado en pesos.

### Parte G — La devolución no inventa exposición

15. Vuelve a "Ventas" → "Pedidos de venta", abre PV-0001 y baja a "Devolución del cliente". En "A devolver" escribe `2`, en "Motivo" `No ocupó` y pulsa "Registrar devolución". En "Facturas de este pedido" la factura queda en **"FV-0001 · USD 6,000.00 · open"** y nace **"NC-0001 · USD 0.00 · paid"**.
16. Vuelve a "Posición cambiaria". "Nos deben en dólares" debe decir **US$6,000.00**, y en "Por vencimiento" la columna "Venta comprometida" del renglón "Hoy" debe seguir en `—`. **Ese es el punto:** la nota de crédito bajó la factura, y no reapareció como "pedido sin facturar" por los 2 que el cliente devolvió. Lo mismo vale si se revierte una entrega. Si ves un pedido "sin facturar" por una cantidad que ya se devolvió o que se revirtió, avísame.

**Lo que esta pantalla NO hace, a propósito:** no dice cuáles dólares de la caja se compraron para cuál orden. En el banco los dólares son una bolsa sola, sin etiqueta, así que la cobertura con dólares se mide a nivel empresa y por cubeta, nunca por pedido. Lo que sí se deriva pedido por pedido es la otra dinámica, la de pactar el tipo de cambio en las dos puntas: eso sale en la tabla "Por negocio".

## ESCENARIO 14 — Lo que cuesta de más pagarle al proveedor ya baja la utilidad del pedido; y la mercancía nunca entra sin cuenta por pagar (Decisiones 87-89, 18-sep-2026)

**Los dos números que más importan:** (1) una compra de **10,000 dólares** pactada a **18.00** y pagada a **18.50** cuesta **$5,000 pesos** de más, y esos $5,000 tienen que **bajar la utilidad de ese pedido** — antes el sistema los registraba y nadie los veía nunca. (2) Si recibes una orden **en dos viajes**, tienen que nacer **dos facturas del proveedor**, una por viaje. Antes nacía solo la del primero: la mercancía del segundo entraba a la bodega **sin que nadie te la cobrara en el sistema**.

**Antes de empezar:** el dólar de hoy capturado en "Ajustes" → "Tipo de cambio" (usa **18.5**), un proveedor con "Plazo de pago (días)" capturado, un cliente, un producto con costo y precio, y las dos cuentas de banco (una en pesos con saldo, una en dólares).

### Parte A — La mercancía nunca entra sin cuenta por pagar

1. Ve a "Compras" → "Nueva orden". Elige el proveedor, "Moneda" `MXN`, y captura una partida de **10** piezas a `1000`. "Colocar orden".
2. Pulsa "Recibir". En el cuadro escribe **6** y pulsa **"Recibir lo capturado"**. Debes ver que nace **"FP-0001"**, y la orden sigue en **"Por recibir"** (le faltan 4).
3. Pulsa "Recibir" otra vez y ahora pulsa **"Recibir todo lo pendiente"**. Debes ver que nace **"FP-0002"** y la orden pasa a **"Recibida"**.
4. **Éste es el punto.** Ve a "Cartera" → "Por pagar". Tienen que estar **las dos facturas**: FP-0001 por **$6,000.00** y FP-0002 por **$4,000.00** — los $10,000 completos. Antes de este cambio solo aparecía la primera, por $6,000, y las otras 4 piezas quedaban en la bodega sin deuda: el inventario decía $10,000 y las cuentas por pagar $6,000. Si ves una sola factura, avísame.
5. Ve a "Almacén" → "Inventario" y confirma que el producto tiene **10** de existencia. Inventario y cuentas por pagar dicen lo mismo.

### Parte B — Lo que cuesta de más pagarle al proveedor baja la utilidad

6. Ve a "Compras" → "Nueva orden", el mismo proveedor, "Moneda" `USD`. En "Tipo de cambio" **cámbialo a `18`** (el que pactaste con él; la tabla propone 18.5). Captura **10** piezas a `1000`. "Colocar orden" y "Recibir" → "Recibir todo lo pendiente". Nace una factura de **"USD 10,000.00 · TC 18 · $180,000.00"**.
7. Ahora vende de ese inventario, **ligando la venta a esa compra**: ve a "Ventas" → "Cotizaciones" → "Alta manual (sin solicitud)", moneda `MXN`, elige el cliente, 10 piezas, guarda, pulsa "Ver" y "Cliente aceptó → pedido"; confirma, entrega y factura la entrega.
8. Abre el pedido y baja a la tarjeta de utilidad. **Apunta el número de "Utilidad final".**
9. Ve a "Cartera" → "Por pagar", encuentra la factura del proveedor y págala: en "Bancos", "Pago", cuenta **en pesos**, "Aplicar a factura" esa FP, "TC del pago" **`18.5`**, importe completo. El sistema te dirá "Diferencial TC: pérdida cambiaria 5,000.00".
10. Vuelve al pedido. En el párrafo debajo de la tarjeta debe decir **"Diferencial cambiario (pago al proveedor): −$5,000.00"**, y la **"Utilidad final" tiene que haber bajado exactamente $5,000** respecto al paso 8. Pagaste 18.50 lo que habías pactado a 18.00, por diez mil dólares: cinco mil pesos que antes no se veían en ningún lado.
11. Si el cliente te hubiera pagado a ti en dólares y a otro tipo de cambio, ahí mismo aparecería el otro renglón: **"Diferencial cambiario (cobro al cliente)"**. Son dos cosas distintas y por eso salen con apellido: uno es lo que te pasó cobrando, el otro lo que te pasó pagando.
11b. Ve a "Reportes" → el bloque de **Panorama**. La tabla tiene ahora dos columnas separadas, **"Dif. TC cobro"** y **"Dif. TC pago"**, y los −$5,000 tienen que salir en la segunda. **Compruébalo sumando el renglón:** Venta + Mora + Dif. TC cobro + Dif. TC pago − Costo prov. − Comisión − Capa 1 − Capa 2 − Descuento tiene que dar exactamente la "Utilidad". Si no cuadra, avísame: es la señal de que algo entra a la utilidad sin columna que lo explique.

### Parte C — El pedido que no se puede juzgar

12. Levanta un pedido de venta **sin cotización** ("Ventas" → "Pedidos de venta" → "Nuevo pedido"), surtiéndolo del inventario que ya tienes, y entrégalo y factúralo.
13. Abre ese pedido. Debajo de la tarjeta de utilidad debe decir: **"Este pedido no tiene una orden de compra ligada: se surtió de inventario o su orden se levantó por separado…"**, y mandarte a "Cartera" → "Posición cambiaria". **Eso es a propósito:** la mercancía salió de una bolsa común y no hay forma honesta de decir qué parte de aquella pérdida cambiaria le toca a este pedido en particular. Antes de inventar un número, el sistema prefiere decirte por qué no lo tiene. Si algún día quieres que sí se reparta, dímelo y lo definimos.

### Parte D — El dinero a tu favor que no se veía

14. Repite el paso 9 pero al revés: paga una factura del proveedor en dólares a un TC **más bajo** que el pactado (por ejemplo, pactaste 18.5 y pagas a 18.00) y elige el tratamiento **"Ajustar al pactado"**. Nace un documento de ajuste a **tu favor** contra ese proveedor.
15. Ve al inicio y mira el bloque de lo que vence por pagar. Ese ajuste a tu favor debe estar **restando** de lo que le debes a ese proveedor. Antes no aparecía en ningún total del sistema: era dinero a tu favor invisible.

## ESCENARIO 15 — Cuando compras en dólares y vendes en pesos, el sistema te dice cuánto te puede costar (Decisión 90, 19-sep-2026)

**El número que más importa:** si compras **US$10,000** con el dólar en **17.50** y le cotizas al cliente en pesos, la pantalla tiene que decirte que **por cada peso que se mueva el dólar, tu utilidad se mueve $10,000** — de $43,750 a $33,750 si sube uno. Ese número no estaba en ningún lado: te enterabas cuando pagabas.

**Antes de empezar:** el dólar de hoy en "Ajustes" → "Tipo de cambio" en **17.5**, la "Política de crédito" completa, un cliente y un proveedor.

1. Ve a "Ventas" → "Solicitudes" → "Nueva". Elige el cliente, busca el producto y pon **10** de cantidad. "Registrar solicitud".
2. En "A quién se pide cotización", marca a tu proveedor. **Antes de pulsar el botón**, fíjate en el selector nuevo que dice **"Les pides precio en"** y cámbialo a **USD** — así le estás pidiendo el precio en dólares. Pulsa "Armar lista a proveedores".
3. En "Comparativa", en la columna de tu proveedor escribe **1000** y pulsa **"Usar este"**. El renglón se pone verde con "Ganador".
4. Baja a "Cotización al cliente". En "Costo puesto" debe decir **$17,500.00** y abajo **"proveedor en USD × TC 17.5"**: mil dólares convertidos con el dólar del día.
5. En "Moneda" elige **MXN** — le vas a cotizar en pesos. En "Plazo días" escribe `0` (contado, para que la cuenta sea sencilla). En "Margen contado" escribe **20**.
6. Debe salir precio **$21,875.00**, utilidad **$4,375.00 por litro · total $43,750.00 (20.0%)**, importe **$218,750.00**.
7. **Éste es el punto.** Justo debajo de la tabla tiene que aparecer un recuadro ámbar que diga:

   > El costo de esta cotización es en dólares: USD 10,000.00 al tipo de cambio 17.5 — y le estás cotizando en pesos.
   > Por cada peso que se mueva el dólar antes de pagarle al proveedor, tu utilidad se mueve **$10,000.00** — de $43,750.00 a **$33,750.00** si sube un peso. Lo absorbe Azagro: el cliente compró un precio en pesos y este riesgo nace de pagarle al proveedor en dólares, no de la venta.
   > Si lo vas a **cubrir** —pactándole el tipo de cambio al proveedor, o comprando los dólares— no hay nada que hacer aquí. Si lo vas a dejar abierto, súbele el margen o el tipo de cambio arriba: el sistema no lo hace solo porque nadie sabe dónde va a estar el dólar.

8. **Prueba que el aviso sabe cuándo callarse:** cambia "Moneda" a **USD**. El recuadro tiene que **desaparecer**. Cotizando en dólares el precio viaja con el tipo de cambio y el riesgo es del cliente, no tuyo — es lo que ya habías decidido. Regrésalo a MXN y el aviso vuelve.
9. **Prueba el candado de la moneda de la lista:** con el precio del proveedor ya capturado, el selector "Les pides precio en" tiene que estar **bloqueado**, con el texto "Ya hay precios capturados: la moneda de la lista se queda". Cambiarla después movería un costo que ya se convirtió a pesos.

**Lo que el sistema NO hace, y es a propósito:** no te sugiere cuánto colchón ponerle al precio, ni le mete uno solo. El costo del dinero sí se mete solo en el precio porque hay una tasa y hay días; dónde va a estar el dólar en un mes no lo sabe nadie, y si el sistema lo adivinara, tu precio y tu margen reportado quedarían construidos sobre esa adivinanza — además de encarecerte las cotizaciones en las que ibas a comprar los dólares de todos modos. El número te lo pone enfrente; el colchón lo pones tú, subiendo el margen o el tipo de cambio.

## ESCENARIO 16 — Cuánto te costó el dólar este mes, por los dos lados (Decisión 91, 19-sep-2026)

**El número que más importa:** si compras **US$10,000 a 17.00** ($170,000) y con ellos le pagas al proveedor una factura que habías pactado a **17.50** ($175,000), **ganaste $5,000** — y el reporte tiene que decirlo. Antes decía **cero**, porque ese día no hubo ninguna conversión: salieron dólares y ya. La ganancia estaba escondida en lo que te habían costado los dólares.

**La idea, en una frase:** los dólares de tu cuenta funcionan como la mercancía de la bodega. Tienen un costo promedio, y cuando salen, salen a ese costo. Lo que valieron al usarse menos lo que costaron es tu ganancia o tu pérdida.

**Antes de empezar:** el dólar de hoy en Ajustes, una cuenta en pesos con saldo, una cuenta en dólares, un proveedor con "Plazo de pago (días)" capturado.

### Parte A — La mitad que ya existía: pagas con pesos lo que debías en dólares

1. Ve a "Compras" → "Nueva orden". Proveedor, "Moneda" `USD`, y en "Tipo de cambio" **corrígelo a `17.5`** (el que pactaste). Una partida de **10** a `1000`. "Colocar orden" → "Recibir" → "Recibir todo lo pendiente". Nace la factura por **"USD 10,000.00 · TC 17.5 · $175,000.00"**.
2. Ve a "Cartera" → "Bancos" → "Pago". Cuenta: la de **pesos**. "Aplicar a factura": esa factura del proveedor. "TC del pago": **`18.5`**. Registra el pago completo.
3. Ve a "Reportes". En el bloque **"Lo que costó el dólar"**, el recuadro de la izquierda —**"Al pagar en pesos lo que se debía en dólares"**— debe decir **−$10,000.00**: pactaste a 17.50 y pagaste a 18.50, por diez mil dólares.
4. En la tabla de abajo tiene que aparecer el renglón, con "Costó **17.5**", "Valió **18.5**" y "Diferencia **−$10,000.00**".

### Parte B — La mitad nueva: usas dólares que ya tenías

5. Ve a "Bancos", tipo de movimiento **"Compra de dólares"**: de la cuenta de pesos a la de dólares, **6000** dólares al tipo de cambio **`17`**. Registra. La tarjeta de la cuenta en dólares debe decir **"USD 6,000.00 · TC promedio 17 · $102,000.00 en pesos"**.
6. Levanta otra orden de compra igual (USD, TC `17.5`, 6 piezas a 1000), recíbela, y págala desde la **cuenta en dólares** esta vez. Fíjate que aquí el sistema no te pide tipo de cambio: son dólares contra dólares.
7. Vuelve a "Reportes". El recuadro de la derecha —**"Al usar dólares que ya se tenían"**— debe decir **+$3,000.00**: seis mil dólares que te costaron 17.00 y que usaste valiendo 17.50, cincuenta centavos cada uno. **Ése es el número que antes no existía.**
8. En la tabla, el renglón dice "Salieron **US$6,000.00**", "Costó **17**", "Valió **17.5**", "Diferencia **+$3,000.00**".

### Parte C — Que no se cuente dos veces

9. Arriba de todo, el número grande de **"Lo que costó el dólar"** debe ser la suma de los dos recuadros: **−$10,000 + $3,000 = −$7,000.00**. Ni un peso repetido: son dos hechos distintos, uno en cada camino de pago.
10. Debajo de la tabla hay una nota que explica por qué esto **no cuadra** contra "Compras" del mismo mes. No es un error: la compra se registra el día que llega la mercancía, al tipo de cambio pactado; esto ocurre el día que sale el dinero, que casi siempre es otro mes.

### Parte D — Los casos donde el sistema prefiere callar

11. **Vender dólares que venían del saldo inicial.** Si tu cuenta en dólares arrancó con un saldo capturado a mano (sin tipo de cambio), esos dólares no tienen con qué compararse. Al usarlos, el reporte **no inventa una ganancia**: los deja fuera y te dice al pie cuántos dólares salieron sin costo conocido.
12. **Revertir un cobro en dólares.** Revertir no es usar: el reporte no debe registrar ninguna ganancia por una reversa, y el promedio de la cuenta tiene que quedar como si el cobro nunca hubiera entrado.
13. **Mover dólares entre dos cuentas en dólares.** Son los mismos dólares cambiados de lugar: la diferencia tiene que ser **cero**. Si ves una ganancia ahí, avísame.

### Parte E — Que el «Resultado» del periodo cuadre

14. Arriba, en las tarjetas del P&L, debe aparecer una tarjeta **"Diferencial cambiario"**. Con el ejemplo de arriba dice **−$7,000.00**, y debajo, si algo quedó como ajuste, cuánto.
15. **Comprueba la suma a mano:** Ventas − Compras − Flete − Gastos operativos − Gastos financieros + Mora + Diferencial cambiario tiene que dar exactamente el **"Resultado"**. Si no cuadra, avísame: significa que algo entra al resultado sin tarjeta que lo explique, y ése es justo el error que estábamos corrigiendo.
16. **El caso del ajuste.** Paga una factura en dólares con pesos a otro tipo de cambio y esta vez elige **"Ajustar al pactado"** en vez de dejarlo como utilidad. Vuelve a Reportes: el bloque "Lo que costó el dólar" **sí** lo cuenta en su total, pero la tarjeta "Diferencial cambiario" y el "Resultado" **no** — y el texto lo dice: eso es cartera, todavía lo puedes cobrar, no es una pérdida. Es la misma regla que ya usabas en tu Excel.
17. **El conteo de facturas.** Registra una devolución. En "Ventas facturadas", el importe tiene que **bajar** (correcto: devolviste mercancía), pero el conteo de abajo, "N facturas producto", **no debe subir**: una nota de crédito no es una venta más. Antes sí subía.
18. **Que un mes cerrado no cambie.** Apunta el "Resultado" del mes en curso. Ahora revierte el pago del paso 16 (en "Bancos", el botón "Revertir" del movimiento). Vuelve a Reportes con **el mismo rango de fechas**: el Resultado tiene que ser **el mismo de antes**. Un mes ya cerrado no se mueve porque después deshagas algo — la reversa cuenta en el mes en que la haces, no hacia atrás. Si el número cambió, avísame: es el error más grave que puede tener este reporte.
19. **El inicio también cuadra.** Ve al inicio. En el bloque del mes debe aparecer un renglón "Diferencial cambiario" junto a "Utilidad neta", con el mismo número que la tarjeta de Reportes.

**Quién lo puede ver:** el bloque vive en Reportes, que pide permiso de cartera y de ver márgenes — administrador, gerencia y administración. No es un número por vendedor: es de toda la empresa.

## ESCENARIO 17 — La mora no se movió ni un centavo (N1, Decisión 5, 19-sep-2026)

**Léelo antes de probar, porque cambia qué hay que mirar.** Este cambio NO
agrega nada que puedas ver. Arregla una tubería que todavía no lleva agua: la
mora de un documento del circuito **Línea Santa Rosa** se calculaba con la
tabla de tasas equivocada. Ese circuito está en el catálogo pero **apagado** —
hoy solo puedes elegir Contado y Circuito ASR, así que en tu base no existe
ningún documento al que le tocara. El arreglo es para el día que lo
enciendas; hasta entonces, lo único que importa es que **nada de lo que sí
usas haya cambiado**.

**El número que más importa:** una factura vencida a crédito tiene que
facturar **exactamente la misma mora que facturaba ayer**. Si cambió un
centavo, algo se rompió.

**Antes de empezar:** una factura de venta a crédito, ya vencida, con la TIIE
capturada en Ajustes para la fecha de su plazo financiero. Si vienes del
Escenario 3, sirve esa.

1. Ve a "Cartera" → "Estado de cuenta" y elige el cliente. Anota, del renglón
   de esa factura, los tres números tal cual: **"Días vencidos"**,
   **"Interés s/ días"** y **"Total int + FEGA"**. Escríbelos en un papel.
2. Ve a "Cartera" → la pestaña de facturas, abre esa factura y pulsa el botón
   **"Mora"**. En el recuadro que aparece antes de confirmar, el interés tiene
   que ser **el mismo número que anotaste** en el paso 1.
3. Confirma. Nace la factura de interés (FI). Ábrela: la fórmula guardada debe
   decir **"TIIE X.XX% vigente al …"** con la misma tasa que tienes capturada
   en Ajustes → "Tabla TIIE". **No** debe decir otra tasa, ni mencionar la
   "Tabla de tasas (costo / cobro)": esa es la del circuito que está apagado.
4. Ve al inicio. El recuadro de lo que está vencido tiene que seguir diciendo
   los mismos pesos que antes de este cambio.

### La parte que sí es nueva, y por qué no la puedes probar todavía

5. Ve a "Ajustes". Vas a ver **dos** tablas de tasas: "Tabla TIIE" (una sola
   columna) y "Tabla de tasas" (dos columnas, costo y cobro). **Las dos se
   capturan a mano y nada las amarra.** Hasta hoy, el precio de un documento
   Línea Santa Rosa salía de la segunda y su mora de la primera: dos tasas
   distintas gobernando el mismo documento. Ahora cada documento usa de punta
   a punta la tabla de la que salió su precio.
6. Si algún día enciendes Línea Santa Rosa y se te olvida capturar un renglón
   en "Tabla de tasas", el sistema **no** va a rellenar con la TIIE: se
   detiene y te dice, con esas palabras, que captures en **"Tabla de tasas
   (costo / cobro)"**. Antes te habría cobrado con el número equivocado sin
   avisar.

**Lo que todavía NO se prueba aquí:** nada del circuito Línea Santa Rosa, que
sigue apagado. Cuando se encienda, esa prueba se escribe entera.

## Qué no va a poder hacer (para que no pierdas tiempo buscándolo)

Esto no está construido todavía. No es que lo estés haciendo mal — no
existe. Si lo necesitas seguido, dímelo para priorizarlo.

- **Cancelar cualquier documento** (pedido, orden de compra, cotización, factura). Si capturaste algo por error, no hay botón de cancelar en ningún lado — hoy se corrige a mano en la base de datos.
- **Revertir un pago o un cobro capturado por error.** Una vez aplicado, se queda aplicado. No hay un "deshacer".
- **Entregar o recibir una parte de un pedido/orden.** Si el proveedor manda 15 de las 25 toneladas, el sistema no tiene manera de registrar "recibí solo una parte" — o recibes/entregas todo, o nada.
- **Devolver mercancía a un proveedor** ni generarle una nota de crédito. Solo existen devoluciones de cliente.
- **Lotes ni fecha de caducidad.** El sistema no sabe de qué lote es cada tonelada ni cuándo vence.
- **Más de una unidad de medida por producto** (por ejemplo, comprar en tonelada y vender en litro). Cada producto tiene una sola unidad fija.
- **Un flete que se reparte entre varios productos de un mismo viaje capturado como un solo monto.** El flete se captura producto por producto, no como un total del viaje a repartir solo.
- **Dar de baja o desactivar un cliente, proveedor o producto** que ya no uses — se quedan siempre visibles en las listas.
- **Alta, edición o cierre de una cuenta de banco desde pantalla.** Las cuentas de banco están fijas en el sistema; para cambiarlas hace falta pedirlo aparte.

---

## Lo que encontré al probar

Ve anotando aquí lo que veas mientras recorres los escenarios de arriba, con
el escenario y el paso donde lo notaste, para que se pueda revisar después.

### No funciona (algo que debería pasar y no pasó)

-
-
-

### Me estorba (funciona, pero de forma incómoda o confusa)

-
-
-

### Me falta (algo que necesito y no está, aparte de lo ya listado arriba)

-
-
-
