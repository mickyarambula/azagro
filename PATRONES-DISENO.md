# Patrones de diseño de Cosecha

Este documento acompaña a `METODOLOGIA-TRABAJO.md`. Aquel describe **cómo se trabaja**; este describe **cómo se diseña**.

Son los patrones que se repiten en todo el sistema y que le dan consistencia. No son reglas del negocio de producto fresco: son formas de resolver problemas que se repiten en cualquier ERP. Tropicalízalos al negocio que toque, pero no los reinventes cada vez — el valor está en que se repitan.

---

## A. Datos

### A1. Congelado vs vivo

Un documento emitido **no se recalcula**. Al emitirlo, sus montos se copian a tablas hermanas de snapshot, y el documento impreso lee de ahí. Reimprimirlo devuelve exactamente lo mismo, aunque los datos vivos hayan cambiado después.

En Cosecha: la liquidación al productor congela cabecera, lotes, gastos, mermas y disposiciones en cinco tablas hermanas. La pantalla de cálculo muestra lo vivo; el PDF muestra lo congelado.

**El error que hay que evitar:** que una pantalla muestre el número vivo mientras el documento impreso muestra el congelado. El productor abre su liga y ve una cifra distinta a la de su papel. Eso pasó en Cosecha y se arregló en un bloque completo.

### A2. Documento padre y documentos hijos

Cuando hay que corregir un documento emitido, **no se edita: nace un hijo colgado del padre**.

El patrón completo:
- El hijo guarda el `id` del padre
- El folio del hijo se deriva del padre (`LIQ-004-C1`), no toma número propio
- Hay tope: la suma de los hijos vivos no puede pasar de lo que dice el padre
- No se puede cancelar el padre si tiene hijos vivos
- El hijo tiene su propia cancelación

En Cosecha: la nota de crédito cuelga de la factura, la liquidación complementaria cuelga de la liquidación. Mismo patrón, dos módulos distintos.

### A3. Marcar, nunca borrar

Nada que ya pasó se borra. Se marca.

- `cancelled_at` en lugar de eliminar la fila
- `is_active` para sacar algo de los selectores sin perder el historial
- Una acción deshecha queda **tachada con la palabra "cancelada"**, no desaparece

Consecuencia: cada lectura tiene que decidir si filtra lo cancelado o no, y esa decisión es de negocio. En Cosecha, ocho lecturas filtran las ventas canceladas y **una no lo hace a propósito** — la que compara lo congelado contra lo vivo, porque necesita que sigan coincidiendo. Esa lectura lleva un comentario en el código explicando por qué es distinta, para que nadie la "empareje".

### A4. Series de folio

Cada tipo de documento tiene su prefijo y su contador. Los prefijos **nunca cambian**. Un contador por serie, con el prefijo completo.

El error clásico: un contador global que se rompe cuando aparece un tipo de documento nuevo. En Cosecha pasó — después de la primera nota de crédito ya no se podía facturar.

### A5. Quién absorbe

Cuando un costo o una pérdida puede ser de una parte o de la otra, el patrón es siempre el mismo:

- Un campo con dos valores (`grower` / `plein`)
- **Motivo obligatorio en texto libre**
- **Sin valor por default** cuando la causa varía caso por caso
- El monto se congela en el documento

Se repite en gastos, en merma de reempaque, en notas de crédito. La misma forma en tres lugares distintos.

**Cuándo NO poner default:** si la respuesta correcta depende de la causa y no del tipo de evento. Miguel lo dijo así: *"siempre va a variar según se negocien las cosas."* Entonces se captura cada vez.

### A6. Todo lo recibido se rinde

Si el sistema recibe cien unidades, tiene que poder decir dónde quedaron las cien. Cada unidad cae en exactamente una casilla, y el documento imprime el cuadre:

```
recibidas = vendidas + merma + reempacadas + destruidas + compradas + pendientes
```

Y hay un candado: **si quedan unidades sin clasificar, no se emite el documento.**

