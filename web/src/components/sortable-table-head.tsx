import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react'
import type { CSSProperties } from 'react'
import { TableHead } from '@/components/ui/table'
import type { ColumnSortState } from '@/lib/tableSort'
import { cn } from '@/lib/utils'

type SortableTableHeadProps = {
  label: string
  columnKey: string
  sort: ColumnSortState | null
  onSort: (key: string) => void
  align?: 'left' | 'right'
  className?: string
}

export function SortableTableHead({
  label,
  columnKey,
  sort,
  onSort,
  align = 'left',
  className,
}: SortableTableHeadProps) {
  const active = sort?.key === columnKey
  const dir = active ? sort.dir : null
  return (
    <TableHead
      className={cn(
        'text-xs cursor-pointer select-none hover:bg-muted/50',
        align === 'right' && 'text-right',
        className,
      )}
      onClick={() => onSort(columnKey)}
    >
      <span className={cn('inline-flex items-center gap-1', align === 'right' && 'justify-end w-full')}>
        {label}
        {!active ? (
          <ChevronsUpDown className="h-3 w-3 opacity-45 shrink-0" />
        ) : dir === 'asc' ? (
          <ArrowUp className="h-3 w-3 shrink-0" />
        ) : (
          <ArrowDown className="h-3 w-3 shrink-0" />
        )}
      </span>
    </TableHead>
  )
}

type SortableHtmlThProps = {
  label: string
  columnKey: string
  sort: ColumnSortState | null
  onSort: (key: string) => void
  align?: 'left' | 'right'
  style?: CSSProperties
  className?: string
}

export function SortableHtmlTh({
  label,
  columnKey,
  sort,
  onSort,
  align = 'left',
  style,
  className,
}: SortableHtmlThProps) {
  const active = sort?.key === columnKey
  const dir = active ? sort.dir : null
  return (
    <th
      className={cn(
        'border-b border-border cursor-pointer select-none hover:bg-muted/40',
        align === 'left' && 'text-left',
        align === 'right' && 'text-right',
        className,
      )}
      style={{ padding: 8, ...style }}
      onClick={() => onSort(columnKey)}
    >
      <span className={cn('inline-flex items-center gap-1', align === 'right' && 'justify-end w-full')}>
        {label}
        {!active ? (
          <ChevronsUpDown className="h-3 w-3 opacity-45 shrink-0" />
        ) : dir === 'asc' ? (
          <ArrowUp className="h-3 w-3 shrink-0" />
        ) : (
          <ArrowDown className="h-3 w-3 shrink-0" />
        )}
      </span>
    </th>
  )
}
