# Los selectores de día y hora, y los placeholders — diseño

**Rama** `feat/pickers-and-placeholders`, sacada de `dev` en `a3920c7`.

## Qué cambia para quien usa la app

Tres cosas.

**Los placeholders dejan de parecer valores escritos.** Hoy tres de los cuatro son ejemplos —
`Puerta metálica`, `Avería del torno`, `Feria` — en campos que ya tienen su etiqueta encima. Pasan a
decir qué escribir.

**El día se elige en un calendario, no en una lista.** El desplegable ofrece hoy entre 84 y 140
opciones seguidas. Pasa a ser un botón con el día elegido que abre la rejilla del mes.

**La hora se escribe.** El desplegable ofrece hoy 96 cuartos de hora, de `00:00` a `23:45`. Pasa a ser
un campo `HH:mm` que se teclea, con `−`/`+` y `↑`/`↓` moviendo un cuarto de hora y `Mayús` una hora.

Nada de esto cambia una regla del motor. Ningún dato se guarda distinto.

## Lo que decidió el dueño

Cerrado en la conversación del 2026-08-25. **No se vuelve a preguntar.**

| pregunta | respuesta |
|---|---|
| Qué dice un placeholder | **Instruye** qué escribir. Ni ejemplo, ni `p. ej. X` |
| Cuál de las dos tandas de texto | La **segunda** (las órdenes, más cortas) |
| Cambiar además la etiqueta `Motivo` al cerrar días | **No**. Una etiqueta, no dos que mantener a la par |
| Cómo se elige el día | **Calendario del mes en un popover** sobre un botón |
| Hasta dónde navega | **Lo mismo que hoy**: 4 semanas atrás, el horizonte adelante, tope 16 semanas |
| Qué se marca en la rejilla | **Hoy**, **fin de semana**, **días cerrados** y **los que ya están llenos** |
| Cómo se ve un día cerrado | **El gris de la cuadrícula**, y su motivo guardado al posar el ratón |
| Qué significa el punto | **Nada que haya que explicar**: hay hueco. Al posar el ratón, las horas libres |
| `Desde` / `Hasta` de una ausencia | **Un solo calendario de rango** |
| El rótulo de semana | **Bajo el campo**, si sale simple y seguro |
| Cómo se elige la hora | **Se escribe**, con `−`/`+` y `↑`/`↓` |
| Cuándo hace efecto lo escrito | **Al pulsar Intro o al salir del campo.** Los botones y las flechas, al instante |

Dos de estas respuestas corrigen un dibujo mío: el rayado para los días cerrados **no** se usa, y el
punto de hueco **no** lleva definición en pantalla.

Sobre el rayado, la razón cambió a mitad de camino y a mejor. Esta rama se rebasó sobre `origin/dev`
en `8669fea` mientras se escribía el plan, y ese `dev` trae una regla nueva: **un hueco sí se raya**
(SPEC § *Calendar View*, DECISIONS § *A Gap Is Hatched, the Lunch-Break Band Is Not*). Lejos de
contradecir esto, lo afila — la propia decisión dice por qué: un hueco se raya porque es **un
rectángulo dentro de un carril que hay que distinguir del bloque de al lado**, mientras que la banda de
la comida se deja lisa porque **cruza las siete columnas en la parte del día que no lleva
información**, y decorada se convertía en lo primero que encontraba el ojo. Las 42 celdas del selector
son el segundo caso, no el primero: no tienen un vecino con el que confundirse y son muchas. Y un día
cerrado en la cuadrícula ya es un gris (`.columnClosed`), no un rayado. Así que el selector dice
«cerrado» con el mismo gris, y el rayado se queda para lo que significa: un hueco.

## El tono: mínimo, limpio, y de la misma familia

Pedido por el dueño el 2026-08-25: *«lo quiero minimalista, limpio y que encaje con el diseño general
de la app»*. Eso no es decoración del documento, decide cosas:

- **Ni un color a mano**: todo por un token de `public/brand/workwise-tokens.css`, como manda CLAUDE.md,
  para que el tema oscuro siga saliendo gratis. Iconos de Tabler, los que ya usa el resto.
