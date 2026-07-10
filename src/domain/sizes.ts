export const SIZES = ["XS", "S", "M", "L", "XL", "XXL", "XXXL"] as const;
export type Size = (typeof SIZES)[number];

// Budget math: 1 unit = M = ~200 kcal midpoint.
export const SIZE_UNITS: Record<Size, number> = {
  XS: 0.25,
  S: 0.5,
  M: 1,
  L: 2,
  XL: 3,
  XXL: 4,
  XXXL: 6,
};

export const SIZE_KCAL_MID: Record<Size, number> = {
  XS: 50,
  S: 100,
  M: 200,
  L: 400,
  XL: 600,
  XXL: 800,
  XXXL: 1200,
};

// Bucket boundaries sit between midpoints. Food rounds up on a boundary,
// exercise rounds down (conservative in both directions — see SPEC §3.1).
const BOUNDARIES: Array<[number, Size]> = [
  [75, "XS"],
  [150, "S"],
  [300, "M"],
  [500, "L"],
  [700, "XL"],
  [1000, "XXL"],
];

export function bucketFood(kcal: number): Size {
  for (const [limit, size] of BOUNDARIES) if (kcal < limit) return size;
  return "XXXL";
}

export function bucketExercise(kcal: number): Size {
  for (const [limit, size] of BOUNDARIES) if (kcal <= limit) return size;
  return "XXXL";
}

export function isSize(value: string): value is Size {
  return (SIZES as readonly string[]).includes(value);
}

// Exercise earns back only half its units — burn estimates skew high and
// "exercise to eat" is a loop we refuse to reinforce (SPEC §3.2).
export const EXERCISE_CREDIT = 0.5;
