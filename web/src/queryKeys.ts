export const queryKeys = {
  dashboard: () => ['dashboard'] as const,
  accounts: () => ['accounts'] as const,
  accountDetail: (id: number) => ['accounts', 'detail', id] as const,
  accountSummary: (id: number) => ['accounts', 'summary', id] as const,
  categories: () => ['categories'] as const,
  tags: () => ['tags'] as const,
  rules: () => ['rules'] as const,
  rulesMeta: () => ['rules', 'meta'] as const,
  subcategories: (categoryId: number | null | undefined) => ['subcategories', categoryId] as const,

  // Server-backed transactions list. Keep keys based on the server params we actually pass.
  transactions: (params: {
    includeTransfers: boolean
    startDate?: string
    endDate?: string
    accountId?: number | null
    categoryId?: number | null
    subcategoryId?: number | null
    tagIdsKey?: string | null
    tagsMatchAny?: boolean | null
    limit?: number | null
  }) =>
    [
      'transactions',
      params.includeTransfers,
      params.startDate ?? null,
      params.endDate ?? null,
      params.accountId ?? null,
      params.categoryId ?? null,
      params.subcategoryId ?? null,
      params.tagIdsKey ?? null,
      params.tagsMatchAny ?? null,
      params.limit ?? null,
    ] as const,

  /** Transactions scoped to one account (hub / account detail). */
  transactionsForAccount: (accountId: number, includeTransfers: boolean) =>
    ['transactions', 'account', accountId, includeTransfers] as const,

  splits: (txnId: number) => ['splits', txnId] as const,

  // Views endpoint takes a large parameter set; pass a stable string “paramsKey”.
  views: (paramsKey: string) => ['views', paramsKey] as const,

  netWorthHistory: (startDate: string, endDate: string) =>
    ['reports', 'net-worth', startDate, endDate] as const,

  importAdapters: () => ['import', 'adapters'] as const,
  csvPreview: (signature: string) => ['csvPreview', signature] as const,

  /** Bundled settings payload (categories, tags, rules, rule meta) for the Organization settings page. */
  settingsAll: () => ['settingsAll'] as const,

  // SimpleFIN
  simplefinConnections: () => ['simplefin', 'connections'] as const,
  simplefinDiscovery: (connectionId: number) => ['simplefin', 'discovery', connectionId] as const,
  simplefinSyncRuns: (connectionId: number) => ['simplefin', 'sync-runs', connectionId] as const,
  simplefinDailyBudget: (connectionId: number) => ['simplefin', 'daily-budget', connectionId] as const,

  investmentsSummary: () => ['investments', 'summary'] as const,
  investmentPortfolio: (accountId: number) => ['investments', 'portfolio', accountId] as const,
  investmentHistory: (accountId: number, limit: number) =>
    ['investments', 'history', accountId, limit] as const,
}