- **Bordes de medio píxel y esquinas `--radius`**, como cualquier tarjeta o panel de la app.
- **Nada de leyenda y nada de rótulos explicativos.** Lo que un día tenga que decir lo dice al posar
  el ratón, que es como ya funciona la cabecera de cada día en la cuadrícula. Y nada de rayados: el
  rayado ya significa «un hueco» en esta app, y significarlo aquí de otra forma sería un idioma nuevo.
- **Una sola línea de ayuda bajo el campo**, nunca dos.
- **El texto en minúscula donde el idioma la pide**: `agosto 2026`, no `Agosto 2026`. Los días de la
  semana en su letra sola —`L M X J V S D`—, por `Intl` y no por una lista escrita a mano.
- **Ningún estado nuevo que haya que aprender.** Las seis marcas son las que el dueño pidió y ni una
  más, y todas se pueden pulsar.

## Los cuatro placeholders

| clave | hoy | pasa a decir |
|---|---|---|
| `jobPanel.namePlaceholder` | `Puerta metálica` / `Metal door` | `Ponle un nombre que reconozcas` / `Give it a name you will recognise` |
| `jobPanel.descriptionPlaceholder` | `Notas, medidas, material…` | **igual**: ya nombra categorías, no un valor |
| `gapForm.reasonPlaceholder` | `Avería del torno` / `Lathe breakdown` | `Qué ocupa esas horas` / `What takes up those hours` |
| `absenceForm.notePlaceholder` | `Feria` / `Fair` | `Por qué cierras esos días` / `Why you are closing those days` |

`gapForm.reasonPlaceholder` es el texto de tres formularios a la vez — editar una ausencia, cerrar el
día aquí, y el modo *Un hueco* — así que no puede nombrar «el día»: sería mentira en dos de los tres.
`absenceForm.notePlaceholder` solo aparece en *Cerrar días*, donde el texto va a `day_overrides.note` y
la cabecera del día lo imprime en lugar de la palabra `cerrado`.

**Una consecuencia que se verá**: los ejemplos siguen en pantalla en las tarjetas de modo
(`absenceForm.modeGapHint` = «Unas horas del día: una avería, gestiones, media tarde.» y
`absenceForm.modeClosedHint` = «Vacaciones, feria, festivo: el día entero, sin horas planificables.»),
pero **esas tarjetas solo se dibujan en el modo múltiple**. En el formulario de una sola ausencia y en
el de cerrar el día no quedará ningún ejemplo. Se juzga aceptable: los dos ya se explican en tres
líneas de ayuda propias.

## `DayPicker` — el selector de día

Sustituye a `DateSelect` en sus cuatro sitios: `NewJobPanel:393`, `AbsencePanel:571` (`Desde`),
`AbsencePanel:619` (`Hasta`) y `SplitBlockPanel:236`.

### El disparador

Un `<button type="button">` con el día ya escrito por `format.dayOption(value)` — `Mié 12 ago`, la
misma cadena que hoy — y el galón de `Field`. Hereda de `Field` el id generado, el `aria-describedby`
y el aro de inválido, y respeta `disabled`.

**No lleva `aria-label`.** Para un botón el nombre accesible sale del `aria-label` antes que de su
contenido, y `<label for>` no entra en ese cálculo: un `aria-label` borraría a la vez el nombre del
campo y la fecha elegida. Lleva `aria-labelledby` apuntando a la etiqueta del `Field` y a su propio id
—«Desde, Mié 12 ago»—, `aria-haspopup="dialog"`, `aria-expanded`, y `dayPicker.open` solo como `title`.
El galón va `aria-hidden`, como el de `Select`.

Igual que `ColorSwatches` recibe `label={t('jobPanel.color')}` porque un `radiogroup` no puede llevar
el id generado, `DayPicker` recibe el id de la etiqueta desde el sitio que lo usa.

### La línea bajo el campo

**Una sola línea**, no dos: `miércoles 12 de agosto · Semana 33`, unida con `units.listSeparator`
—« · »— como la cabecera de un día compone hoy la suya. Sale de `format.longDate`, del número que ya
calcula `isoWeekNumber`, y de **una clave nueva** `units.week` = «Semana {{week}}»: la que existe,
`header.week`, lleva el rango de fechas dentro y aquí sobra, porque la fecha larga ya lo dice.

