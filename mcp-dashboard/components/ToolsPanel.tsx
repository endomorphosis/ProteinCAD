'use client'

import { useEffect, useMemo, useState } from 'react'

type JsonSchema = {
  type?: string
  description?: string
  default?: any
  items?: any
}

type Tool = {
  name: string
  description?: string
  inputSchema?: {
    type?: string
    properties?: Record<string, JsonSchema>
    required?: string[]
  }
}

type CallToolResult = {
  content?: Array<{ type: string; text?: string }>
  isError?: boolean
}

function safeJsonParse(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function schemaDefault(schema?: JsonSchema): any {
  if (schema && Object.prototype.hasOwnProperty.call(schema, 'default')) return schema.default
  if (schema?.type === 'integer' || schema?.type === 'number') return 0
  if (schema?.type === 'array') return []
  if (schema?.type === 'object') return {}
  return ''
}

function safeIdSuffix(input: string) {
  return input.toLowerCase().replace(/[^a-z0-9_-]+/g, '_')
}

const fieldClassName =
  'w-full rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-cyan-400/40 focus:ring-2 focus:ring-cyan-400/20'

export default function ToolsPanel() {
  const [tools, setTools] = useState<Tool[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedToolName, setSelectedToolName] = useState<string>('')
  const [args, setArgs] = useState<Record<string, any>>({})
  const [rawMode, setRawMode] = useState(false)
  const [rawArgsText, setRawArgsText] = useState<string>('{}')
  const [running, setRunning] = useState(false)
  const [resultText, setResultText] = useState<string>('')
  const [resultObj, setResultObj] = useState<any>(null)
  const [resultRaw, setResultRaw] = useState<string>('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const response = await fetch('/api/mcp/tools', { cache: 'no-store' })
        const data = await response.json()
        const list: Tool[] = data?.tools || []
        setTools(list)
        if (!selectedToolName && list.length > 0) {
          setSelectedToolName(list[0].name)
        }
      } catch (err: any) {
        setError(err?.message || 'Failed to load tools')
      } finally {
        setLoading(false)
      }
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectedTool = useMemo(
    () => tools.find((tool) => tool.name === selectedToolName),
    [tools, selectedToolName]
  )

  useEffect(() => {
    setResultText('')
    setResultObj(null)
    setResultRaw('')
    setError(null)

    const props = selectedTool?.inputSchema?.properties || {}
    const nextArgs: Record<string, any> = {}
    for (const [key, schema] of Object.entries(props)) {
      nextArgs[key] = schemaDefault(schema)
    }
    setArgs(nextArgs)
    setRawArgsText(JSON.stringify(nextArgs, null, 2))
  }, [selectedToolName, selectedTool?.inputSchema?.properties])

  const handleArgChange = (key: string, value: any) => {
    setArgs((prev) => {
      const next = { ...prev, [key]: value }
      setRawArgsText(JSON.stringify(next, null, 2))
      return next
    })
  }

  const callTool = async (override?: { name?: string; args?: Record<string, any> }) => {
    setRunning(true)
    setError(null)
    setResultText('')

    try {
      const nameToCall = override?.name ?? selectedToolName
      const argsToCall = override?.args ?? (rawMode ? safeJsonParse(rawArgsText) : args)
      const bodyArgs = argsToCall
      if (rawMode && bodyArgs === null) {
        throw new Error('Arguments JSON is invalid')
      }

      const response = await fetch('/api/mcp/tools/call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nameToCall, arguments: bodyArgs || {} }),
      })

      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload?.error || `HTTP ${response.status}`)
      }

      const result: CallToolResult = payload
      const text = result?.content?.find((entry) => entry.type === 'text')?.text
      const parsed = text ? safeJsonParse(text) : null

      if (result?.isError) {
        setError(text || 'Tool returned an error')
        setResultText(text || '')
        setResultRaw(text || '')
        setResultObj(parsed)
      } else {
        setResultRaw(text || '')
        setResultObj(parsed)
        setResultText(parsed ? JSON.stringify(parsed, null, 2) : text || JSON.stringify(payload, null, 2))
      }
    } catch (err: any) {
      setError(err?.message || 'Tool call failed')
    } finally {
      setRunning(false)
    }
  }

  const runQuick = async (toolName: string, arguments_: Record<string, any>) => {
    setSelectedToolName(toolName)
    setRawMode(false)
    setArgs(arguments_)
    setRawArgsText(JSON.stringify(arguments_, null, 2))
    await callTool({ name: toolName, args: arguments_ })
  }

  const statusPill = (status?: string) => {
    const value = (status || '').toLowerCase()
    if (value === 'ready' || value === 'completed') {
      return 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100'
    }
    if (value === 'running') {
      return 'border-cyan-400/20 bg-cyan-400/10 text-cyan-100'
    }
    if (value.includes('error') || value === 'failed' || value === 'not_ready') {
      return 'border-rose-400/20 bg-rose-400/10 text-rose-100'
    }
    return 'border-slate-400/20 bg-slate-400/10 text-slate-200'
  }

  const renderPrettyResult = () => {
    if (!resultObj) return null

    if (selectedToolName === 'check_services' && typeof resultObj === 'object') {
      const entries = Object.entries(resultObj as Record<string, any>)
      return (
        <div className="space-y-3">
          <div className="text-sm font-semibold text-slate-100">Service Status</div>
          <div className="overflow-hidden rounded-2xl border border-white/10 bg-slate-950/50">
            <table className="w-full text-sm">
              <thead className="bg-white/5 text-left text-slate-300">
                <tr>
                  <th className="px-3 py-2">Service</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">URL</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10">
                {entries.map(([name, info]) => (
                  <tr key={name} className="bg-transparent">
                    <td className="px-3 py-2 font-medium text-slate-100">{name}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded-full border px-2 py-1 text-xs font-medium ${statusPill(info?.status)}`}>
                        {info?.status || 'unknown'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-400 break-all">{info?.url}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )
    }

    if ((selectedToolName === 'list_jobs' || selectedToolName === 'get_job_status') && (Array.isArray(resultObj) || typeof resultObj === 'object')) {
      const jobs = Array.isArray(resultObj) ? resultObj : [resultObj]
      return (
        <div className="space-y-3">
          <div className="text-sm font-semibold text-slate-100">Jobs ({jobs.length})</div>
          <div className="space-y-2">
            {jobs.map((job: any) => (
              <div key={job?.job_id || Math.random()} className="rounded-2xl border border-white/10 bg-slate-950/50 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-slate-100">{job?.job_name || job?.job_id}</div>
                    <div className="break-all text-xs text-slate-500">{job?.job_id}</div>
                  </div>
                  <span className={`rounded-full border px-2 py-1 text-xs font-medium ${statusPill(job?.status)}`}>
                    {job?.status || 'unknown'}
                  </span>
                </div>
                {job?.progress && (
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-300">
                    {Object.entries(job.progress).map(([key, value]) => (
                      <div key={key} className="rounded-xl bg-white/5 px-2.5 py-2">
                        <div className="capitalize text-slate-400">{String(key).replace('_', ' ')}</div>
                        <div className="mt-1 font-medium text-slate-100">{String(value)}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )
    }

    if (selectedToolName === 'design_protein_binder' && typeof resultObj === 'object') {
      return (
        <div className="rounded-2xl border border-white/10 bg-slate-950/50 p-3">
          <div className="text-sm font-semibold text-slate-100">Job Created</div>
          <div className="mt-2 text-sm text-slate-100">{resultObj?.job_name || resultObj?.job_id}</div>
          <div className="break-all text-xs text-slate-500">{resultObj?.job_id}</div>
          {resultObj?.status && (
            <div className="mt-3">
              <span className={`rounded-full border px-2 py-1 text-xs font-medium ${statusPill(resultObj.status)}`}>
                {resultObj.status}
              </span>
            </div>
          )}
        </div>
      )
    }

    return null
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-cyan-400" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Quick actions</div>
        <div className="mt-3 flex flex-wrap gap-2">
          <QuickButton onClick={() => runQuick('check_services', {})} disabled={running}>
            Check Services
          </QuickButton>
          <QuickButton onClick={() => runQuick('list_jobs', {})} disabled={running}>
            List Jobs
          </QuickButton>
          <QuickButton
            onClick={async () => {
              setLoading(true)
              setError(null)
              try {
                const response = await fetch('/api/mcp/tools', { cache: 'no-store' })
                const data = await response.json()
                setTools(data?.tools || [])
              } catch (err: any) {
                setError(err?.message || 'Failed to refresh tools')
              } finally {
                setLoading(false)
              }
            }}
            disabled={running}
          >
            Refresh Tools
          </QuickButton>
        </div>
      </div>

      {error && (
        <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 p-3 text-sm text-rose-100">
          {error}
        </div>
      )}

      <div>
        <label htmlFor="mcp-tool-select" className="mb-1.5 block text-sm font-medium text-slate-200">
          Tool
        </label>
        <select
          id="mcp-tool-select"
          value={selectedToolName}
          onChange={(event) => setSelectedToolName(event.target.value)}
          className={fieldClassName}
        >
          {tools.map((tool) => (
            <option key={tool.name} value={tool.name}>
              {tool.name}
            </option>
          ))}
        </select>
        {selectedTool?.description && (
          <p className="mt-2 text-xs leading-5 text-slate-400">{selectedTool.description}</p>
        )}
      </div>

      <div className="flex items-center justify-between gap-4">
        <label htmlFor={rawMode ? 'mcp-raw-args' : undefined} className="text-sm font-medium text-slate-200">
          Arguments
        </label>
        <label htmlFor="mcp-raw-mode" className="flex items-center gap-2 text-xs text-slate-400">
          <input
            id="mcp-raw-mode"
            type="checkbox"
            checked={rawMode}
            onChange={(event) => setRawMode(event.target.checked)}
            className="h-4 w-4 rounded border-white/20 bg-slate-950 text-cyan-400 focus:ring-cyan-400"
          />
          Raw JSON
        </label>
      </div>

      {!rawMode && (
        <div className="space-y-3">
          {Object.entries(selectedTool?.inputSchema?.properties || {}).length === 0 && (
            <div className="rounded-2xl border border-dashed border-white/10 bg-slate-950/40 px-3 py-4 text-xs text-slate-400">
              No arguments
            </div>
          )}

          {Object.entries(selectedTool?.inputSchema?.properties || {}).map(([key, schema]) => {
            const schemaType = schema?.type || 'string'
            const required = (selectedTool?.inputSchema?.required || []).includes(key)
            const fieldId = `mcp-arg-${safeIdSuffix(key)}`

            if (schemaType === 'integer' || schemaType === 'number') {
              return (
                <FieldShell key={key} label={`${key}${required ? ' *' : ''}`} description={schema?.description}>
                  <input
                    id={fieldId}
                    type="number"
                    value={args[key] ?? ''}
                    onChange={(event) => handleArgChange(key, event.target.value === '' ? '' : Number(event.target.value))}
                    className={fieldClassName}
                  />
                </FieldShell>
              )
            }

            if (schemaType === 'array') {
              return (
                <FieldShell key={key} label={`${key}${required ? ' *' : ''} (JSON array)`} description={schema?.description}>
                  <textarea
                    id={fieldId}
                    rows={3}
                    value={JSON.stringify(args[key] ?? [], null, 2)}
                    onChange={(event) => {
                      const parsed = safeJsonParse(event.target.value)
                      handleArgChange(key, parsed ?? event.target.value)
                    }}
                    className={`${fieldClassName} font-mono text-xs`}
                  />
                </FieldShell>
              )
            }

            return (
              <FieldShell key={key} label={`${key}${required ? ' *' : ''}`} description={schema?.description}>
                <textarea
                  id={fieldId}
                  rows={schema?.description?.toLowerCase().includes('pdb') ? 6 : 2}
                  value={args[key] ?? ''}
                  onChange={(event) => handleArgChange(key, event.target.value)}
                  className={`${fieldClassName} font-mono text-xs`}
                />
              </FieldShell>
            )
          })}
        </div>
      )}

      {rawMode && (
        <textarea
          id="mcp-raw-args"
          rows={10}
          value={rawArgsText}
          onChange={(event) => setRawArgsText(event.target.value)}
          className={`${fieldClassName} font-mono text-xs`}
        />
      )}

      <button
        onClick={() => void callTool()}
        disabled={running || !selectedToolName}
        className="w-full rounded-2xl bg-gradient-to-r from-violet-500 to-cyan-400 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {running ? 'Running…' : 'Run Tool'}
      </button>

      {renderPrettyResult()}

      {(resultText || resultRaw) && (
        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-200">Raw Result</label>
          <pre className="max-h-64 overflow-auto rounded-2xl border border-white/10 bg-slate-950 p-3 font-mono text-xs text-emerald-300">
            {resultText || resultRaw}
          </pre>
        </div>
      )}
    </div>
  )
}

function QuickButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode
  onClick: () => void | Promise<void>
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={() => void onClick()}
      disabled={disabled}
      className="rounded-full border border-white/10 bg-slate-950/60 px-3 py-2 text-xs font-medium text-slate-200 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  )
}

function FieldShell({
  label,
  description,
  children,
}: {
  label: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
      <label className="mb-1.5 block text-sm font-medium text-slate-200">{label}</label>
      {children}
      {description && <p className="mt-2 text-xs leading-5 text-slate-400">{description}</p>}
    </div>
  )
}
