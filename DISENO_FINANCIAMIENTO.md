# Diseño del circuito de financiamiento

Documento de referencia. Todo lo que se construya sobre financiamiento, líneas de
crédito y circuito con Almacenes Santa Rosa se revisa contra este documento.

Estado: borrador para revisión. Las decisiones abiertas están marcadas al final.

---

## 1. Para qué existe este documento

Azagro vende insumos agrícolas a crédito. No tiene línea de crédito propia todavía,
así que el financiamiento a clientes pasa por Almacenes Santa Rosa, empresa hermana
que sí tiene líneas.

El esquema anterior (circuito con doble facturación) se abandonó porque inflaba los
ingresos de Azagro y pegaba fiscalmente. El esquema nuevo es lineal.

Este documento fija cómo funciona, qué documentos se generan, qué cuentas se llevan
y qué se congela. Existe para que lo que se construya tenga una sola lógica y no
termine parchado.

---

## 2. Los tres principios

Estas tres reglas aplican a todo. Cada cosa nueva que se construya debe respetarlas.

**Congelar al confirmar.** Todo lo que afecta dinero se copia al documento cuando se
confirma. Una factura no dice "usa la política Grupo SL", dice "mora TIIE+9%, comisión
sí, FEGA sí". Guardado adentro, para siempre. Esto es lo que permite editar
parámetros y políticas sin mover documentos ya emitidos.

**Un solo lugar decide cada número.** Ningún valor de negocio se escribe en el código.
Todo viene de Ajustes o de su tabla. Si falta, el sistema se detiene y avisa; nunca
inventa.

**El circuito es un dato de la operación.** Cada pedido declara por dónde corre. Así
conviven los distintos esquemas sin condicionales regados por el sistema.

---

## 3. Los circuitos

Cada pedido nace declarando su circuito. No todos los clientes van por el mismo.

| Circuito | Quién financia | Quién factura al cliente | Estado |
|---|---|---|---|
| Contado | Nadie | Azagro | Existe hoy |
| Línea Santa Rosa | Santa Rosa | Santa Rosa | Por construir |
| Línea propia | Azagro | Azagro | Cuando llegue la línea |

Los tres deben poder convivir. Cuando Azagro tenga línea propia, no va a alcanzar
para todo, así que va a haber operaciones por las dos vías al mismo tiempo.

---

## 4. El recorrido, paso a paso

Circuito Línea Santa Rosa. Los pasos que ya existen en el sistema van marcados.

| # | Qué pasa | Documento | ¿Existe? |
|---|---|---|---|
| 1 | Cliente pide, Azagro arma la solicitud | SOL | Sí |
| 2 | Azagro cotiza a proveedores | SC / RFQ | Sí |
| 3 | Azagro cotiza al cliente | COT | Sí |
| 4 | Cliente autoriza | COT aceptada | Sí |
| 5 | Azagro compra al proveedor | OC | Sí |
| 6 | Proveedor factura a Azagro | FP | Sí |
| 7 | **Azagro factura a Santa Rosa** | **FV a Santa Rosa** | **No** |
| 8 | **Azagro instruye a Santa Rosa qué facturar** | **Instrucción** | **No** |
| 9 | **Santa Rosa dispone línea y paga a Azagro** | **Cobro** | **No** |
| 10 | **Santa Rosa factura al cliente** | **Espejo** | **No** |
| 11 | Se entrega la mercancía | Guía | Sí |
| 12 | **Cliente paga a Santa Rosa** | **Cobro reportado** | **No** |
| 13 | **Si hay mora: Santa Rosa cobra, se reparte** | **Reparto** | **No** |

El momento del paso 7 es al autorizarse la cotización, después de que el proveedor
factura a Azagro.

---

## 5. Los números

Ejemplo con costo $100,000, margen 6.5% sobre precio de venta, plazo 150 días,
TIIE 6.9%.

### Precio al cliente

