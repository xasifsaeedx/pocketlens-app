import { describe, it, expect } from 'vitest'
import { Tag } from 'lucide-react'
import { CATEGORY_ICONS, CATEGORY_ICON_GROUPS } from './categoryIcons'
import { iconForSymbol } from './iconMap'

describe('category icon palette', () => {
  it('offers a large, well-organized set', () => {
    expect(CATEGORY_ICONS.length).toBeGreaterThanOrEqual(90)
    expect(CATEGORY_ICON_GROUPS.length).toBeGreaterThanOrEqual(10)
  })

  it('has no duplicate symbols', () => {
    expect(new Set(CATEGORY_ICONS).size).toBe(CATEGORY_ICONS.length)
  })

  it('maps every pickable symbol to a real lucide icon (no Tag fallback except tag itself)', () => {
    for (const symbol of CATEGORY_ICONS) {
      const Icon = iconForSymbol(symbol)
      if (symbol === 'tag.fill' || symbol === 'tag') {
        expect(Icon).toBe(Tag)
      } else {
        expect(Icon, `${symbol} should map to a non-fallback icon`).not.toBe(Tag)
      }
    }
  })
})