Lo que hace es lo único que se perdía al dejar la lista: el desplegable agrupaba los días bajo el
rótulo de la semana **exactamente igual** que la cabecera de la cuadrícula, para que un formulario y la
cuadrícula no pudieran llamar de dos maneras a un mismo día. `Semana 33` lo conserva sin repetir el
rango de fechas, que la fecha larga ya dice.

Va en los tres selectores de un día. En el rango, no: ese hueco lleva la cuenta de días. Y `Field`
sustituye la ayuda por el error cuando hay error, así que la línea desaparece justo cuando una fecha se
está rechazando — que es lo correcto y lo que ya hace el resto de la app.

### La rejilla

Seis filas de siete celdas, **siempre seis**, lunes primero. Cabecera de días de la semana en
`Intl` a través de `format`. Título del mes y año. `‹` y `›` para cambiar de mes. Un botón `Hoy` que
**elige hoy y cierra**, como cualquier otra celda — no solo navega.

Seis filas fijas y no cinco o seis según el mes: así la altura del popover es una constante y el
recorte contra la ventana es aritmética pura y con test, en vez de una medición.

### Las marcas

| día | cómo se ve | de dónde sale |
|---|---|---|
| el elegido | la celda rellena | del propio valor |
| hoy | un aro alrededor del número | `today`, que ya llega a los tres paneles |
| sábado y domingo | el número atenuado | `isWeekend`, en el cliente |
| pasado | el número atenuado, igual que el fin de semana | `compareDates(date, today) < 0`, en el cliente |
| cerrado | el **fondo** de la celda en gris, el mismo `--ww-surface-alt` con el que la cuadrícula pinta una columna cerrada | del servidor |
| con hueco libre | un punto bajo el número | del servidor |

Dos canales y no tres: el **número** se atenúa cuando el motor no trabaja ese día por el calendario
(fin de semana, pasado), y el **fondo** se apaga cuando el taller está cerrado por decisión del dueño.
Un sábado cerrado lleva las dos cosas, que es la verdad.

**Todas se pueden elegir.** Ninguna marca deshabilita nada: DECISIONS § *A Closed Day Chosen As A
Start Date Is Honoured* recoge la decisión del dueño, «Dejar elegirlo, pero cumplirlo de verdad».

**Al posar el ratón, la celda dice lo que ese día tenga que decir**, compuesto con
`units.listSeparator` a partir de claves que ya existen: `format.dayOption`, y luego `day.today`,
`day.weekend`, `day.closed` o el motivo guardado del día, y `day.freeHours` = «{{hours}} h libres» o
`day.full` = «Día completo». Es exactamente como `DayHeader` compone hoy su propio `title`.

**No hay leyenda.** El dueño no la pidió, y el `title` de cada celda enseña las marcas mejor que una
línea de letra pequeña en un popover estrecho.

### El punto, y por qué esta aritmética y no otra

El punto significa una sola cosa: **aquí el motor todavía coloca horas**. Su ausencia no afirma nada.

Las dos cifras que ya existen en `WeekDay` no sirven, y su propio comentario dice por qué responden a
preguntas distintas: `plannableMinutes` no resta el trabajo suelto, así que pondría un punto en un
martes que la cuadrícula dibuja lleno; `bookedMinutes` diría «lleno» en un día que el motor va a
despejar en la siguiente escritura, o sea un estado que el dueño no eligió. Por date, dentro de la
operación nueva:

```
freeMinutes = max(0, plannableMinutesOf(snapshot, date)
                     − Σ durationMinutes de los bloques movibles de ese día)
longestRun  = max(freeStretchesFrom(config.periods, huecos y bloques de ese día))
hasRoom     = date <= horizonEndDate(...) && min(freeMinutes, longestRun) >= MIN_ROW_MINUTES
```

