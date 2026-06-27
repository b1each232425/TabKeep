import type { ButtonHTMLAttributes } from "react"

export function Notice({
  children,
  tone = "neutral",
}: {
  children: string
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
    <label className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-white/70 px-3 py-2 text-sm text-slate-700">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  )
}
