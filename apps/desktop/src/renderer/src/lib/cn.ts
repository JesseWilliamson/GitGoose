import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Class names, merged. `clsx` drops falsy values; `twMerge` lets a later Tailwind utility win over
 * an earlier one (`cn('px-2', 'px-4')` is `px-4`), which is what lets a caller override a
 * component's default look with `className`.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