Cada término tiene su razón. Restar los minutos movibles es la aritmética del propio motor: `openDay`
arranca el día en `plannableMinutes` y `planTake` va descontando, y las filas movibles del día son
justo en lo que la última pasada gastó ese presupuesto. El suelo del cuarto de hora es SPEC § *Fill and
Overflow, Always*: un día cuyos 40 minutos libres son cuatro agujeros de diez no tiene hueco que el
motor vaya a usar. Y el horizonte hay que comprobarlo aparte porque `buildDayPlan` no lo conoce: sin
eso, un día más allá del horizonte declara todos sus minutos planificables y el punto prometería sitio
justo en los días que producen el rechazo `horizon-exceeded`.

De regalo, la consistencia de las marcas sale de una sola línea: `buildDayPlan` devuelve cero minutos
planificables por cuatro motivos a la vez —fecha pasada, día cerrado, día `manual`, jornada de cero
minutos—, así que **un fin de semana, un día cerrado y un día pasado se quedan sin punto sin más
código**, y el punto no puede contradecir al gris que ya llevan.

### Hasta dónde llega

`planningWindow` sigue mandando: 4 semanas atrás desde el lunes de esta semana, el horizonte adelante,
tope 16 semanas. Las flechas `‹ ›` se apagan en los bordes de esa ventana.

La ventana cae casi siempre a mitad de mes, así que la rejilla dibuja días que la ventana no ofrece
—para hoy 2026-08-12 con horizonte 8, la ventana es 2026-07-13 … 2026-10-04, y julio tiene doce días
fuera—. **Esos días se dibujan apagados y no se pueden pulsar.** Es exactamente el conjunto de días
alcanzable hoy: si se pudieran pulsar, hacia delante el guardado responde 409 `horizon-exceeded`, y
hacia atrás la fecha de inicio de un trabajo escribe filas pasadas y bloqueadas que el dueño no quiso.

Un valor guardado **fuera** de la ventana se conserva, como hoy: el popover abre en su mes y esa celda
sí se puede pulsar; el resto de ese mes, no.

### El modo rango

Solo en el modo múltiple del panel de ausencias, donde hoy hay dos campos. Un `Field` con un
calendario, y con su propio hueco de error.

Cuatro cosas que hay que respetar, cada una con su defecto detrás:

1. **El error necesita sitio.** `localError` no se dibuja en ningún lado salvo en el `error=` de los
   cinco `Field`. Al juntar `Desde` y `Hasta` desaparecería el único hueco donde aparecen
   `errors.rangeBackwards` y el 400 `invalid-range` del servidor — y `Guardar` se quedaría callado, sin
   escribir nada y sin decir nada. El `Field` del rango lleva `error={errorFor('date') ??
   errorFor('endDate')}`, y `API_FIELD` sigue mapeando `from → date` y `to → endDate`.
2. **El servidor se salta sábados y domingos** dentro del rango, salvo que el rango entero sea fin de
   semana. Un tramo pintado de lunes a domingo pintaría siete celdas mientras la escritura hace cinco.
   Las celdas de fin de semana **dentro del tramo se pintan excluidas**, y eso se decide con la misma
   función pura que usa el servidor (`absenceRange`), nunca rederivada en el componente.
3. **La cuenta de días se queda donde está**, bajo el campo: no es la cuenta de celdas del tramo, es la
   que la vista previa dice que se va a escribir. Por eso el rótulo de semana **no** va en el modo
   rango — ese hueco ya tiene trabajo. Mientras falte el segundo extremo, el popover dice
   `dayPicker.rangePending` dentro de sí mismo, no en el formulario.
4. **El primer clic no sale del calendario.** El popover se guarda el extremo pendiente y solo llama a
   `onChange` cuando tiene los dos. Si el primer clic escribiera `date` y `endDate`, cada clic de
   paseo por el mes lanzaría `previewAbsence`, que es una escritura real dentro de una transacción que
   se deshace, anunciando trabajo desplazado de un rango a medio elegir. Y si dejara `endDate` sin
   poner, `rangeValid` se caería, con ella la vista previa, y el botón `Reabrir` desaparecería a media
   selección.

El segundo clic cierra el popover. Los dos extremos salen siempre ordenados, así que
`compareDates(endDate, date) >= 0` no se puede romper desde aquí y `errors.rangeBackwards` queda
inalcanzable por el calendario — el hueco de error se queda para el 400 del servidor, que sí se alcanza
en dos clics (`MAX_ABSENCE_DAYS` = 120).

### Cuándo avisa al formulario

