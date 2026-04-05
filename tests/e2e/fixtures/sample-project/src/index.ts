import { normalizeName, toGreetingTarget } from './utils.js';

export function greet(name: string): string {
  const normalized = normalizeName(name);
  return `Hello, ${toGreetingTarget(normalized)}!`;
}

export function greetAll(names: string[]): string[] {
  return names.map((name) => {
    const normalized = normalizeName(name);
    return `Hello, ${toGreetingTarget(normalized)}!`;
  });
}
