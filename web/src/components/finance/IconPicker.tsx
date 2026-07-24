// Category icon picker shared by every icon well (ManageCategoriesDialog, BudgetsPage).
// Collapsed by default: a compact grid of the original ~23 icons plus a "Show all" button.
// Expanded: a search box that filters across labeled group sections (Food, Transport, …),
// so the full ~90-icon set never reads as one undifferentiated wall. Icons come from
// categoryIcons.ts and render via iconMap's lucide bridge.

import { useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Search } from 'lucide-react'
import { CATEGORY_ICON_GROUPS, CATEGORY_ICONS_FEATURED } from '@/lib/categoryIcons'
import { iconForSymbol } from '@/lib/iconMap'

/** Human-readable name for a symbol, used for search + a11y ("cart.fill" → "cart"). */
function labelFor(symbol: string): string {
  return symbol.replace(/\.(fill|circle)/g, '').replace(/\./g, ' ')
}

function IconTile({
  symbol,
  selected,
  color,
  onSelect,
}: {
  symbol: string
  selected: boolean
  color?: string
  onSelect: (symbol: string) => void
}) {
  const Icon = iconForSymbol(symbol)
  return (
    <button
      type="button"
      onClick={() => onSelect(symbol)}
      className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-variant focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary motion-reduce:transition-none"
      style={selected && color ? { backgroundColor: `${color}22`, color } : undefined}
      aria-label={labelFor(symbol)}
      aria-pressed={selected}
      title={labelFor(symbol)}
    >
      <Icon className="h-4 w-4" />
    </button>
  )
}

export function IconPicker({
  value,
  color,
  onSelect,
}: {
  value?: string | null
  /** Category color — tints the selected tile. */
  color?: string
  onSelect: (symbol: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [query, setQuery] = useState('')

  // Collapsed set: the featured icons, plus the current selection if it isn't among them
  // (so the active choice stays visible even when it's one of the expanded-only icons).
  const featured = useMemo(() => {
    if (value && !CATEGORY_ICONS_FEATURED.includes(value)) {
      return [value, ...CATEGORY_ICONS_FEATURED]
    }
    return CATEGORY_ICONS_FEATURED
  }, [value])

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return CATEGORY_ICON_GROUPS
    return CATEGORY_ICON_GROUPS.map((g) => ({
      name: g.name,
      icons: g.icons.filter(
        (s) => labelFor(s).includes(q) || g.name.toLowerCase().includes(q),
      ),
    })).filter((g) => g.icons.length > 0)
  }, [query])

  return (
    <div className="rounded-xl bg-surface-container p-2">
      {!expanded ? (
        <>
          <div className="grid grid-cols-8 gap-1">
            {featured.map((symbol) => (
              <IconTile
                key={symbol}
                symbol={symbol}
                selected={value === symbol}
                color={color}
                onSelect={onSelect}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="mt-2 flex w-full items-center justify-center gap-1 rounded-lg py-1.5 text-xs font-medium text-primary transition-colors hover:bg-surface-variant focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary motion-reduce:transition-none"
          >
            Show all icons
            <ChevronDown aria-hidden className="h-3.5 w-3.5" />
          </button>
        </>
      ) : (
        <>
          <div className="relative mb-2">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search icons…"
              aria-label="Search icons"
              autoFocus
              className="w-full rounded-lg border border-border bg-card py-1.5 pl-8 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          <div className="max-h-64 overflow-y-auto pr-1">
            {groups.length === 0 && (
              <p className="px-1 py-4 text-center text-sm text-muted-foreground">
                No icons match “{query}”.
              </p>
            )}
            {groups.map((group) => (
              <div key={group.name} className="mb-2 last:mb-0">
                <p className="px-1 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {group.name}
                </p>
                <div className="grid grid-cols-8 gap-1">
                  {group.icons.map((symbol) => (
                    <IconTile
                      key={symbol}
                      symbol={symbol}
                      selected={value === symbol}
                      color={color}
                      onSelect={onSelect}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={() => {
              setExpanded(false)
              setQuery('')
            }}
            className="mt-2 flex w-full items-center justify-center gap-1 rounded-lg py-1.5 text-xs font-medium text-primary transition-colors hover:bg-surface-variant focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary motion-reduce:transition-none"
          >
            Show less
            <ChevronUp aria-hidden className="h-3.5 w-3.5" />
          </button>
        </>
      )}
    </div>
  )
}