**En el clic, inmediatamente**, en los tres selectores de un día. No al cerrar el popover: los paneles
fijan la fecha de forma optimista porque la banda pintada en la cuadrícula tiene que seguir al campo, y
un campo congelado detrás de una pregunta congelaría la banda a media edición. Se conservan intactos
los cuatro contratos que hay alrededor: el apunte de `lastVisible` para el aviso de semana, el
`setForce(false)` de `NewJobPanel`, el `Hasta` que se arrastra hacia delante en `AbsencePanel`, y el
`disabled` mientras se guarda.

El modo rango es la excepción justificada del punto 4 de arriba: ahí no hay banda pintada — el pintado
solo abre el formulario de una ausencia, nunca el rango.

### El teclado

Flechas mueven la celda enfocada; `Inicio` y `Fin`, a los extremos de la semana; `PáginaArriba` y
`PáginaAbajo`, de mes; `Intro` elige; `Escape` cierra y devuelve el foco al disparador. Al abrir, el
foco va a la celda seleccionada.

**Las flechas se tragan.** El disparador pasa a ser un `<button>`, y `isTypingTarget` solo reconoce
`INPUT`, `TEXTAREA`, `SELECT` y `contenteditable` — con un `<select>` el paginador de semana lo
saltaba dos veces; con un botón, lo único que hoy impediría que la semana girase bajo un calendario
abierto es que `CalendarScreen` mire si hay un panel abierto, que es casualidad y no contrato.

## `TimeField` — el selector de hora

Sustituye a `TimeSelect` en sus siete sitios: las cuatro filas de horario de Ajustes, la hora de inicio
de una ausencia, el momento de cerrar el día, y la hora de las tijeras. Se construye sobre el `Input`
que ya existe, así que hereda el cableado de `Field` sin tocar nada.

### Cómo se comporta

- **Dibuja su propia cadena**, no el resultado de `format.time`. Pasar cada tecla por
  parse→format reescribiría `8:00` a `08:00` bajo el cursor, y `formatTime` falla suave: fuera de
  rango escribe un diagnóstico en la consola y devuelve `--:--`, que es justo lo contrario de «lo que
  no se entiende se queda a la vista». `format.time` se usa solo donde se parte de minutos: el valor
  inicial y el resultado de los botones y las flechas.
- **Lo escrito hace efecto al pulsar `Intro` o al salir del campo.** `−`/`+` y `↑`/`↓` hacen efecto al
  instante, un cuarto de hora, y con `Mayús` una hora.
- **Solo se cuadra al cuarto lo que se haya cambiado de verdad**, comparando contra el valor que había
  al entrar en el campo. Cuadrar en cada salida movería un `08:10` guardado a mano con solo tabular por
  encima: `changedFields` compara cadenas, así que `08:10` → `08:15` entraría en el parche, y un
  guardado de Ajustes recompone el calendario y vacía la línea de deshacer. Es el defecto exacto que el
  comentario de `timeOptionMinutes` existe para evitar.
- **Un valor ilegible se queda a la vista** con el aro de inválido y `errors.invalidTimeFormat`, nunca
  reemplazado.
- **El tope de arriba es `23:45`**, el último cuarto, que es lo que el desplegable podía emitir.
  `hhmmToMinutes` interpreta `24:00` como 1440 y con eso la banda se deja de dibujar sin explicación
  mientras el campo parece legal.
- **Los límites rechazan a la vista, no recortan en silencio.** El único sitio que pasa límites es el
  momento de cerrar el día, y son las franjas de trabajo: recortar convertiría un `18:00` escrito en
  `17:45` — un valor cambiando bajo el dueño, que es lo que la regla del valor fuera de rejilla prohíbe.
  No recortar dejaría escribir `23:00` y llegar a un callejón sin salida con `Guardar` apagado. Se
  rechaza con `errors.timeOutOfBounds`, que dice entre qué horas tiene que estar.
- **`Escape` dentro del campo llega al panel y lo cierra**, igual que hoy dentro del `Input` del nombre.
  No hay estado que revertir: un búfer oculto de «lo que había antes» sería un tercer estado que
  explicar.