```
Azagro paga al proveedor                 100,000.00
Azagro factura a Santa Rosa              106,951.87    margen 6,951.87
Santa Rosa agrega el costo financiero      6,043.00
Santa Rosa factura al cliente            112,994.88
```

El costo financiero se calcula **sobre el precio con margen** (los 106,951.87), no
sobre el costo. Es aritméticamente igual a como el sistema lo calcula hoy, así que
**el motor de precios no cambia**.

### Si el cliente se atrasa 30 días

```
Mora que cobra Santa Rosa                  1,496.29    a TIIE + 9%
Costo de la línea esos 30 días               971.48    a TIIE + 4%
Utilidad de la mora                          524.81
    Azagro          50%                      262.40
    Santa Rosa      50%                      262.40
```

El financiamiento ordinario (los 6,043.00 del plazo pactado) se queda íntegro en
Santa Rosa. Solo la utilidad de la mora se reparte.

---

## 6. Las dos tasas

Hoy el sistema usa un solo número, el spread ASR de 4%, para poner precio y para
saber cuánto cuesta. Con el colchón de protección son dos cosas distintas y hay que
separarlas.

| Tasa | Valor | Para qué sirve |
|---|---|---|
| Tasa real de la línea | TIIE + 4.00% | Lo que de verdad cuesta. Base del costo y del reparto de mora. |
| Tasa de cálculo | TIIE + 4.15% | La que entra al precio del cliente. |

La diferencia es protección contra movimientos del banco. En el ejemplo son unos
$67 por operación. Poco, pero si no se separan nunca se sabe la utilidad real.

**Consecuencia:** el reporte de utilidad debe usar la tasa real, no la de cálculo.
Si usa la de cálculo, el colchón desaparece de la vista.

---

## 7. Catálogo de líneas de crédito

Santa Rosa tiene varias líneas y no todas son iguales. Y eventualmente Azagro va a
tener la suya. Hace falta un catálogo.

Cada línea guarda:

- Nombre y a quién pertenece (Santa Rosa o Azagro)
- Tasa real: TIIE + spread
- Tasa de cálculo: TIIE + spread con protección
- ¿Cobra comisión de apertura? y cuánto
- ¿Cobra otras comisiones? y cuáles
- Límite autorizado
- Disponible

Las líneas no se borran, se archivan: hay disposiciones viejas que las mencionan.

---

## 8. Disposiciones

Cada vez que se dispone de una línea queda un registro. Esta es la parte que hoy no
existe y sin la cual no se sabe cuánto costó realmente cada operación.

Una disposición guarda:

- Qué línea
- Cuánto y en qué fecha
- Qué facturas o pedidos está pagando
- Tasa congelada al momento de disponer
- Comisiones aplicadas, si la línea las cobra

Y de ahí se calcula: cuánto interés lleva acumulado, cuánto se ha pagado, cuánto
falta.

**La regla que lo justifica:** el costo de la línea de Santa Rosa es costo de Azagro,
aunque la línea no sea de Azagro. En esencia lo es.

Cuando se paga una disposición hay que poder decir a qué facturas y a qué pedidos
corresponde. Sin eso, el costo financiero no se puede atribuir a la operación que lo
generó, y la utilidad por pedido queda mal.

---

## 9. Las cuentas que se llevan

Cuatro. Solo la primera existe hoy.

**1. Proveedores.** Lo que Azagro les debe, con la línea disponible de cada uno.
Algunos proveedores dan plazo y límite en valor de insumos sin costo; otros son de
contado. La elección depende de la urgencia del cliente, así que hay que ver el
disponible al momento de decidir.

**2. Santa Rosa por facturas.** Lo que Santa Rosa le debe a Azagro por las facturas
del paso 7, hasta que las paga.

**3. Santa Rosa por reparto de mora.** Lo que Santa Rosa le debe a Azagro de la mitad
que le toca. Como Santa Rosa es quien cobra la mora, el dinero está de su lado.

**4. Estado de cuenta del cliente.** Lo que cada cliente debe, llevado por Azagro
para control. Con una advertencia importante: **si Santa Rosa factura, el cliente
legalmente le debe a Santa Rosa.** El documento que se le mande al cliente no puede
decir que le debe a Azagro.

