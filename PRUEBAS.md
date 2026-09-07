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
