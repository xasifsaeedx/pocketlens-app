import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export type FeedbackDialogProps = {
  open: boolean
  title: string
  message: string
  onClose: () => void
  actionLabel?: string
}

export default function FeedbackDialog({
  open,
  title,
  message,
  onClose,
  actionLabel = 'OK',
}: FeedbackDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="whitespace-pre-wrap">{message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={onClose}>{actionLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
