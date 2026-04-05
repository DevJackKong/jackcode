import { normalizeName, toGreetingTarget } from './utils.js';
export function greet(name) {
    const normalized = normalizeName(name);
    return `Hello, ${toGreetingTarget(normalized)}!`;
}
export function greetAll(names) {
    return names.map((name) => {
        const normalized = normalizeName(name);
        return `Hello, ${toGreetingTarget(normalized)}!`;
    });
}
