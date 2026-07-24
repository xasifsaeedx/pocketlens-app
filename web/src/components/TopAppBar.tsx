import { LogOut, Settings as SettingsIcon, User } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import NotificationCenter from "@/components/finance/NotificationCenter";
import { Button } from "@/components/ui/button";
import { useDemo } from "@/demo/demoContext";
import { useAuth } from "@/lib/auth";
import { desktopNav, isNavActive } from "@/lib/nav";
import { cn } from "@/lib/utils";

// Desktop primary-nav pill: an active route gets a sage container pill (the same
// active token the floating bottom nav uses), so the current section reads the same
// on both. Existing tokens only — no new hues.
function desktopNavClass(active: boolean): string {
  return cn(
    "flex items-center gap-1 rounded-full px-3 py-1.5 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    active
      ? "bg-secondary-container font-semibold text-on-secondary-container"
      : "font-medium text-muted-foreground hover:bg-surface-container-high hover:text-primary",
  );
}

export default function TopAppBar() {
  const { pathname } = useLocation();
  const { user, signOut } = useAuth();
  const demo = useDemo();
  const initial = user?.email?.charAt(0).toUpperCase();

  return (
    <header className="sticky top-0 z-40 w-full border-b border-border/60 bg-background/80 backdrop-blur-sm">
      {/* h-[72px] is pinned — AllTransactionsPage's sticky bar offsets by it (top-[72px]) */}
      <div className="page-container flex h-[72px] items-center justify-between">
        <div className="flex items-center gap-3">
          {/* Profile affordance: opens account menu (identity + Settings + Sign out).
              The demo has no account to manage — it shows a "Demo" marker instead, which
              also keeps a permanent reminder on screen that the numbers are invented. */}
          {demo ? (
            <span className="rounded-full bg-secondary-container px-3 py-1 text-xs font-semibold uppercase tracking-wide text-on-secondary-container">
              Demo
            </span>
          ) : (
          <DropdownMenu>
            <DropdownMenuTrigger
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-variant text-primary transition-colors hover:bg-surface-container-high focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Account menu"
            >
              {initial ? (
                <span className="text-sm font-semibold">{initial}</span>
              ) : (
                <User className="h-5 w-5" />
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              {user?.email && (
                <>
                  <DropdownMenuLabel className="truncate font-normal text-muted-foreground">
                    {user.email}
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem asChild>
                <Link to="/settings" className="w-full cursor-pointer">
                  <SettingsIcon className="mr-2 h-4 w-4" />
                  Settings
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="cursor-pointer text-destructive focus:text-destructive"
                onSelect={() => void signOut()}
              >
                <LogOut className="mr-2 h-4 w-4" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          )}
          <span className="hidden font-serif text-xl font-semibold tracking-normal text-primary md:block">
            PocketLens
          </span>
        </div>

        <nav className="hidden items-center gap-1 md:flex" aria-label="Primary">
          {desktopNav.map((item) => {
            const active = isNavActive(pathname, item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                aria-current={active ? "page" : undefined}
                className={desktopNavClass(active)}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-1">
          <NotificationCenter />
          {demo && (
            <>
              <Button asChild variant="ghost" size="sm">
                <Link to="/login">Log in</Link>
              </Button>
              <Button asChild variant="pill" size="sm">
                <Link to="/signup">Sign up</Link>
              </Button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
