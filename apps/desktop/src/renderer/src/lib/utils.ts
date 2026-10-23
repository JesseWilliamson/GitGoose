import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/**
 * tailwind-merge only knows Tailwind's own scale. Ours has extra names (styles.css, "THE SCALE"):
 * without them `text-2xs` would be taken for a colour and `h-input` for something it has never
 * heard of, and `cn('text-2xs', 'text-muted-foreground')` would silently drop one of the two.
 */
const HEIGHTS = ['row', 'row-lg', 'input', 'toolbar', 'tabbar', 'strip', 'statusbar']
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['2xs'] }],
      h: [{ h: HEIGHTS }],
      'min-h': [{ 'min-h': HEIGHTS }],
    },
  },
})

/**
 * Class names, merged. `clsx` drops falsy values; `twMerge` lets a later Tailwind utility win over
 * an earlier one (`cn('px-2', 'px-4')` is `px-4`), which is what lets a caller override a
 * component's default look with `className`. shadcn's generated components import this.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
