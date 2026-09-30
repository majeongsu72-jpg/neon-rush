/** Staggered two-wide starting grid behind the start line (s = 0). */
export function gridSlot(i: number): { s: number; d: number } {
  const row = Math.floor(i / 2);
  const side = i % 2 === 0 ? -1 : 1;
  return { s: -(12 + row * 11 + (side > 0 ? 5.5 : 0)), d: side * 3.3 };
}

export const GRID_SIZE = 8;
