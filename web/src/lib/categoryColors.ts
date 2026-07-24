// Category color helpers. Categories carry their own stored hex color (domain.Category
// `color`, e.g. "#34C759"); these keep that identity consistent everywhere:
//   - categoryTint      -> a translucent "well" background of the category color
//   - categorySeriesColor -> the category's own solid color for chart series
// Neither invents or rank-assigns hues; a category is the SAME color in every surface.

/** Anything carrying a stored category/tag hex color. */
type Colored = { color?: string | null }

const DEFAULT_HEX = '#98989D' // neutral gray, matches CategoryIcon's fallback

/** Normalize to a usable `#rrggbb`; falls back to neutral gray for empty/invalid input. */
function safeHex(hex?: string | null): string {
  if (typeof hex === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex.trim())) {
    return hex.trim()
  }
  return DEFAULT_HEX
}

/**
 * Translucent well background derived from a category color — legible in both light and
 * dark because the low alpha (~13%) tints the underlying surface rather than painting
 * over it. Mirrors the existing `${color}22` pattern (CategoryBadge).
 *
 * @param hex category color, e.g. "#34C759"
 * @returns an 8-digit hex with alpha, e.g. "#34C75922"
 */
export function categoryTint(hex: string): string {
  return `${safeHex(hex)}22`
}

/**
 * IDENTITY-STABLE series color for charts and legends: returns the category's own stored
 * color so a category renders the same hue in every donut/bar/list. Never a rank- or
 * rainbow-based assignment. Accepts a Category-like object or a raw hex string.
 */
export function categorySeriesColor(category: Colored | string | null | undefined): string {
  if (typeof category === 'string') return safeHex(category)
  return safeHex(category?.color)
}
