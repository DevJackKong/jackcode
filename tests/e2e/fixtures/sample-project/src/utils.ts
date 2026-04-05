export function normalizeName(name: string): string {
  return name.trim();
}

export function toGreetingTarget(name: string): string {
  return name.length === 0 ? 'friend' : name;
}
