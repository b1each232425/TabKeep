import type { ButtonHTMLAttributes, ReactNode } from "react"

export function StatusCard({
  title,
  value,
  tone,
}: {
  title: string
  value: string
  tone: "success" | "warning" | "error" | "neutral"
}) {
  const dotClass =
    tone === "success"
      ? "tk-status-dot"
      : tone === "error"
        ? "tk-status-dot tk-status-dot-error"
        : tone === "warning"
          ? "tk-status-dot tk-status-dot-warning"
          : "tk-status-dot bg-slate-300"
  const valueClass =
    tone === "success"
      ? "tk-status-value"
      : tone === "error"
        ? "tk-status-value tk-status-value-error"
        : tone === "warning"
          ? "tk-status-value tk-status-value-warning"
          : "mt-0.5 text-xs font-medium text-slate-500"

  return (
    <div className="tk-status-card">
      <span className={dotClass} />
      <div className="min-w-0">
        <p className="tk-status-title">{title}</p>
        <p className={`${valueClass} truncate`}>{value}</p>
      </div>
    </div>
  )
}

export function Notice({
  children,
  tone = "neutral",
}: {
  children: ReactNode
  tone?: "success" | "warning" | "neutral"
}) {
  const className =
    tone === "success"
      ? "border-green-100 bg-green-50 text-green-700 before:bg-green-500"
      : tone === "warning"
        ? "border-amber-100 bg-amber-50 text-amber-800 before:bg-amber-500"
        : "border-blue-100 bg-blue-50 text-blue-800 before:bg-blue-500"
  return (
    <div className={`relative overflow-hidden rounded-md border px-3 py-2 pl-4 text-sm leading-6 before:absolute before:inset-y-0 before:left-0 before:w-1 before:content-[''] ${className}`}>
      {children}
    </div>
  )
}

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost"
}) {
  const base =
    variant === "secondary"
      ? "tk-secondary-button"
      : variant === "ghost"
        ? "tk-ghost-button"
        : "tk-primary-button"
  return <button className={`${base} ${className}`} {...props} />
}

export function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex items-center gap-3 rounded-md border border-white/70 bg-[rgb(247_250_248)] px-3 py-2 text-sm text-slate-700 ring-1 ring-slate-900/5 transition-colors hover:bg-[rgb(250_252_250)]">
      <input
        className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-100"
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  )
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  type?: string
}) {
  return (
    <label className="tk-field">
      <span className="tk-label">{label}</span>
      <input
        className="tk-input"
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </label>
  )
}
