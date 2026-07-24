// Manual "separate" account types + labels. Mirrors iOS separateAccountTypes
// (SeparateAccountViews.swift). depository/investment/other are assets;
// credit/loan are liabilities (see isLiabilityType).

export const SEPARATE_ACCOUNT_TYPES: { value: string; label: string }[] = [
  { value: 'depository', label: 'Cash' },
  { value: 'investment', label: 'Investments' },
  { value: 'other', label: 'Other asset' },
  { value: 'loan', label: 'Loan' },
  { value: 'credit', label: 'Credit / debt' },
]

export function separateAccountTypeLabel(type: string): string {
  return SEPARATE_ACCOUNT_TYPES.find((t) => t.value === type)?.label ?? type
}
