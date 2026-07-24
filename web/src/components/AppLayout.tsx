import { useEffect } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import BottomNavBar from "@/components/BottomNavBar";
import TopAppBar from "@/components/TopAppBar";
import { PageTransition } from "@/lib/motion";
import { desktopNav } from "@/lib/nav";

// Drives document.title everywhere. Titles default to the nav labels in
// lib/nav.ts (the single nav config); entries below are only non-nav routes
// and overrides. Every page now owns its visible heading.
const pageMeta: Record<string, { title: string }> = {
  ...Object.fromEntries(
    desktopNav.map((item) => [item.to, { title: item.label }]),
  ),
  "/activity": { title: "Activity" },
  "/import": { title: "Import CSV" },
  "/add-transaction": { title: "Transactions" },
  "/transfer": { title: "Transactions" },
  "/transfers/review": { title: "Transactions" },
  "/recurring": { title: "Recurring charges" },
  "/net-worth": { title: "Net worth" },
  "/connections": { title: "Connections" },
};

export default function AppLayout() {
  const location = useLocation();
  const navigate = useNavigate();

  // Fresh signup (flag set by LoginPage): route straight to Settings with the
  // bank-connection wizard highlighted, instead of an empty dashboard.
  useEffect(() => {
    if (sessionStorage.getItem("fresh-signup")) {
      sessionStorage.removeItem("fresh-signup");
      navigate("/settings?setup=1", { replace: true });
    }
  }, [navigate]);

  const meta =
    pageMeta[location.pathname] ??
    (location.pathname.startsWith("/accounts/") ? { title: "Account" } : { title: "" });

  useEffect(() => {
    document.title = meta.title ? `${meta.title} — PocketLens` : "PocketLens";
  }, [meta.title]);

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <TopAppBar />
      <main className="page-container flex-1 pb-28 pt-2 md:pb-10">
        <PageTransition key={location.pathname}>
          <Outlet />
        </PageTransition>
      </main>
      <BottomNavBar />
    </div>
  );
}
