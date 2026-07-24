// Institution logo from Plaid (base64 PNG on plaid_items); generic bank
// glyph when the institution has none or the image fails to decode.
// Mirrors iOS InstitutionLogoView.
//
// The raw Plaid PNG sits on a proper plate: a card-colored well with a 1px
// border ring and a subtle shadow-card, so transparent/white logos read
// cleanly in both light and dark. Size comes from the caller's className.
//
// Renders a plain <img> rather than radix Avatar: radix defers the image
// behind an internal load-status hook that never resolved for these data: URIs
// on web, so real bank logos silently fell back to the generic glyph. A plain
// <img> with an onError fallback shows the actual logo (matching iOS).

import { useEffect, useState } from 'react'
import { Building2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export function InstitutionLogo({
  logo,
  className,
}: {
  logo?: string | null
  className?: string
}) {
  const [failed, setFailed] = useState(false)
  // Reset the error state when the logo changes (rows recycle on scroll/refetch).
  useEffect(() => setFailed(false), [logo])

  const showImage = Boolean(logo) && !failed

  return (
    <div
      className={cn(
        'relative flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-card shadow-card',
        className,
      )}
    >
      {showImage ? (
        <img
          src={`data:image/png;base64,${logo}`}
          alt=""
          aria-hidden
          className="h-full w-full object-contain p-[2px]"
          onError={() => setFailed(true)}
        />
      ) : (
        <Building2 aria-hidden className="h-[55%] w-[55%] text-primary" />
      )}
    </div>
  )
}
