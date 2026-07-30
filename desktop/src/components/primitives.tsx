import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { AlertTriangle } from "lucide-react"

export function StatusCard({
  title,
  value,
  tone,
  icon,
  detail,
}: {
  title: string
  value: string
  tone: "success" | "warning" | "error" | "neutral"
  icon?: ReactNode
  detail?: string
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
      {icon ? <span className="tk-status-icon">{icon}</span> : <span className={dotClass} />}
      <div className="min-w-0">
        <p className="tk-status-title">{title}</p>
        <p className={`${valueClass} truncate`}>{value}</p>
        {detail && <p className="tk-status-detail truncate">{detail}</p>}
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
        : "border-teal-100 bg-teal-50 text-teal-800 before:bg-teal-500"
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

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "确认",
  cancelLabel = "取消",
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  description: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const titleId = useId()
  const descriptionId = useId()
  const cancelButton = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!open) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = window.requestAnimationFrame(() => cancelButton.current?.focus())
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return
      event.preventDefault()
      onCancel()
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener("keydown", handleKeyDown)
      previousFocus?.focus()
    }
  }, [busy, onCancel, open])

  if (!open) return null

  return createPortal(
    <div
      className="tk-confirm-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel()
      }}>
      <section
        className="tk-confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}>
        <div className="tk-confirm-dialog-body">
          <span className="tk-confirm-dialog-icon" aria-hidden="true">
            <AlertTriangle className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h2 id={titleId} className="tk-confirm-dialog-title">
              {title}
            </h2>
            <div id={descriptionId} className="tk-confirm-dialog-description">
              {description}
            </div>
          </div>
        </div>
        <div className="tk-confirm-dialog-actions">
          <button
            ref={cancelButton}
            className="tk-confirm-dialog-cancel"
            type="button"
            disabled={busy}
            onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            className="tk-confirm-dialog-confirm"
            type="button"
            disabled={busy}
            onClick={onConfirm}>
            {busy ? "正在处理..." : confirmLabel}
          </button>
        </div>
      </section>
    </div>,
    document.body,
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
    <label className="flex items-center gap-3 rounded-md border border-white/70 bg-[rgb(250_252_250)] px-3 py-2 text-sm text-slate-700 ring-1 ring-slate-900/5 transition-colors hover:border-emerald-100 hover:bg-emerald-50/35">
      <input
        className="h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-100"
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
