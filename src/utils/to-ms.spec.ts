import { TimeUnitType, toMs } from './to-ms';

describe('toMs', () => {
  it.each<[number, TimeUnitType, number]>([
    [500, 'ms', 500],
    [5, 's', 5_000],
    [2, 'm', 120_000],
    [1, 'h', 3_600_000],
    [1, 'd', 86_400_000],
    [1, 'w', 604_800_000],
  ])('UT-01 should convert %d %s to %d ms', (value, unit, expected) => {
    expect(toMs(value, unit)).toBe(expected);
  });

  it('UT-02 should convert nanoseconds to milliseconds', () => {
    expect(toMs(5_000_000, 'ns')).toBe(5);
  });
});
