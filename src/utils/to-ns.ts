const ms = 1_000_000;
const s = ms * 1000;
const m = s * 60;
const h = m * 60;
const d = h * 24;
const w = d * 7;
const y = d * 365.25;

export type TimeUnitTypeNs = 'ns' | 'ms' | 's' | 'm' | 'h' | 'd' | 'w' | 'y';

/**
 * Converts a time value to nanoseconds
 * Useful for JetStream configuration options like ack_wait, idle_heartbeat, etc.
 *
 * @example
 * toNs(5, 's')  // 5_000_000_000 (5 seconds in nanoseconds)
 * toNs(30, 'm') // 1_800_000_000_000 (30 minutes in nanoseconds)
 *
 * @publicApi
 */
export function toNs(n: number, unit: TimeUnitTypeNs) {
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
