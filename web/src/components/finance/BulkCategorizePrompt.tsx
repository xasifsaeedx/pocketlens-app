// "Categorize similar?" confirmation shown after an explicit categorization when the
// same merchant has more uncategorized txns — mirrors the confirmationDialog in
// PocketLens/Views/Transactions/TransactionsView.swift.

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import type { UUID } from '@/types/domain'

export interface BulkPrompt {
  merchantName: string
  merchantKey: string
  categoryId: UUID
  count: number
}

export function BulkCategorizePrompt({
  prompt,
  onApply,
  onDismiss,
}: {
  prompt: BulkPrompt | null
  onApply: (prompt: BulkPrompt) => void
  onDismiss: () => void
}) {
  return (
    <AlertDialog open={prompt != null} onOpenChange={(o) => !o && onDismiss()}>
      {prompt && (
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Categorize similar?</AlertDialogTitle>
            <AlertDialogDescription>
              Apply this category to {prompt.count} other uncategorized “
              {prompt.merchantName}” transaction{prompt.count === 1 ? '' : 's'}?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={onDismiss}>Just this one</AlertDialogCancel>
            <AlertDialogAction onClick={() => onApply(prompt)}>
              Categorize {prompt.count} more
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      )}
    </AlertDialog>
  )
}
