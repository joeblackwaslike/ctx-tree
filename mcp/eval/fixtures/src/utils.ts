export function slugify(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '');
}
export const VERSION = '1.0.0';
