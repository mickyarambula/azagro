---
name: cerrar-decision
description: Cuando el dueño contesta una pregunta abierta de negocio, escribe la decisión en DECISIONES.md el mismo día con el formato exacto, mueve la pregunta en ESTADO.md y revisa si toca "No romper". Úsala en cuanto el dueño decida algo, antes de construir sobre esa decisión.
---

# Cerrar una decisión del dueño

Regla de `DECISIONES.md`: **toda decisión de negocio se escribe ahí el mismo día**. Lo que no está ahí no está decidido. Una decisión que se revierte no se borra: se agrega el renglón nuevo y se marca el viejo como sustituido.

## 1. El renglón en `DECISIONES.md`

Es una tabla de cuatro columnas. Se agrega **al final de la tabla** (antes de la sección "Pendientes de decisión"), con este formato exacto:

```
| AAAA-MM-DD | **DECISIÓN N — TÍTULO EN UNA FRASE.** Qué se decidió, con los números y los nombres de campo si los hay. | Por qué el dueño lo decidió así — su razón, no la tuya. | Sección del documento, archivo:línea, commit. |
```

- **N** = el número de la última "DECISIÓN N" del archivo, más uno. Búscalo con `grep -o 'DECISIÓN [0-9]*' DECISIONES.md | tail -1`. No cuentes filas: las primeras decisiones no llevan número.
- La fecha es la del día en que el dueño contestó. Nunca se retrofecha.
- "Por qué" es la razón del negocio. Si el dueño dijo "confío en tu criterio", se escribe la razón de lo que debe ser y se anota que fue criterio técnico con su aval.
- "Dónde consta" apunta a lo que existe hoy. Si todavía no hay código, se escribe "(diseño, borrador para revisión)".

## 2. La pregunta en `ESTADO.md`

La pregunta que se cerró está en § 2 (lista L/H) o en § 4. Se marca cerrada citando la decisión: `cerrada el AAAA-MM-DD, Decisión N`. No se borra: la pregunta y su historia se quedan. Y se corrige el conteo de preguntas abiertas al final de `DECISIONES.md` ("Pendientes de decisión").

## 3. ¿Es una regla que no se rompe?

Si la decisión es un invariante — algo que **nunca** debe hacerse o que **siempre** debe cumplirse (cuándo nace la deuda, qué se congela, quién ve qué) — se agrega o se ajusta en `CLAUDE.md` § No romper, citando "(Decisión N)". Si solo es alcance o preferencia de pantalla, no.

Ojo: `scripts/erp-permissions.test.mjs` vigila frases exactas de la regla 10. Correr `npm test` después de tocar `CLAUDE.md`.

## 4. Los dos índices

- `ESTADO.md` § 0: la pregunta cambia de fila (ABIERTA → "Resuelta en documento, no construida (Decisión N)") y el conteo entre paréntesis baja en uno.
- `DECISIONES.md` "Índice por tema": el número nuevo se agrega al tema que le toca (si es de dos temas, en los dos).
- `npm test` lo vigila (`scripts/erp-indice-docs.test.mjs`): si el índice no cuadra con el cuerpo, falla y dice qué clave sobra o falta.

## 5. Lo que NO se hace

- Contestar una pregunta ABIERTA en código sin el dueño.
- Reabrir una decisión ya escrita porque parece mejor otra. Se propone como pregunta nueva.
- Escribir la decisión "después, cuando se construya". Es hoy.
