export function add(a: number, b: number): number { return a + b; }
export function subtract(a: number, b: number): number { return a - b; }
export class Calculator { add = add; subtract = subtract; }
