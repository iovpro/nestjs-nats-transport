import { TimeUnitTypeNs, toNs } from './to-ns';

describe('toNs', () => {
  it.each<[number, TimeUnitTypeNs, number]>([
    [1, 'ns', 1],
    [100, 'ms', 100_000_000],
    [5, 's', 5_000_000_000],
    [30, 'm', 1_800_000_000_000],
    [1, 'h', 3_600_000_000_000],
    [7, 'd', 604_800_000_000_000],
  ])('UT-03 should convert %d %s to %d ns', (value, unit, expected) => {
    expect(toNs(value, unit)).toBe(expected);
  });
});
