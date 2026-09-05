import { clsx } from 'clsx';
import type { ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Conditional classes, with later Tailwind utilities beating earlier ones.
 *
 * `clsx` alone would emit `px-2 px-4` and let the stylesheet's source order
 * decide — which is the bug where a variant prop appears to do nothing on one
 * component and work on its neighbour. `twMerge` resolves the conflict by
 * position in the call instead, so a caller's override always wins.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
