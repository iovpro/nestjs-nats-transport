const ms = 1;
const s = ms * 1000;
const m = s * 60;
const h = m * 60;
const d = h * 24;
const w = d * 7;
const y = d * 365.25;

export type TimeUnitType = 'ns' | 'ms' | 's' | 'm' | 'h' | 'd' | 'w' | 'y';

export function toMs(n: number, unit: TimeUnitType) {
  switch (unit) {
    case 'y':
      return n * y;
    case 'w':
      return n * w;
    case 'd':
      return n * d;
    case 'h':
      return n * h;
    case 'm':
      return n * m;
    case 's':
      return n * s;
    case 'ms':
      return n * ms;
    case 'ns':
      return n;
    default:
      return undefined;
  }
}