---

## 10. Cómo se entera Azagro de los cobros

Azagro lleva el estado de cuenta pero no recibe el dinero. Alguien tiene que pasar
la información.

Propuesta, mientras el esquema se asienta:

- Una pantalla de **cobros reportados por Santa Rosa**: cliente, factura, fecha,
  monto. Alimenta el estado de cuenta de control.
- Un **cuadre mensual**: lo que Santa Rosa dice que cobró contra lo que Azagro tiene
  registrado. Las diferencias saltan solas.

No es elegante, pero es honesto sobre lo que hay: dos empresas, dos sistemas.

---

## 11. Qué se congela y cuándo

| Al confirmar el pedido | Se copia al documento |
|---|---|
| Circuito | Por dónde corre esta operación |
| Línea | Cuál se va a usar |
| Tasa real y tasa de cálculo | Las dos, con la TIIE del día |
| Política de cobro | Mora, comisión, FEGA, umbral de pronto pago |
| Plazo | Días de factura y días de interés |

Después de eso, cambiar un parámetro en Ajustes no mueve ese documento. Nunca.

---

## 12. Qué NO cambia

Vale la pena decirlo explícito, porque es la mayor parte del sistema:

- El motor de precios. La fórmula ya está verificada contra la hoja operativa.
- El cálculo del financiamiento dentro del precio.
- La escalera de plazos.
- El cálculo de mora.
- Solicitud, cotización a proveedores, pedido, orden de compra, entrega.
- Bitácora, permisos, reportes.

Lo que se agrega es una capa de quién factura y qué cuentas se llevan. No se
reescribe lo que ya funciona.

---

## 13. Decisiones abiertas

**A. La comisión del 1% en el precio.** La línea que se usa normalmente no cobra
comisiones, pero el sistema mete 1% en cada precio, herencia del circuito viejo con
ASR. Son unos $1,069 por operación cobrados por un costo que no existe.

No está mal cobrarlo, pero hoy aparece como costo y no lo es. Si se deja, es margen
y debe reportarse como margen. Tres salidas:

1. La comisión es un parámetro de la línea. Si la línea la cobra, es costo; si no, no
   se cobra.
2. Se deja el 1% siempre, pero el reporte lo muestra como margen, no como costo.
3. Se quita del precio.

**B. La bonificación por pronto pago, ¿a qué tasa?** Se calcula a tasa de costo. Con
dos tasas ahora hay que elegir: a la real (4.00%) conserva el colchón; a la de
cálculo (4.15%) devuelve lo que se cobró.

**C. ¿Cuánto tarda Santa Rosa en pagar a Azagro?** No hay regla: depende de si hay
dinero o si hay que disponer. Ese hueco es dinero de Azagro parado y conviene
medirlo. El sistema debería mostrar cuánto hay expuesto en ese tramo en cualquier
momento.

---

## 14. Orden de construcción

**Fase 0 — Terminar de probar lo que ya está.**
Congelamiento de la factura de interés, candados del pedido confirmado, cobros,
reportes y permisos. Va primero: el congelamiento es el mecanismo del que depende
todo lo demás de este documento.

**Fase 1 — Políticas editables.**
Catálogo, valor por omisión en el cliente, ajuste por operación, congelamiento al
confirmar. Solo administrador puede ajustar por operación.

**Fase 2 — Líneas y disposiciones.**
Catálogo de líneas, registro de disposiciones, costo real por operación, separación
de las dos tasas.

**Fase 3 — Circuito Santa Rosa.**
Factura a Santa Rosa, instrucción de facturación, factura espejo, cobros reportados,
cuadre mensual y reparto de mora.

**Fase 4 — Línea propia y mixto.**
Cuando llegue la línea. La estructura ya queda lista desde la fase 2.

**En paralelo, cuando toque:** mezclas físicas, prorrateo de flete, detalle por
producto en la factura, corte de Compaq.
