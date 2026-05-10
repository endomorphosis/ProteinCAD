'use client'

import { useEffect, useMemo, useState } from 'react'
import { mcpClient } from '@/lib/mcp-client'
import { ServiceStatus as ServiceStatusType } from '@/lib/types'

export default function ServiceStatus() {
  const [status, setStatus] = useState<ServiceStatusType | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const loadStatus = async () => {
    try {
      const serviceStatus = await mcpClient.getServiceStatus()
      setStatus(serviceStatus)
      setLoadError(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('Failed to load service status:', message)
      setLoadError(message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadStatus()
    const interval = setInterval(loadStatus, 10000)
    return () => clearInterval(interval)
  }, [])

  const warnings = useMemo(() => {
    if (!status || typeof status !== 'object') return []

    const collectedWarnings: Array<{ key: string; message: string; detail?: string }> = []
    for (const [service, info] of Object.entries(status)) {
      if (!info || typeof info !== 'object') continue

      const serviceState = String((info as any).status ?? 'unknown')
      if (serviceState === 'ready' || serviceState === 'disabled') continue

      const url = typeof (info as any).url === 'string' ? (info as any).url : ''
      const httpStatus = typeof (info as any).http_status === 'number' ? (info as any).http_status : null
      const reason = typeof (info as any).reason === 'string' ? (info as any).reason : ''
      const error = typeof (info as any).error === 'string' ? (info as any).error : ''
      const backend = typeof (info as any).backend === 'string' ? (info as any).backend : ''
      const provider = typeof (info as any).selected_provider === 'string' ? (info as any).selected_provider : ''

      const parts: string[] = [`${service} is ${serviceState}`]
      if (httpStatus !== null) parts.push(`HTTP ${httpStatus}`)
      if (provider) parts.push(`provider: ${provider}`)
      if (backend) parts.push(`backend: ${backend}`)
      if (url) parts.push(`url: ${url}`)

      collectedWarnings.push({
        key: service,
        message: parts.join(' · '),
        detail: (reason || error).trim() || undefined,
      })
    }

    if (collectedWarnings.length === 0 && status && Object.keys(status).length === 0) {
      collectedWarnings.push({
        key: 'status_payload',
        message: 'Service status is empty; MCP may be unreachable or returned a non-JSON status payload.',
      })
    }

    return collectedWarnings
  }, [status])

  const summary = useMemo(() => {
    const counts = { ready: 0, issues: 0, disabled: 0, total: 0 }
    if (!status) return counts

    for (const info of Object.values(status)) {
      counts.total += 1
      if (info.status === 'ready') counts.ready += 1
      else if (info.status === 'disabled') counts.disabled += 1
      else counts.issues += 1
    }
    return counts
  }, [status])

  const getStatusStyles = (serviceState: string) => {
    if (serviceState === 'ready') return 'bg-emerald-400/10 text-emerald-100 border-emerald-400/20'
    if (serviceState === 'disabled') return 'bg-slate-400/10 text-slate-200 border-slate-400/20'
    if (serviceState === 'not_ready') return 'bg-amber-400/10 text-amber-100 border-amber-400/20'
    return 'bg-rose-400/10 text-rose-100 border-rose-400/20'
  }

  const getServiceEndpointLabel = (url: string) => {
    if (!url) return 'No endpoint'
    if (url.startsWith('mock://')) return url.replace('mock://', 'mock · ')

    try {
      const parsed = new URL(url)
      return `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`
    } catch {
      return url
    }
  }

  if (loading) {
    return (
      <div className="rounded-3xl border border-white/10 bg-slate-900/70 p-6 shadow-xl shadow-slate-950/20 backdrop-blur">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-xl font-semibold text-white">Service Status</h3>
            <p className="mt-1 text-sm text-slate-400">Checking the MCP-connected backend stack…</p>
          </div>
          <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-cyan-400" />
        </div>
      </div>
    )
  }

  return (
    <div data-testid="service-status-panel" className="rounded-3xl border border-white/10 bg-slate-900/70 p-6 shadow-xl shadow-slate-950/20 backdrop-blur">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h3 className="text-xl font-semibold text-white">Service Status</h3>
          <p className="mt-1 text-sm text-slate-400">
            Live readiness for the ProteinCAD design stack and supporting services.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SummaryPill label="Ready" value={summary.ready} tone="emerald" />
          <SummaryPill label="Issues" value={summary.issues} tone="amber" />
          <SummaryPill label="Disabled" value={summary.disabled} tone="slate" />
          <button
            onClick={loadStatus}
            className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1.5 text-sm font-medium text-cyan-100 transition hover:bg-cyan-400/20"
          >
            Refresh
          </button>
        </div>
      </div>

      {loadError && (
        <div className="mt-4 rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
          <p className="font-medium">Warning: failed to fetch service status</p>
          <p className="mt-1 break-words text-amber-50/90">{loadError}</p>
        </div>
      )}

      {status && (
        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
          {Object.entries(status).map(([service, info]) => (
            <div key={service} data-testid={`service-card-${service}`} className="rounded-2xl border border-white/10 bg-slate-950/40 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white break-words">{service}</p>
                  <p className="mt-1 text-xs text-slate-500">Endpoint</p>
                  <p className="mt-1 truncate text-xs text-slate-300" title={info.url}>
                    {getServiceEndpointLabel(info.url)}
                  </p>
                </div>
                <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${getStatusStyles(info.status)}`}>
                  {info.status}
                </span>
              </div>

              {(info.reason || info.error) && (
                <p className="mt-3 text-xs leading-5 text-slate-300">{info.reason || info.error}</p>
              )}

              {typeof info.http_status === 'number' && (
                <p className="mt-3 text-xs text-slate-400">HTTP {info.http_status}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {!status && (
        <p className="mt-4 text-sm text-slate-400">Unable to load service status</p>
      )}

      {warnings.length > 0 && (
        <div className="mt-5 rounded-2xl border border-amber-400/15 bg-amber-400/5 p-4">
          <h4 className="text-sm font-semibold uppercase tracking-wide text-amber-100">Warnings</h4>
          <ul className="mt-3 space-y-2">
            {warnings.map((warning) => (
              <li key={warning.key} className="text-sm text-slate-200">
                <p className="break-words">{warning.message}</p>
                {warning.detail && (
                  <p className="mt-1 break-words text-xs text-slate-400">{warning.detail}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function SummaryPill({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'emerald' | 'amber' | 'slate'
}) {
  const toneClass =
    tone === 'emerald'
      ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100'
      : tone === 'amber'
        ? 'border-amber-400/20 bg-amber-400/10 text-amber-100'
        : 'border-slate-400/20 bg-slate-400/10 text-slate-200'

  return (
    <span className={`rounded-full border px-3 py-1.5 text-sm font-medium ${toneClass}`}>
      {label}: {value}
    </span>
  )
}
