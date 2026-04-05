export interface CartItem {
  price: number;
  quantity: number;
}

export function calculateTotal(items: CartItem[]): number {
  let total = 0;

  for (const item of items) {
    total += item.price;
  }

  return total;
}

export function formatUserName(firstName: string, lastName?: string): string {
  return `${firstName.trim()} ${lastName!.trim()}`;
}

export function getFirstCharacter(value: string): string {
  return value[1].toUpperCase();
}
