import { Link, useLocation } from "react-router-dom";
import { isNavActive, primaryNav } from "@/lib/nav";
import { cn } from "@/lib/utils";

export default function BottomNavBar() {
  const { pathname } = useLocation();

  return (
    // Floating capsule: a rounded, elevated bar inset from the screen edges with
    // safe-area padding underneath, rather than a full-width docked strip.
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-[calc(0.5rem+env(safe-area-inset-bottom))] md:hidden">
      <nav
        aria-label="Primary"
        className="pointer-events-auto flex w-full max-w-md items-center justify-around gap-1 rounded-full border border-border bg-surface/95 px-2 py-2 shadow-overlay backdrop-blur"
      >
        {primaryNav.map((item) => {
          const active = isNavActive(pathname, item.to);
          const Icon = item.icon;
          return (
            <Link
              key={item.to}
              to={item.to}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex flex-1 flex-col items-center justify-center rounded-full px-2 py-1.5 transition-colors duration-200 active:scale-90",
                active
                  ? "bg-secondary-container text-on-secondary-container"
                  : "text-muted-foreground hover:bg-surface-container-high",
              )}
            >
              <Icon className="h-5 w-5" strokeWidth={active ? 2.5 : 2} />
              <span className="mt-0.5 text-[0.65rem] font-semibold tracking-wide">
                {item.label}
              </span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