Este patrón sirve para cualquier cosa que entra y sale: inventario, dinero, horas, lo que sea. Lo que importa es que no exista la casilla "y lo demás no sé".

### A7. Linaje y falla visible

Cuando algo nace de otra cosa (un lote reempacado, un documento derivado), el linaje se resuelve **subiendo la cadena**, con dos protecciones:

- Tope de saltos y detección de ciclos
- **Si la cadena no se resuelve, error visible que nombra qué no pudo resolver.** Nunca caer a un valor por default.

Un sistema que adivina cuando no sabe es peor que uno que se para.

### A8. Migraciones aditivas

Tablas nuevas y columnas nullable. Cero drops, renames o cambios de tipo.

Cuando de verdad hace falta una excepción (en Cosecha fue reemplazar un índice único), el procedimiento es:
1. Se pide con argumento, explicando por qué la alternativa aditiva es peor
2. Se demuestra con números que ninguna fila existente la viola
3. **Se ordena para fallar seguro:** primero se crean los objetos nuevos, y solo cuando ya existen se quita el viejo. Si algo está mal, la transacción muere antes de quitar la protección.
4. Se prueba el caso de falla a propósito

---

## B. Pantalla

### B1. Si un botón no hace algo real, no se pone

Si marcar una opción no mueve nada, o se le da consecuencia o se quita. En Cosecha había un caso: marcar que Plein absorbía la merma no movía dinero. O el productor cobraba esas unidades, o el botón sobraba.

### B2. Los mensajes dicen qué pasó y qué hacer

Con números concretos y con el camino de salida nombrado.

Mal: *"No se puede editar este gasto."*

Bien: *"El gasto EXP-012 (Fletes) ya se le rindió al productor en LIQ-004 por $1,200.00: no se edita. Si faltó cobrar, captura un gasto nuevo por la diferencia; entra a la siguiente cuenta complementaria."*

El mensaje no le pide al usuario que explique nada ni que "avise". Le dice a dónde ir.

### B3. Candado con salida

Para cada acción bloqueada tiene que existir un camino legítimo, y el mensaje tiene que nombrarlo. **Un candado sin salida es peor que el bug que tapa**, porque el bug es silencioso y el candado deja al usuario parado.

Y la prueba tiene que verificar **las dos cosas**: que el bloqueo aparece, y que el camino que nombra funciona de verdad.

### B4. Advertencia sin bloqueo cuando la decisión es del usuario

Si el sistema no puede saber cuál es la respuesta correcta pero sí puede detectar que algo se ve raro, **avisa y deja pasar** — con casilla de confirmación si el riesgo es alto.

En Cosecha: si capturas un precio a mano que se aleja más de 50% del promedio realizado, sale el aviso **con el número de referencia** y hay que marcar "Revisé el precio y quiero continuar". Y si no hay ninguna venta contra la cual comparar, **no hay aviso**: no se inventa una referencia.

Otro caso: antes de cancelar una venta que ya se le rindió y se le pagó al productor, sale un aviso que explica exactamente qué va a pasar. No bloquea. La decisión es del usuario; el sistema solo se asegura de que la tome sabiendo.

### B5. Armar y confirmar

Las acciones de un clic que hacen algo grande **piden confirmación en el mismo botón**: el primer clic arma y pregunta con números ("¿Mandar las 90 cajas de 1-PAP-1 a pendiente de venta?"), el segundo ejecuta. Si el usuario pica en otro lado, se desarma solo.

Sin modal aparte. Es el mismo botón cambiando de estado.

### B6. Validación en servidor y en pantalla, las dos

La pantalla impide llegar al error (filtra la lista, apaga el botón). El servidor rechaza igual si llega por otro camino. **Los dos candados, no uno.** La pantalla es comodidad; el servidor es la garantía.

### B7. Buscador cuando la lista es larga

