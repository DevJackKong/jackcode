export function divide(a: number, b: number): number {
  if (b === 0) {
    return 0;
  }

  return a / b;
}

export function percentage(part: number, total: number): number {
  return Math.round((part / total) * 10000) / 100;
}

export function parseAndAdd(a: string, b: string): number {
  return Number(a) + Number(b);
}

export function average(values: number[]): number {
  let total = 0;

  for (const value of values) {
    total += value;
  }

  return total / values.length;
}
