import { bytes, unitType } from './bytes';

describe('bytes', () => {
  it.each<[number, unitType, number]>([
    [10, 'b', 10],
    [1, 'kb', 1_024],
    [5, 'mb', 5_242_880],
    [1, 'gb', 1_073_741_824],
  ])('UT-04 should convert %d %s to %d bytes', (value, unit, expected) => {
    expect(bytes(value, unit)).toBe(expected);
  });
});
