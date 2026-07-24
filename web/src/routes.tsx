// The in-app route table, shared by the signed-in app (PocketLensApp) and the
// logged-out demo (demo/DemoApp) so the demo can never drift from the real thing —
// a page added here shows up in both.

import { Navigate, Route } from 'react-router-dom'
import AccountDetailPage from '@/pages/AccountDetailPage'
import AccountsPage from '@/pages/AccountsPage'
import ActivityPage from '@/pages/ActivityPage'
import AllTransactionsPage from '@/pages/AllTransactionsPage'
import BudgetsPage from '@/pages/BudgetsPage'
import DashboardPage from '@/pages/DashboardPage'
import ExplorePage from '@/pages/ExplorePage'
import RecurringChargesPage from '@/pages/RecurringChargesPage'
import SeparateAccountDetailPage from '@/pages/SeparateAccountDetailPage'
import SettingsPage from '@/pages/SettingsPage'

/** Children of the AppLayout route. */
export const AppRouteTable = (
  <>
    <Route path="/" element={<DashboardPage />} />
    <Route path="/accounts" element={<AccountsPage />} />
    <Route path="/accounts/separate/:id" element={<SeparateAccountDetailPage />} />
    <Route path="/accounts/:accountId" element={<AccountDetailPage />} />
    {/* Import CSV is disabled — redirects to home. */}
    <Route path="/import" element={<Navigate to="/" replace />} />
    <Route path="/add-transaction" element={<Navigate to="/transactions?tab=add-transaction" replace />} />
    <Route path="/transfer" element={<Navigate to="/transactions?tab=transfers" replace />} />
    <Route path="/transfers/review" element={<Navigate to="/transactions?tab=transfers" replace />} />
    <Route path="/transactions" element={<AllTransactionsPage />} />
    <Route path="/recurring" element={<RecurringChargesPage />} />
    <Route path="/budgets" element={<BudgetsPage />} />
    <Route path="/explore" element={<ExplorePage />} />
    <Route path="/views" element={<Navigate to="/explore" replace />} />
    <Route path="/activity" element={<ActivityPage />} />
    {/* Reports removed — savings rate + spend-by graphs live on Budget now. */}
    <Route path="/reports" element={<Navigate to="/budgets" replace />} />
    <Route path="/summaries" element={<Navigate to="/budgets" replace />} />
    <Route path="/net-worth" element={<Navigate to="/accounts" replace />} />
    <Route path="/connections" element={<Navigate to="/accounts?tab=connections" replace />} />
    <Route path="/settings" element={<SettingsPage />} />
  </>
)
