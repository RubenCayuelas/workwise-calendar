// Prueba de concepto del motor de recomposición del calendario.
// Objetivo: validar la lógica de colocación de tareas antes de tocar UI o base de datos.
// No es código de producción — es un banco de pruebas.

function recomponerDia(items, capacidad) {
  const locked = items.filter(i => i.locked).sort((a, b) => a.horaInicioFija - b.horaInicioFija);
  const flexible = items.filter(i => !i.locked).sort((a, b) => a.orden - b.orden);

  const colocados = [];
  const desbordados = [];

  // 1. Colocar los bloques bloqueados en su hora fija y calcular los huecos que dejan libres
  let cursor = 0;
  const gaps = [];
  for (const l of locked) {
    const inicio = l.horaInicioFija;
    if (inicio > cursor) gaps.push({ inicio: cursor, fin: inicio });
    colocados.push({ ...l, horaInicio: inicio, horaFin: inicio + l.duracion });
    cursor = Math.max(cursor, inicio + l.duracion);
  }
  gaps.push({ inicio: cursor, fin: Infinity }); // hueco final, se recorta con la capacidad

  // 2. Rellenar los huecos con los bloques flexibles, en orden
  let gapIndex = 0;
  let gapCursor = gaps[0].inicio;

  for (const item of flexible) {
    while (gapIndex < gaps.length - 1 && gapCursor + item.duracion > gaps[gapIndex].fin) {
      gapIndex++;
      gapCursor = gaps[gapIndex].inicio;
    }
    const limite = gapIndex === gaps.length - 1 ? capacidad : gaps[gapIndex].fin;
    if (gapCursor + item.duracion <= limite) {
      colocados.push({ ...item, horaInicio: gapCursor, horaFin: gapCursor + item.duracion });
      gapCursor += item.duracion;
    } else {
      desbordados.push(item); // no cabe hoy -> pasa al día siguiente por defecto
    }
  }

  colocados.sort((a, b) => a.horaInicio - b.horaInicio);
  return { colocados, desbordados };
}

function fmt(h) {
  const horas = Math.floor(h);
  const min = Math.round((h - horas) * 60);
  return `${String(horas).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function mostrarDia(nombre, colocados, desbordados) {
  console.log(`\n${nombre}:`);
  for (const c of colocados) {
    console.log(`  ${fmt(c.horaInicio)}-${fmt(c.horaFin)}  ${c.label}${c.locked ? '  [bloqueado]' : ''}`);
  }
  if (desbordados.length) {
    console.log(`  >> Desbordan a mañana: ${desbordados.map(d => d.label).join(', ')}`);
  }
}

console.log('=== Escenario 1: una tarea larga no cabe en el día (desbordamiento por defecto) ===');
const dia1 = [
  { id: 'A', label: 'Tarea A', duracion: 3, locked: false, orden: 1 },
  { id: 'B', label: 'Tarea B', duracion: 2, locked: false, orden: 2 },
  { id: 'C', label: 'Tarea C', duracion: 4, locked: false, orden: 3 },
];
const r1 = recomponerDia(dia1, 8);
mostrarDia('Lunes (capacidad 8h)', r1.colocados, r1.desbordados);

console.log('\n  Si el usuario prefiere apilar horas extra en vez de desbordar (por un plazo ajustado):');
const r1b = recomponerDia(dia1, 9);
mostrarDia('Lunes (capacidad ampliada a mano a 9h)', r1b.colocados, r1b.desbordados);

console.log('\n=== Escenario 2: una tarea bloqueada a media mañana no actúa como muro ===');
const dia2 = [
  { id: 'D', label: 'Tarea D', duracion: 3, locked: false, orden: 1 },
  { id: 'L', label: 'Tarea L (cliente, fija a las 10:00)', duracion: 2, locked: true, horaInicioFija: 10 },
  { id: 'F', label: 'Tarea F', duracion: 3, locked: false, orden: 2 },
];
const r2 = recomponerDia(dia2, 8);
mostrarDia('Martes (capacidad 8h)', r2.colocados, r2.desbordados);

console.log('\n=== Escenario 3: Tarea A dividida a mano en dos bloques, con B insertada en medio (A, B, A, C) ===');
const dia3 = [
  { id: 'A1', label: 'Tarea A (bloque 1)', duracion: 2, locked: true, horaInicioFija: 0 },
  { id: 'B',  label: 'Tarea B (insertada por el usuario)', duracion: 3, locked: true, horaInicioFija: 2 },
  { id: 'A2', label: 'Tarea A (bloque 2)', duracion: 1, locked: true, horaInicioFija: 5 },
  { id: 'C',  label: 'Tarea C', duracion: 2, locked: false, orden: 1 },
];
const r3 = recomponerDia(dia3, 8);
mostrarDia('Miércoles (capacidad 8h)', r3.colocados, r3.desbordados);
console.log('\n  Nota: "Tarea A (bloque 1)" y "Tarea A (bloque 2)" son dos Bloques del mismo Trabajo (mismo trabajo_id).');
console.log('  El motor no necesita ningún caso especial para representarlo — ya son dos filas normales en la tabla Bloque.');