Nada de esto toca la rejilla del cuarto de hora: `TIME_STEP_MINUTES` sigue siendo 15 y sigue atado por
test a `SNAP_MINUTES` y a `MIN_ROW_MINUTES`.

## La ruta nueva de lectura

Las dos marcas que el cliente no puede deducir —cerrado y hueco libre— solo las sabe el servidor, y hoy
llegan únicamente para los siete días de la semana en pantalla.

- **`GET /api/days?from=&to=`**, en `app/api/days/route.ts`, envuelta como la del calendario y
  `dynamic = 'force-dynamic'` como todas sus hermanas.
- **`readDays(from, to, db)`** en `src/lib/operations/views.ts`, al lado de `readWeek`, para que la
  lógica esté donde se puede probar. Reutiliza `listDayOverridesBetween`, que ya existe y ya es la
  fuente de los motivos de `readWeek`, y `createDayConfigResolver`, para que el gris del selector no
  pueda discrepar del de la cuadrícula.
- **Devuelve por día lo que el cliente no puede deducir**: `date`, `isClosed`, `note` y `freeMinutes`
  (más `hasRoom` derivado de la fórmula de arriba). Ni el fin de semana ni el pasado viajan: se
  calculan en el cliente.
- **Un tope propio**, `MAX_DAY_MARK_DAYS = 200`, ni el de las ausencias ni el de las opciones.
- **Una sola petición al abrir el popover**, cubriendo la ventana navegable entera, no una por flecha
  de mes.
- **Se tira con la revisión de la semana.** `useWeek` ya recarga tras cualquier escritura porque una
  recomposición reescribe filas en semanas que la respuesta ni menciona; las marcas cuelgan de ese
  mismo contador, con su `AbortController`.

**Coste**, contado sobre `readWeek`: un `readSnapshot` y un `listDayOverridesBetween`, igual que la
semana, y luego 42 `getDayConfig` y 42 `plannableMinutesOf` donde la semana hace 7 — cada
`plannableMinutesOf` es un `buildDayPlan` sobre el snapshot. A cambio no construye nada de lo demás que
la semana sí: los bloques con sus etiquetas, los proyectos, los huecos, el resumen y el estado del
deshacer. Aceptable para un SQLite local de un solo usuario, y CLAUDE.md pide simplicidad antes que
optimización. Si alguna vez se midiera lento, lo que hay que recortar es el rango, no la fórmula.

**Riesgo aceptado**: es un segundo snapshot. El panel no tiene velo a propósito —el dueño edita
mirando el calendario—, así que entre una escritura detrás del panel y su recarga el punto puede ir un
instante por detrás de la columna que tiene al lado. El dueño lo aprobó sabiéndolo.

**Pensada para los festivos automáticos** que se están haciendo en otra rama: mandar `note` desde el
principio es lo que permitirá que el gris nombre el festivo sin cambiar la ruta, y mantenerla por rango
es lo que la hace servir para festivos escritos mucho más allá del tope de 16 semanas.

## Los módulos puros, y qué se prueba

Los tests corren en Node sin DOM (`environment: 'node'`, solo `src/**/*.test.ts`) y en este repositorio
nunca se renderiza nada. El patrón ya establecido es un módulo hermano en `.ts` —`dateOptions.ts`,
`timeOptions.ts`, `stepper.ts`, `offWeek.ts`, `draftBand.ts`, todos abren diciendo «para poder probarlo
sin un DOM»— y hasta el arrastre se prueba por funciones puras exportadas.

| módulo nuevo | qué decide |
|---|---|
| `monthGrid.ts` | qué 42 fechas tiene la rejilla de un mes, lunes primero, y qué marcas salen sin servidor |
| `monthReach.ts` | en qué mes abre el popover y hasta dónde llegan las flechas |
| `dayPickerKeys.ts` | el movimiento con el teclado, sobre un evento estructural y no del DOM |
| `dayRange.ts` | la máquina de estados del rango, con la forma de `paintSession.ts` |
| `pickerDays.ts` | el gris y el punto a partir de las dos cifras del servidor |
| `timeField.ts` | interpretar, cuadrar, mover, y qué guarda cada uno de los tres momentos |
| `popoverBox.ts` | el recorte contra la ventana, con la altura constante de las seis filas |

