"use client";

import type { ReactNode } from "react";
import { OperationsProvider } from "@/components/OperationsProvider";
import { TopNav } from "@/components/TopNav";

/**
 * Persistent chrome for (app) routes — TopNav stays mounted across navigations
 * so the active-tab underline can slide instead of remount-jumping.
 */
export function AppChrome({ children }: { children: ReactNode }) {
  return (
    <OperationsProvider>
      <TopNav />
      {children}
    </OperationsProvider>
  );
}
