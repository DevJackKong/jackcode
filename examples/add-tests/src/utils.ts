export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function groupByLength(values: string[]): Record<number, string[]> {
  const result: Record<number, string[]> = {};

  for (const value of values) {
    const key = value.length;

    if (!result[key]) {
      result[key] = [];
    }

    result[key].push(value);
  }

  return result;
}

export function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }

  if (value > max) {
    return max;
  }

  return value;
}
