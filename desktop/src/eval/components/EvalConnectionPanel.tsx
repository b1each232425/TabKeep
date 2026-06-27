import { CheckCircle2, Settings2 } from "lucide-react"

import { Button, TextField } from "./EvalControls"

export function EvalConnectionPanel({
  apiBaseUrl,
  apiToken,
  loading,
  onApiBaseUrlChange,
  onApiTokenChange,
  onSaveConnection,
}: {
  apiBaseUrl: string
  apiToken: string
  loading: boolean
  onApiBaseUrlChange: (value: string) => void
  onApiTokenChange: (value: string) => void
  onSaveConnection: () => void
}) {
  return (
    <section className="tk-panel">
      <div className="tk-panel-header">
        <div>
          <h2 className="tk-panel-title">连接</h2>
          <p className="text-xs text-muted-foreground">浏览器直连 TabKeep 后端</p>
        </div>
        <Settings2 className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="tk-panel-body">
        <div className="grid gap-3 lg:grid-cols-[minmax(260px,1fr)_minmax(260px,1fr)_auto]">
          <TextField
            label="API BaseURL"
            value={apiBaseUrl}
            onChange={onApiBaseUrlChange}
            placeholder="http://127.0.0.1:38471"
          />
          <TextField
            label="API Token"
            type="password"
            value={apiToken}
            onChange={onApiTokenChange}
            placeholder="开发模式可留空"
          />
          <div className="flex items-end">
            <Button onClick={onSaveConnection} disabled={loading}>
              <CheckCircle2 className="h-4 w-4" />
              应用连接
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}
