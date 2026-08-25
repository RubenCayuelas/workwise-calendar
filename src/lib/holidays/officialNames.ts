/**
 * The dataset writes every name in upper case and gives a local holiday no name at all. Spanish
 * title-casing is not an algorithm — `DÍA DE LA CONSTITUCIÓN ESPAÑOLA` keeps two words lower and
 * capitalises a third — so the strings the calendar actually uses are written out.
 *
 * Three of them appear in two spellings: 2026 says `FESTIVIDAD DE ASUNCIÓN DE LA VIRGEN` where 2027
 * says `ASUNCIÓN DE LA VIRGEN`. That is why the key is the exact string and never the date.
 *
 * The list is every distinct `LABORAL` description in the published dataset, measured over 2023-2027.
 * An unknown one is not an error — it is passed through as it came, upper case and all.
 */

/** What a local holiday is called until festivos.io publishes its real name. */
export const GENERIC_LOCAL_NAME = 'Fiesta local';

const NAMES: Readonly<Record<string, string>> = {
  'AÑO NUEVO': 'Año Nuevo',
  'EPIFANÍA DEL SEÑOR': 'Epifanía del Señor',
  'DÍA DE ANDALUCÍA': 'Día de Andalucía',
  'JUEVES SANTO': 'Jueves Santo',
  'VIERNES SANTO': 'Viernes Santo',
  'FIESTA DEL TRABAJO': 'Fiesta del Trabajo',
  'ASUNCIÓN DE LA VIRGEN': 'Asunción de la Virgen',
  'FESTIVIDAD DE ASUNCIÓN DE LA VIRGEN': 'Asunción de la Virgen',
  'FIESTA NACIONAL DE ESPAÑA': 'Fiesta Nacional de España',
  'TODOS LOS SANTOS': 'Todos los Santos',
  'FIESTA DE TODOS LOS SANTOS': 'Todos los Santos',
  'DÍA DE LA CONSTITUCIÓN ESPAÑOLA': 'Día de la Constitución Española',
  'INMACULADA CONCEPCIÓN': 'Inmaculada Concepción',
  'DÍA DE LA INMACULADA CONCEPCIÓN': 'Inmaculada Concepción',
  'NATIVIDAD DEL SEÑOR': 'Natividad del Señor',
  // The 2023 rows carry no name of their own, only the category.
  'FIESTA LABORAL PARA ANDALUCÍA': 'Fiesta laboral',
};

export function readableOfficialName(upperCase: string): string | undefined {
  return NAMES[upperCase.trim()];
}
