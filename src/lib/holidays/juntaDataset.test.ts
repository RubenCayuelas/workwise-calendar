import { describe, expect, it } from 'vitest';
import { holidaysForMunicipality, juntaKey, parseJuntaDataset } from './juntaDataset';

const REGIONAL = {
  id: '20269165',
  dateformat: '2026-02-28T00:00:00Z',
  event: 'VEVENT',
  date: 20260228,
  description: 'DÍA DE ANDALUCÍA',
  municipality: '',
  province: '',
  year: '2026',
  type: 'LABORAL',
};

const PRIEGO_LOCAL = {
  id: '20269176',
  dateformat: '2026-09-03T00:00:00Z',
  event: 'VEVENT',
  date: 20260903,
  description: 'FIESTA LOCAL EN PRIEGO DE CÓRDOBA (CÓRDOBA)',
  municipality: 'PRIEGO DE CÓRDOBA',
  province: 'CÓRDOBA',
  year: '2026',
  type: 'LOCAL',
};

const OTHER_TOWN_LOCAL = {
  ...PRIEGO_LOCAL,
  id: '1',
  date: 20260615,
  municipality: 'LUCENA',
  description: 'FIESTA LOCAL EN LUCENA (CÓRDOBA)',
};

describe('parsing the Junta dataset', () => {
  it('reads the integer date as a local calendar day, never the UTC instant', () => {
    expect(parseJuntaDataset([REGIONAL])).toEqual([
      { date: '2026-02-28', officialName: 'DÍA DE ANDALUCÍA', level: 'regional' },
    ]);
  });

  it('returns null for a body that is not a list of rows', () => {
    expect(parseJuntaDataset({ rows: [] })).toBeNull();
    expect(parseJuntaDataset('<html>502 Bad Gateway</html>')).toBeNull();
    expect(parseJuntaDataset(null)).toBeNull();
    expect(parseJuntaDataset([])).toBeNull();
  });

  it('DISCARDS THE WHOLE BODY when a row is malformed', () => {
    expect(parseJuntaDataset([REGIONAL, { ...PRIEGO_LOCAL, date: 20261332 }])).toBeNull();
    expect(parseJuntaDataset([REGIONAL, { ...PRIEGO_LOCAL, type: 'ESCOLAR' }])).toBeNull();
    expect(parseJuntaDataset([REGIONAL, 'oops'])).toBeNull();
  });

  it('keeps every regional day and only the named town’s local ones', () => {
    expect(holidaysForMunicipality([REGIONAL, PRIEGO_LOCAL, OTHER_TOWN_LOCAL], '14055')).toEqual([
      { date: '2026-02-28', officialName: 'DÍA DE ANDALUCÍA', level: 'regional' },
      {
        date: '2026-09-03',
        officialName: 'FIESTA LOCAL EN PRIEGO DE CÓRDOBA (CÓRDOBA)',
        level: 'local',
      },
    ]);
  });

  it('answers null for the same unusable bodies the parser refuses', () => {
    expect(holidaysForMunicipality([REGIONAL, 'oops'], '14055')).toBeNull();
    expect(holidaysForMunicipality([], '14055')).toBeNull();
  });

  it('matches a town INE writes with the article at the end', () => {
    const ejido = {
      ...PRIEGO_LOCAL,
      date: 20260815,
      municipality: 'EL EJIDO',
      province: 'ALMERÍA',
      description: 'FIESTA LOCAL EN EL EJIDO (ALMERÍA)',
    };
    expect(holidaysForMunicipality([ejido], '04902')).toHaveLength(1);
  });

  it('matches a town INE hyphenates', () => {
    const velez = {
      ...PRIEGO_LOCAL,
      date: 20260501,
      municipality: 'VÉLEZ BLANCO',
      province: 'ALMERÍA',
      description: 'FIESTA LOCAL EN VÉLEZ BLANCO (ALMERÍA)',
    };
    expect(holidaysForMunicipality([velez], '04098')).toHaveLength(1);
  });

  it('matches the ones the Junta spells its own way, which no normalising reaches', () => {
    const begijar = {
      ...PRIEGO_LOCAL,
      date: 20260501,
      municipality: 'BEJIJAR',
      province: 'JAÉN',
      description: 'FIESTA LOCAL EN BEJIJAR (JAÉN)',
    };
    expect(holidaysForMunicipality([begijar], '23014')).toHaveLength(1);
  });

  it('answers only the regional days for a town with no local ones', () => {
    expect(holidaysForMunicipality([REGIONAL, OTHER_TOWN_LOCAL], '14055')).toEqual([
      { date: '2026-02-28', officialName: 'DÍA DE ANDALUCÍA', level: 'regional' },
    ]);
  });

  it('sorts by date and keeps one row per day', () => {
    const clash = { ...PRIEGO_LOCAL, id: '2', date: 20260228 };
    const holidays = holidaysForMunicipality([PRIEGO_LOCAL, REGIONAL, clash], '14055');
    expect(holidays?.map((holiday) => holiday.date)).toEqual(['2026-02-28', '2026-09-03']);
  });
});

describe('juntaKey', () => {
  it('strips accents, upper-cases, and moves a trailing article to the front', () => {
    expect(juntaKey('Ejido, El', 'Almería')).toBe(juntaKey('EL EJIDO', 'ALMERÍA'));
    expect(juntaKey('Vélez-Blanco', 'Almería')).toBe(juntaKey('VÉLEZ BLANCO', 'ALMERÍA'));
    expect(juntaKey('  Priego de Córdoba  ', 'Córdoba')).toBe(
      juntaKey('PRIEGO DE CÓRDOBA', 'CÓRDOBA'),
    );
  });

  it('keeps two different towns apart', () => {
    expect(juntaKey('Lucena', 'Córdoba')).not.toBe(juntaKey('Lucena del Puerto', 'Huelva'));
  });
});
