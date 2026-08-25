/**
 * The Junta de Andalucía's open-data work calendar, turned into dates. It is the source of truth for
 * WHICH days are holidays; it names the twelve regional ones and gives a local one no name at all.
 *
 * A row's `date` is an integer `YYYYMMDD` and its `dateformat` is a UTC instant. Only the integer is
 * read: deriving a calendar day from the instant is exactly the trap that puts a day on the wrong
 * date after 22:00.
 */

import { isValidDate } from '../dates';
import {
  ANDALUSIAN_MUNICIPALITIES,
  ANDALUSIAN_PROVINCES,
  JUNTA_NAME_OVERRIDES,
} from './municipalities';

export interface JuntaHoliday {
  date: string;
  /** The dataset's own words, upper case. `officialNames.ts` turns it into something readable. */
  officialName: string;
  level: 'regional' | 'local';
}

interface RawRow {
  date: number;
  description: string;
  municipality: string;
  province: string;
  type: 'LABORAL' | 'LOCAL';
}

/**
 * The comparison both sides of a municipality match go through. INE writes `Ejido, El` and
 * `Vélez-Blanco` where the dataset writes `EL EJIDO` and `VÉLEZ BLANCO`.
 */
export function juntaKey(name: string, province: string): string {
  return `${normalizeName(name)}|${normalizeName(province)}`;
}

const BY_JUNTA_KEY = new Map<string, string>(
  ANDALUSIAN_MUNICIPALITIES.map((municipality) => [
    juntaKey(municipality.name, ANDALUSIAN_PROVINCES[municipality.provinceIne] ?? ''),
    municipality.ine,
  ]),
);

/**
 * Every row of the payload, or `null`. A single malformed row discards the WHOLE body: a partial
 * list would close some days and leave others open, with nothing on screen to say which.
 */
export function parseJuntaDataset(payload: unknown): JuntaHoliday[] | null {
  const rows = readRows(payload);
  if (rows === null) return null;
  return rows.map(([row, date]) => toHoliday(row, date));
}

/** The regional days plus the local ones of `ine`, in calendar order, one row per day. */
export function holidaysForMunicipality(payload: unknown, ine: string): JuntaHoliday[] | null {
  const rows = readRows(payload);
  if (rows === null) return null;

  const wanted: JuntaHoliday[] = [];
  const seen = new Set<string>();
  for (const [row, date] of rows) {
    if (row.type === 'LOCAL' && ineOf(row) !== ine) continue;
    if (seen.has(date)) continue;
    seen.add(date);
    wanted.push(toHoliday(row, date));
  }
  return wanted.sort((a, b) => a.date.localeCompare(b.date));
}

/** Which municipality a LOCAL row belongs to: by name, since the dataset carries no INE code. */
function ineOf(row: RawRow): string | undefined {
  const key = juntaKey(row.municipality, row.province);
  return JUNTA_NAME_OVERRIDES[key] ?? BY_JUNTA_KEY.get(key);
}

/** Both entry points refuse the same bodies, so neither can accept what the other would not. */
function readRows(payload: unknown): Array<[RawRow, string]> | null {
  if (!Array.isArray(payload) || payload.length === 0) return null;

  const rows: Array<[RawRow, string]> = [];
  for (const entry of payload) {
    const row = asRow(entry);
    if (row === null) return null;
    const date = toLocalDate(row.date);
    if (date === null) return null;
    rows.push([row, date]);
  }
  return rows;
}

function toHoliday(row: RawRow, date: string): JuntaHoliday {
  return {
    date,
    officialName: row.description.trim(),
    level: row.type === 'LABORAL' ? 'regional' : 'local',
  };
}

function asRow(value: unknown): RawRow | null {
  if (value === null || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.date !== 'number') return null;
  if (typeof row.description !== 'string') return null;
  if (typeof row.municipality !== 'string' || typeof row.province !== 'string') return null;
  if (row.type !== 'LABORAL' && row.type !== 'LOCAL') return null;
  return {
    date: row.date,
    description: row.description,
    municipality: row.municipality,
    province: row.province,
    type: row.type,
  };
}

/** `20260903` -> `"2026-09-03"`. */
function toLocalDate(value: number): string | null {
  const digits = String(value);
  if (!/^\d{8}$/.test(digits)) return null;
  const date = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  return isValidDate(date) ? date : null;
}

function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toUpperCase()
    .trim()
    .replace(/^(.*),\s*(EL|LA|LOS|LAS)$/, '$2 $1')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}
