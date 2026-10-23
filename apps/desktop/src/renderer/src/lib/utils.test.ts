import { describe, expect, it } from 'vitest'
import { cn } from './utils'

describe('cn', () => {
  it('drops falsy values like clsx', () => {
    expect(cn('a', false && 'b', undefined, null, 'c')).toBe('a c')
  })

  it('lets a later Tailwind utility override an earlier conflicting one', () => {
    expect(cn('px-2 text-muted', 'px-4')).toBe('text-muted px-4')
    expect(cn('bg-raised', true && 'bg-accent')).toBe('bg-accent')
  })

  it('keeps utilities that do not conflict', () => {
    expect(cn('h-8 px-3', 'text-xs')).toBe('h-8 px-3 text-xs')
  })
})
