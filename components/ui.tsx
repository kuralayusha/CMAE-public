"use client";

import type { CSSProperties, ReactNode } from "react";
import { useLocaleUpper } from "@/components/I18nProvider";
import { PageHelp } from "@/components/PageHelp";
import type { AppPageId } from "@/lib/help/pages";

export function PageShell({
  title,
  subtitle,
  helpPageId,
  children,
}: {
  title: string;
  subtitle?: string;
  /** When set, shows Help on the title row (state stays local — no page re-render). */
  helpPageId?: AppPageId;
  children: ReactNode;
}) {
  return (
    <main className="cmae-shell">
      <div className="cmae-shell-head">
        <div className="cmae-shell-head-title">
          <h1>{title}</h1>
          {helpPageId ? <PageHelp pageId={helpPageId} /> : null}
        </div>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {children}
    </main>
  );
}

export function Button({
  children,
  variant = "primary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger";
}) {
  const variantClass =
    variant === "ghost"
      ? "cmae-btn-ghost"
      : variant === "danger"
        ? "cmae-btn-danger"
        : "cmae-btn-primary";

  return (
    <button
      {...props}
      className={`cmae-btn ${variantClass}${className ? ` ${className}` : ""}`}
      style={props.style}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const upper = useLocaleUpper();
  return (
    <label className="cmae-field">
      <span className="cmae-field-label">{upper(label)}</span>
      {children}
      {hint ? <span className="cmae-field-hint">{hint}</span> : null}
    </label>
  );
}

/** Prefer className "cmae-input" — kept for textarea/select inline overrides */
export const inputStyle: CSSProperties = {
  padding: "0 12px",
  height: 40,
  borderRadius: "var(--radius)",
  border: "1px solid var(--line)",
  background: "var(--bg-elevated)",
  fontSize: 14,
  color: "var(--ink)",
  width: "100%",
  fontFamily: "var(--font-body), sans-serif",
  letterSpacing: "-0.01em",
  outline: "none",
};
