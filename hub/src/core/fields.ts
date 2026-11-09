import { z } from 'zod';

/** Shared zod fragments so every module validates dates/tags/ids the same way. */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Not a real date');

export const tags = z.array(z.string().trim().min(1).max(40)).max(20);

export const limit = z.number().int().min(1).max(200).default(50);

export const text = (max: number) => z.string().max(max);

export function encodeTags(t: readonly string[] | undefined): string {
  return JSON.stringify([...new Set((t ?? []).map((s) => s.toLowerCase()))].sort());
}

export function decodeTags(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const v: unknown = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Build `SET a = ?, b = ?` from only the keys the caller actually provided. */
export function patch(fields: Record<string, string | number | boolean | null | undefined>): {
  sql: string;
  params: (string | number | boolean | null)[];
} {
  const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
  return {
    sql: keys.map((k) => `${k} = ?`).join(', '),
    params: keys.map((k) => fields[k] ?? null),
  };
}

export function money(cents: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(cents / 100);
}

export function toCents(amount: number): number {
  return Math.round(amount * 100);
}
