---
name: guia-de-prueba
description: Escribe la guía numerada con la que el dueño prueba en el navegador lo que se acaba de construir. Úsala al terminar cualquier pieza que se vea o se toque en pantalla, antes de darla por entregada.
---

# Guía de prueba para el dueño

Reglas de `METODOLOGIA-TRABAJO.md` § 7. El dueño conoce su negocio perfectamente pero no el sistema por dentro. Si un paso se puede malentender, se va a malentender.

## Forma

- Al principio: **qué número es el que más importa** de esta prueba, para que sepa dónde poner la atención.
- **Numerada de principio a fin**, sin saltos ni "repite lo mismo".
- Cada paso dice: **en qué pantalla está, cómo llegó ahí, qué teclea exactamente, y qué debe VER después.**
- Los textos de botones y campos, **copiados literales de la pantalla**, entre comillas: "Entregar por partida", no "el botón de entregar". Si no estás seguro del texto, ábrelo en el navegador y léelo; no lo supongas.
- Los números **exactos y con signo**: `−$8.00`, `+$20.00`, `$172.00`. Nunca "aproximadamente".
- **Nada de jerga.** Ni FK, ni snapshot, ni kardex, ni event_ref, ni "la tabla". Se dice "el movimiento de inventario", "la factura de esa entrega".

## Para cada candado, dos pruebas

No basta con ver el mensaje rojo. La guía prueba las dos cosas:
1. Que el bloqueo aparece, con el mensaje que dice qué pasó y qué hacer.
2. Que **el camino legítimo que nombra ese mensaje funciona de verdad**.

## Al final, siempre

- Correr `npm test` y confirmar que ninguna prueba existente cambió de resultado (skill `red-de-seguridad`).
- Si se va a probar en producción: hasta que el deploy de Vercel no termina, el código no está arriba. Se confirma el deploy antes.

## Qué NO va en la guía

- Cómo funciona el sistema por dentro.
- Pasos en la Terminal: el dueño no la usa. Si es inevitable, se explica por qué y qué hace cada renglón.