En `src/lib/dates.ts` hacen falta cuatro ayudas de mes que hoy no existen —principio de mes, días del
mes, sumar meses, y el mes de una fecha—; van ahí porque ese módulo es el único al que se le permite
convertir partes en un instante, y ya tiene la palanca: `formatDate({year, month, day: 0})` normaliza
las partes fuera de rango. En `src/lib/format.ts` y `useFormat`, el mes largo y el día de la semana
corto para la cabecera, por `Intl` y nunca por una lista escrita a mano.

**Lo que se queda sin test, y se dice en vez de suponerse**: abrir y cerrar el popover, el `Escape`, el
clic fuera, el orden del foco, el portal y su capa, el cableado de accesibilidad y el aro de inválido.
Hoy `DateSelect` y `TimeSelect` tampoco tienen ni un test de componente, así que no es una regresión —
pero es bastante más superficie sin cubrir, y por eso todo lo decidible sale a un módulo.

## La mecánica del popover

Sería el primer popover compartido de la app, así que cada pieza es una elección.

- **Portal a `document.body`**, como `SidePanel`: la cuadrícula tiene `overflow: auto`, la columna
  `overflow-x: clip` mientras desliza, y la animación de cambio de semana aplica un `transform`, que
  crea un contexto de apilamiento y un bloque contenedor para cualquier `position: fixed` de dentro
  durante sus 180 ms.
- **Token nuevo, `--ww-z-popover: 45`**, junto a los otros tres. Reutilizar el 40 del panel sería un
  empate que resuelve el orden de montaje: hoy gana el popover por casualidad, y se invertiría en
  cuanto algo montase un portal entre medias. El 45 dice las dos ordenaciones que hacen falta: el
  calendario pinta sobre el panel en el que está, y una confirmación pinta sobre el calendario.
- **`Escape` en `window`, en fase de captura, con `stopPropagation`.** `SidePanel` escucha en
  `document` en burbuja, y dos oyentes del mismo nodo y la misma fase no se pueden ordenar — por eso
  existe `closeOnEscape={!confirmOpen}`, que hubo que enhebrar a mano en tres paneles. Capturar en
  `window` corre antes de que el evento baje, así que el panel no ve la tecla. Es la forma que ya usan
  `PaintChooser` y los dos hooks de gesto. **Coste en los once sitios: cero.**
- **`pointerdown` en `window`, en captura, tragado.** El defecto está medido en `PaintChooser`: «sin
  esto la pulsación que descarta esto cae en la columna de debajo y empieza una segunda banda». Y la
  rejilla sigue viva detrás del panel a propósito, así que también podría abrir el panel de otro
  trabajo. Cinco ramas: dentro del popover, pasa; en el disparador, se traga y se cierra (portalado, si
  se dejara pasar el `click` volvería a abrir y el popover parecería no cerrarse nunca); en la
  cuadrícula, se traga; en otro campo del mismo panel, se traga —una pulsación cierra, la siguiente
  hace lo que dice—; y no se filtra por botón, que un clic derecho también descarta.
- **Salir con el tabulador** no dispara ningún evento de puntero: se cubre con un `focusout` sobre la
  caja, cerrando cuando el destino no está ni dentro ni en el disparador.
- **Fijo a la ventana y recortado ahí**, como `.paintChooser`, para no tapar la banda que el campo está
  moviendo — el popover se abre a la izquierda del panel, encima de las columnas, que es justo donde
  está la banda. Con seis filas fijas la altura es una constante y el recorte es aritmética pura.
- **El foco** va a la celda seleccionada al abrir y vuelve al disparador al cerrar, siempre explícito:
  `preventDefault()` en el `pointerdown` suprime el movimiento implícito del foco. No hay trampa de
  foco en ningún sitio de la app, y eso es deliberado.
- **Exportar `useFieldBinding`** desde `Field.tsx` y desde `ui/index.ts`: hoy es privado del módulo, y
  `DateSelect`/`TimeSelect` heredan el cableado solo porque renderizan el `Select` que vive ahí mismo.

## Qué muere y qué sobrevive

