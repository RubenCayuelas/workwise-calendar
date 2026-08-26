import { describe, expect, it } from 'vitest';
import {
  ANDALUSIAN_MUNICIPALITIES,
  ANDALUSIAN_PROVINCES,
  JUNTA_NAME_OVERRIDES,
  findMunicipality,
} from './municipalities';

describe('the Andalusian municipality list', () => {
  it('holds every municipality of the eight provinces', () => {
    expect(ANDALUSIAN_MUNICIPALITIES.length).toBe(785);
    expect(Object.keys(ANDALUSIAN_PROVINCES).sort()).toEqual([
      '04',
      '11',
      '14',
      '18',
      '21',
      '23',
      '29',
      '41',
    ]);
  });

  it('finds the shop by its INE code, which is the default setting', () => {
    expect(findMunicipality('14055')).toEqual({
      ine: '14055',
      name: 'Priego de Córdoba',
      provinceIne: '14',
    });
  });

  it('answers nothing for a code that is not Andalusian', () => {
    expect(findMunicipality('28079')).toBeUndefined();
  });

  it('every INE code is five digits and unique', () => {
    const codes = ANDALUSIAN_MUNICIPALITIES.map((municipality) => municipality.ine);
    expect(codes.every((code) => /^\d{5}$/.test(code))).toBe(true);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('every municipality belongs to a province the list names', () => {
    for (const municipality of ANDALUSIAN_MUNICIPALITIES) {
      expect(ANDALUSIAN_PROVINCES[municipality.provinceIne], municipality.name).toBeDefined();
    }
  });

  it('every override points at a municipality that is in the list', () => {
    for (const ine of Object.values(JUNTA_NAME_OVERRIDES)) {
      expect(findMunicipality(ine), `override for ${ine}`).toBeDefined();
    }
  });
});