Un `select` nativo con 147 opciones no es un selector, es una trampa. En Cosecha causó un error de datos real: se eligió el producto equivocado porque dos códigos se parecían al saltar con el teclado.

Y el buscador filtra por **código y por nombre**, no solo por nombre.

### B8. El documento se lee solo

Un documento que solo se entiende teniendo otro a la mano no sirve. Si es un documento complementario, trae:
- Encabezado con el folio del padre y lo que ya se cubrió
- El periodo exacto que abarca
- El detalle línea por línea, con su referencia (orden, factura, cliente, fecha)
- El cuadre al final

---

## C. Configuración

Cosecha separa la configuración en tres capas distintas. Confundirlas es la causa más común de que un ERP se sienta incoherente.

### C1. Ajustes de comportamiento

Interruptores y valores que cambian cómo se comporta el sistema. Viven en Configuración y son pocos.

Ejemplos: "Incluir gastos en el punto de equilibrio", "Días para cerrar automáticamente lotes en 0", "Plazo default de cliente".

### C2. Catálogos vivos

Listas que el usuario administra desde pantalla, **sin migración**. Se agregan y se archivan, nunca se borran.

Ejemplos: conceptos de gasto, ubicaciones, productos, SKUs, motivos de baja, departamentos.

**Regla que salió de un error:** si un catálogo es editable, el código **no puede tener sus valores escritos a mano**. En Cosecha, el estado de resultados tenía los nombres de las categorías de gasto escritos dentro del cálculo. Al traducir el catálogo, cuatro categorías se habrían ido al cajón genérico sin que nadie lo notara. Y dos conceptos llevaban meses cayendo mal por lo mismo.

Si el código necesita reconocer un valor del catálogo, esa relación va en una **tabla de mapeo**, no en el código.

### C3. Mapeos

La tabla que conecta un catálogo con otro. Es lo que hace que el usuario pueda cambiar sus catálogos sin que se rompa la contabilidad.

En Cosecha: cada concepto de gasto mapea a una cuenta contable, en una pantalla donde el usuario elige. Cambiar el nombre del concepto no rompe nada porque la relación vive en el mapeo, no en el nombre.

### C4. Datos de prueba borrables

Una función en la propia app que borra todo lo capturado de prueba y **respeta el corte inicial**. Se corre al final de cada prueba y luego se verifican las anclas.

Cada tabla nueva con llave foránea entra al borrado, en el orden correcto. Esto se actualiza en el mismo bloque que crea la tabla, nunca después.

### C5. Nombres

- **Interfaz en el idioma del usuario. SQL, columnas y código de servidor en inglés.**
- Los catálogos que se imprimen en documentos que ve un tercero (cliente, proveedor) van en el idioma del documento. En Cosecha había motivos y categorías en inglés saliendo impresos en cuentas en español.

---

## D. Dónde poner cada cosa

Un patrón que costó encontrarlo: **la pantalla vive donde el usuario la busca, no donde encajó al construirla.**

En Cosecha, el catálogo de ubicaciones (dónde está parada la fruta) vive bajo "Órdenes → Rutas de entrega", porque nació como catálogo de destinos de envío. Miguel lo buscó en Almacén, en Configuración y en Inventario antes de encontrarlo. Es el mismo dato con dos usos, y quedó archivado bajo el uso equivocado.

Cuando una pantalla sirve a dos módulos, se decide **por dónde la va a buscar quien la usa todos los días**, no por dónde nació.

---

## E. Lo que no se hace

- No se borra información histórica.
- No se adivina cuando falta un dato: se falla visible.
- No se inventan datos de catálogo para "probar" y se dejan en producción. En Cosecha quedaron una dirección falsa en el membrete, un destino de cliente inventado y cuatro ubicaciones que no existen. Todos salieron impresos o en pantalla frente al usuario.
- No se pone un botón que no hace nada.
- No se mete una mejora que nadie pidió sin preguntar antes.
- No se cierra un camino sin abrir otro.
