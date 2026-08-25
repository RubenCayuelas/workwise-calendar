import { describe, expect, it } from 'vitest';
import { composeHolidays } from './compose';
import { parseFestivosIo } from './festivosIo';
import { GENERIC_LOCAL_NAME, readableOfficialName } from './officialNames';
import type { JuntaHoliday } from './juntaDataset';

const DATES: JuntaHoliday[] = [
  { date: '2026-02-28', officialName: 'DÍA DE ANDALUCÍA', level: 'regional' },
  {
    date: '2026-09-03',
    officialName: 'FIESTA LOCAL EN PRIEGO DE CÓRDOBA (CÓRDOBA)',
    level: 'local',
  },
];

describe('parsing festivos.io', () => {
  it('reads the Spanish name of every holiday it lists', () => {
    const names = parseFestivosIo({
      holidays: [
        { date: '2026-09-03', name: { es: 'Feria Real de Priego de Córdoba' }, level: 'local' },
        { date: '2026-02-28', name: { es: 'Día de Andalucía' }, level: 'regional' },
      ],
    });

    expect(names.get('2026-09-03')).toBe('Feria Real de Priego de Córdoba');
    expect(names.get('2026-02-28')).toBe('Día de Andalucía');
  });

  it('is an EMPTY MAP and never a throw for a body it cannot read', () => {
    expect(parseFestivosIo(null).size).toBe(0);
    expect(parseFestivosIo('<html>404</html>').size).toBe(0);
    expect(parseFestivosIo({ error: 'Not Found' }).size).toBe(0);
    expect(parseFestivosIo({ holidays: 'nope' }).size).toBe(0);
  });

  it('skips the entries it cannot use and keeps the rest', () => {
    const names = parseFestivosIo({
      holidays: [
        { date: 'nope', name: { es: 'Whatever' } },
        { date: '2026-02-30', name: { es: 'A day that is not' } },
        { date: '2026-09-03', name: {} },
        { date: '2026-12-25', name: { es: '   ' } },
        { date: '2026-01-01', name: { es: 'Año Nuevo' } },
      ],
    });

    expect([...names.entries()]).toEqual([['2026-01-01', 'Año Nuevo']]);
  });
});

describe('composing a holiday', () => {
  it('prefers the name festivos.io gives', () => {
    const names = new Map([['2026-09-03', 'Feria Real de Priego de Córdoba']]);

    expect(composeHolidays(DATES, names)).toEqual([
      { date: '2026-02-28', name: 'Día de Andalucía', level: 'regional' },
      { date: '2026-09-03', name: 'Feria Real de Priego de Córdoba', level: 'local' },
    ]);
  });

  it('falls back to the written table for a regional day', () => {
    expect(composeHolidays(DATES, new Map())[0].name).toBe('Día de Andalucía');
  });

  it('falls back to a GENERIC name for a local day, which is the normal first state', () => {
    expect(composeHolidays(DATES, new Map())[1].name).toBe(GENERIC_LOCAL_NAME);
  });

  it('falls back to the dataset’s own words for a regional string nobody has written down', () => {
    const odd: JuntaHoliday[] = [{ date: '2028-03-19', officialName: 'SAN JOSÉ', level: 'regional' }];
    expect(composeHolidays(odd, new Map())[0].name).toBe('SAN JOSÉ');
  });
});

describe('the written name table', () => {
  // Every distinct LABORAL description in the published dataset, measured over 2023-2027. A year
  // that adds a seventeenth is not a failure — it reads through as it came — but it should be seen.
  const PUBLISHED = [
    'ASUNCIÓN DE LA VIRGEN',
    'AÑO NUEVO',
    'DÍA DE ANDALUCÍA',
    'DÍA DE LA CONSTITUCIÓN ESPAÑOLA',
    'DÍA DE LA INMACULADA CONCEPCIÓN',
    'EPIFANÍA DEL SEÑOR',
    'FESTIVIDAD DE ASUNCIÓN DE LA VIRGEN',
    'FIESTA DE TODOS LOS SANTOS',
    'FIESTA DEL TRABAJO',
    'FIESTA LABORAL PARA ANDALUCÍA',
    'FIESTA NACIONAL DE ESPAÑA',
    'INMACULADA CONCEPCIÓN',
    'JUEVES SANTO',
    'NATIVIDAD DEL SEÑOR',
    'TODOS LOS SANTOS',
    'VIERNES SANTO',
  ];

  it('covers every string the dataset has ever used', () => {
    const missing = PUBLISHED.filter((name) => readableOfficialName(name) === undefined);
    expect(missing).toEqual([]);
  });

  it('never hands back an upper-case name for one it knows', () => {
    for (const name of PUBLISHED) {
      expect(readableOfficialName(name)).not.toBe(name);
    }
  });
});
