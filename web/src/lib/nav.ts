import { Compass, Home, Landmark, ReceiptText, Settings, Wallet, type LucideIcon } from "lucide-react";

type NavItem = { label: string; to: string; icon: LucideIcon };

const home: NavItem = { label: "Home", to: "/", icon: Home };
const transactions: NavItem = { label: "Transactions", to: "/transactions", icon: ReceiptText };
const budget: NavItem = { label: "Budget", to: "/budgets", icon: Wallet };
const explore: NavItem = { label: "Explore", to: "/explore", icon: Compass };
const balances: NavItem = { label: "Balances", to: "/accounts", icon: Landmark };
const settings: NavItem = { label: "Settings", to: "/settings", icon: Settings };

/** Mobile bottom capsule — the five primary sections (Explore is desktop-only). */
export const primaryNav: NavItem[] = [home, transactions, budget, balances, settings];

/** Desktop top bar — same sections plus Explore, ordered before Balances. */
export const desktopNav: NavItem[] = [home, transactions, budget, explore, balances, settings];

/** Active-route matching: exact for "/", prefix for section roots so
 *  /accounts/:id highlights Balances. Query params are ignored (pathname only). */
export function isNavActive(pathname: string, to: string): boolean {
  if (to === "/") return pathname === "/";
  return pathname === to || pathname.startsWith(`${to}/`);
}
