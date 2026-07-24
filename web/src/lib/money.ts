// Money conventions mirror the iOS app:
//   transactions.amount  -> POSITIVE = money out (spend/debit), NEGATIVE = money in (income)
//   net worth / balances -> plain signed numbers
// The UI shows magnitude only; income is green, expense is red (Keep's money tokens).

const currencyFmt = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
})

/** "$1,234.56" — signed. Tolerant of arbitrary/unknown ISO codes — investment holdings
 *  can carry any currency Plaid returns; falls back to "12.34 XYZ" if Intl rejects the code. */
export function formatCurrency(n: number, currency = 'USD'): string {
  if (currency === 'USD') return currencyFmt.format(n)
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(n)
  } catch {
    return `${n.toFixed(2)} ${currency}`
  }
}

/** Magnitude only, e.g. "$65.00" (used for transaction rows like iOS AmountText). */
export function formatAmount(n: number, currency = 'USD'): string {
  return formatCurrency(Math.abs(n), currency)
}

/** True when a transaction amount represents spend (money out). */
export function isDebit(amount: number): boolean {
  return amount > 0
}

/** Tailwind text color class for a transaction amount (Keep money tokens). */
export function amountColorClass(amount: number): string {
  return amount > 0 ? 'text-money-expense' : 'text-money-income'
}
