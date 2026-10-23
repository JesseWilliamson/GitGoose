import { describe, expect, it } from 'vitest'
import { cn } from './utils'

describe('cn', () => {
  it('drops falsy values like clsx', () => {
    expect(cn('a', false && 'b', undefined, null, 'c')).toBe('a c')
  })

  it('lets a later Tailwind utility override an earlier conflicting one', () => {
    expect(cn('px-2 text-muted-foreground', 'px-4')).toBe('text-muted-foreground px-4')
    expect(cn('bg-popover', true && 'bg-primary')).toBe('bg-primary')
  })

  it('keeps utilities that do not conflict', () => {
    expect(cn('h-8 px-3', 'text-xs')).toBe('h-8 px-3 text-xs')
  })
})

describe('cn with the app scale (styles.css)', () => {
  it('knows our type size is a size, not a colour', () => {
    expect(cn('text-2xs text-muted-foreground')).toBe('text-2xs text-muted-foreground')
    expect(cn('text-sm', 'text-2xs')).toBe('text-2xs')
  })

  it('knows our heights', () => {
    expect(cn('h-9', 'h-input')).toBe('h-input')
    expect(cn('h-input', 'h-row')).toBe('h-row')
    expect(cn('h-input px-2', 'px-3')).toBe('h-input px-3')
  })
})
