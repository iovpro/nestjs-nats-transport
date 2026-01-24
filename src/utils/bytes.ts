const kb = 1024;
const mb = kb * 1024;
const gb = mb * 1024;

export type unitType = 'b' | 'kb' | 'mb' | 'gb';

export function bytes(n: number, unit: unitType) {
  switch (unit) {
    case 'gb':
      return n * gb;
    case 'mb':
      return n * mb;
    case 'kb':
      return n * kb;
    case 'b':
      return n;
    default:
      return undefined;
  }
}