| pieza | qué le pasa |
|---|---|
| `DateSelect.tsx`, `TimeSelect.tsx` | mueren, y salen de `ui/index.ts` |
| `dateOptions.ts` | `planningWindow` y las cuatro constantes siguen igual; `dayOptionDates` y `groupDaysByWeek` mueren |
| `timeOptions.ts` | `TIME_STEP_MINUTES` y `clockMinutes` siguen; `timeOptionMinutes` muere y sus dos propiedades reales se mudan a `timeField.ts` |
| `Field.tsx` | `Select` sigue; `SelectOptionGroup` y la prop `groups` se quedan sin ningún usuario |
| `dateOptions.test.ts` | lo de `planningWindow` sigue; lo de las listas se muda a `monthGrid`/`monthReach` |
| `timeOptions.test.ts` | **el test que ata `TIME_STEP_MINUTES` a `SNAP_MINUTES` y a `MIN_ROW_MINUTES` no se toca**: es lo único que sujeta la rejilla del cuarto de hora |

`TIME_STEP_MINUTES` no se puede renombrar ni borrar con el resto: eso desataría la rejilla en silencio.

## Las claves nuevas

Un bloque `dayPicker` con `open`, `previousMonth`, `nextMonth`, `today`, `todayHint`, `rangeStart` y
`rangePending`; un bloque `timeField` con `earlier`, `later` y `hint`; `units.week`; `day.weekend` junto
a las otras palabras de estado del día; y en `errors`, `invalidTimeFormat` y `timeOutOfBounds`. Las dos
tandas se mantienen idénticas por test, interpolaciones incluidas.

`timeField.hint` —«Escríbela, o muévela con ↑ y ↓ de cuarto en cuarto; con Mayús, de hora en hora.»—
se dibuja como el `title` del campo, **no** como ayuda del `Field`: cuatro de los siete sitios son las
filas de horario de Ajustes, que van en línea, y ahí la ayuda ocupa una fila entera para ella — cuatro
copias idénticas añadirían cuatro líneas a esa pantalla. Se dice una vez.

No hacen falta más: el `title` de una celda se compone de `format.dayOption`, `day.today`,
`day.weekend`, `day.closed`, `day.freeHours` y `day.full`, que ya existen, y el resto de la línea bajo
el campo sale de `format.longDate` e `isoWeekNumber`.

## Lo que se le debe a los documentos

- **SPEC § *Visual Design*** se reescribe: hoy nombra los dos controles y su mecánica. La prohibición
  de encima —«No native `<input type="time">` or `<input type="date">` anywhere»— se queda tal cual,
  porque es la razón por la que esto se construye a mano.
- **SPEC § *The Absences Screen — One Place, Two Modes***: dice que los dos modos comparten
  `Desde`/`Hasta`. Ahora comparten un calendario de rango.
- **SPEC § *Settings***: las filas de horario se escriben.
- **SPEC § *Calendar View***: las marcas nuevas del selector.
- **SPEC § *A Date That Leaves the Week On Screen***: la fecha sigue fijándose de forma optimista, y
  tiene que seguir siendo verdad del control nuevo.
- **DECISIONS**: una entrada por decisión, cada una con la forma que exige el test —la primera línea no
  vacía tras el título empieza `**Rule** — ` con raya, y hay un `**Why**`—. Son cuatro: la hora que se
  escribe (ahí va «Permite escribir para no hacer 2000 clicks para ir de 00:00 a 23:45»), el calendario
  de mes con su alcance, las marcas y el punto, y el rango de una sola vez.
- **CLAUDE.md**: el *Implementer Default* del alcance del selector sigue siendo verdad y no se toca.
- **Versión**: es una funcionalidad, así que `0.21.1` → `0.22.0` en `package.json` y en
  `desktop/package.json`, con su entrada `## 0.22.0 — …` arriba del CHANGELOG, escrita en términos de
  qué es distinto de usar.
- `npx vitest run src/lib/docs.test.ts` después de tocar cualquiera de ellos.

## Los cuatro portones

`tsc --noEmit`, `vitest run`, `eslint .` y `next build`, todos en verde antes de cualquier commit.
Base de partida de esta rama, medida tras el rebase sobre `origin/dev` en `8669fea`: 44 archivos,
1178 tests, 0 fallos.
