/**
 * The dataset writes every name in upper case and gives a local holiday no name at all. This maps its
 * strings onto the keys under `holidayNames.*` in the locale files, which is where the wording lives —
 * a holiday's note is prose the data layer produces, so it is composed in the language the owner is
 * READING rather than hard-coded here.
 *
 * Three of the strings appear in two spellings: 2026 says `FESTIVIDAD DE ASUNCIÓN DE LA VIRGEN` where
 * 2027 says `ASUNCIÓN DE LA VIRGEN`. That is why the map is keyed by the exact string and never by the
 * date. The list is every distinct `LABORAL` description published between 2023 and 2027; an unknown
 * one is not an error, and reads through as it came.
 */

/** What a local holiday is called until festivos.io publishes its real name. */
export const LOCAL_HOLIDAY_KEY = 'localHoliday';

const KEYS: Readonly<Record<string, string>> = {
  'AÑO NUEVO': 'newYear',
  'EPIFANÍA DEL SEÑOR': 'epiphany',
  'DÍA DE ANDALUCÍA': 'andalusiaDay',
  'JUEVES SANTO': 'maundyThursday',
  'VIERNES SANTO': 'goodFriday',
  'FIESTA DEL TRABAJO': 'labourDay',
  'ASUNCIÓN DE LA VIRGEN': 'assumption',
  'FESTIVIDAD DE ASUNCIÓN DE LA VIRGEN': 'assumption',
  'FIESTA NACIONAL DE ESPAÑA': 'nationalDay',
  'TODOS LOS SANTOS': 'allSaints',
  'FIESTA DE TODOS LOS SANTOS': 'allSaints',
  'DÍA DE LA CONSTITUCIÓN ESPAÑOLA': 'constitutionDay',
  'INMACULADA CONCEPCIÓN': 'immaculateConception',
  'DÍA DE LA INMACULADA CONCEPCIÓN': 'immaculateConception',
  'NATIVIDAD DEL SEÑOR': 'christmas',
  // The 2023 rows carry no name of their own, only the category.
  'FIESTA LABORAL PARA ANDALUCÍA': 'regionalHoliday',
};

export function officialNameKey(published: string): string | undefined {
  return KEYS[published.trim()];
}
