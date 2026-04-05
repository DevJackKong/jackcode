export function normalizeName(name) {
    return name.trim();
}
export function toGreetingTarget(name) {
    return name.length === 0 ? 'friend' : name;
}
