import type { ReactNode } from "react";

import { ErrorBoundary } from "@/src/components/ErrorBoundary";
import { ThemeToggle } from "@/src/components/theme/ThemeToggle";

export default function ReceptionistLayout({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-[hsl(var(--bg-primary))] text-[hsl(var(--text-primary))]">
        <header className="border-b border-[hsl(var(--border))] bg-[hsl(var(--bg-card)/0.85)] backdrop-blur-xl">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-4 sm:px-6 lg:px-8">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[hsl(var(--text-muted))]">Reception Desk</p>
              <h1 className="text-lg font-semibold text-[hsl(var(--text-primary))]">Patient Intake</h1>
            </div>
            <ThemeToggle />
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </ErrorBoundary>
  );
}

