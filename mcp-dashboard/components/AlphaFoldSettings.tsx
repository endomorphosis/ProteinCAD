'use client'

import { useEffect, useState } from 'react'
import { extractFirstTextContent } from '@generative-protein/mcp-js-sdk'

interface AlphaFoldSettings {
  speed_preset?: string
  disable_templates?: boolean
  num_recycles?: number
  num_ensemble?: number
  mmseqs2_max_seqs?: number
  msa_mode?: string
}

interface Props {
  onSettingsChanged?: () => void
}

const fieldClassName =
  'w-full rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-cyan-400/40 focus:ring-2 focus:ring-cyan-400/20'

export default function AlphaFoldSettings({ onSettingsChanged }: Props) {
  const [settings, setSettings] = useState<AlphaFoldSettings>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  const callTool = async (name: string, args: Record<string, any>) => {
    const response = await fetch('/api/mcp/tools/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, arguments: args || {} }),
    })
    if (!response.ok) {
      throw new Error(`Tool call failed (${response.status})`)
    }
    return response.json()
  }

  const fetchSettings = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await callTool('get_alphafold_settings', {})
      const text = extractFirstTextContent(result)
      const parsed = JSON.parse(text)
      setSettings(parsed)
    } catch (err: any) {
      setError(`Failed to load settings: ${err.message}`)
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchSettings()
  }, [])

  const handleSettingChange = (key: keyof AlphaFoldSettings, value: any) => {
    setSettings((prev) => ({ ...prev, [key]: value }))
  }

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    setSuccess(null)
    try {
      const result = await callTool('update_alphafold_settings', settings)
      const text = extractFirstTextContent(result)
      const parsed = JSON.parse(text)

      if (parsed.success) {
        setSettings(parsed.settings)
        setSuccess('AlphaFold settings updated successfully')
        onSettingsChanged?.()
        setTimeout(() => setSuccess(null), 3000)
      } else {
        setError(parsed.message || 'Failed to update settings')
      }
    } catch (err: any) {
      setError(`Failed to save settings: ${err.message}`)
      console.error(err)
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async () => {
    if (!confirm('Reset AlphaFold settings to defaults?')) return

    setSaving(true)
    setError(null)
    setSuccess(null)
    try {
      const result = await callTool('reset_alphafold_settings', {})
      const text = extractFirstTextContent(result)
      const parsed = JSON.parse(text)

      if (parsed.success) {
        setSettings(parsed.settings)
        setSuccess('AlphaFold settings reset to defaults')
        onSettingsChanged?.()
        setTimeout(() => setSuccess(null), 3000)
      } else {
        setError(parsed.message || 'Failed to reset settings')
      }
    } catch (err: any) {
      setError(`Failed to reset settings: ${err.message}`)
      console.error(err)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="rounded-3xl border border-white/10 bg-slate-900/70 p-6 shadow-xl shadow-slate-950/20 backdrop-blur">
        <div className="animate-pulse">
          <div className="h-6 w-1/3 rounded bg-white/10" />
          <div className="mt-3 h-4 w-2/3 rounded bg-white/5" />
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-3xl border border-white/10 bg-slate-900/70 shadow-xl shadow-slate-950/20 backdrop-blur">
      <button
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center justify-between gap-4 px-6 py-5 text-left transition hover:bg-white/5"
      >
        <div className="flex items-start gap-3">
          <div className="mt-1 rounded-full border border-cyan-400/20 bg-cyan-400/10 p-2 text-cyan-200">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <div>
            <h3 className="text-xl font-semibold text-white">AlphaFold Optimization Settings</h3>
            <p className="mt-1 text-sm text-slate-400">
              Configure speed vs quality tradeoffs and keep the structure generation pipeline tuned.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1 text-xs font-medium text-emerald-100">
            Up to 29% faster
          </span>
          <svg
            className={`h-5 w-5 text-slate-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
          </svg>
        </div>
      </button>

      {expanded && (
        <div className="space-y-6 border-t border-white/10 px-6 py-5">
          <div className="grid gap-4 lg:grid-cols-[1.25fr_0.75fr]">
            <div className="rounded-2xl border border-white/10 bg-slate-950/40 p-4">
              <label htmlFor="speed_preset" className="mb-2 block text-sm font-medium text-slate-200">
                Speed Preset
              </label>
              <select
                id="speed_preset"
                value={settings.speed_preset || 'balanced'}
                onChange={(event) => handleSettingChange('speed_preset', event.target.value)}
                className={fieldClassName}
              >
                <option value="fast">⚡ Fast (29% faster - templates OFF, recycles=3)</option>
                <option value="balanced">⚖️ Balanced (20% faster - templates ON, recycles=3, default)</option>
                <option value="quality">🎯 Quality (slowest - templates ON, full recycles)</option>
              </select>
              <p className="mt-2 text-xs leading-5 text-slate-400">
                {settings.speed_preset === 'fast' && 'Fastest option: removes templates and reduces recycling iterations.'}
                {settings.speed_preset === 'balanced' && 'Recommended mode for everyday structure generation and review.'}
                {settings.speed_preset === 'quality' && 'Use when final quality matters more than runtime.'}
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
              <StatTile label="Templates" value={settings.disable_templates ? 'Disabled' : 'Enabled'} />
              <StatTile label="Recycles" value={String(settings.num_recycles ?? 'default')} />
              <StatTile label="MSA mode" value={String(settings.msa_mode || 'mmseqs2')} />
            </div>
          </div>

          <details className="group rounded-2xl border border-white/10 bg-slate-950/30 p-4">
            <summary className="flex cursor-pointer items-center text-sm font-semibold text-slate-200">
              <svg className="mr-2 h-4 w-4 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              Advanced Settings
            </summary>

            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <label className="flex items-center gap-3 text-sm font-medium text-slate-200">
                  <input
                    type="checkbox"
                    checked={settings.disable_templates || false}
                    onChange={(event) => handleSettingChange('disable_templates', event.target.checked)}
                    className="h-4 w-4 rounded border-white/20 bg-slate-950 text-cyan-400 focus:ring-cyan-400"
                  />
                  Disable Templates
                </label>
                <p className="mt-2 text-xs leading-5 text-slate-400">
                  Skip the template search for extra speed when template guidance is not required.
                </p>
              </div>

              <SettingField
                id="num_recycles"
                label={`Recycling Iterations: ${settings.num_recycles || 'default'}`}
                type="number"
                value={settings.num_recycles ?? ''}
                onChange={(value) => handleSettingChange('num_recycles', value === '' ? null : parseInt(value, 10))}
                placeholder="3 (speed) to 20 (quality)"
                help="3 for speed, -1 for model default (~20), higher = slower but sometimes more stable."
              />

              <SettingField
                id="num_ensemble"
                label={`Ensemble Evaluations: ${settings.num_ensemble || 'default'}`}
                type="number"
                value={settings.num_ensemble ?? ''}
                onChange={(value) => handleSettingChange('num_ensemble', value === '' ? null : parseInt(value, 10))}
                placeholder="1 (speed) to 8 (quality)"
                help="1 for speed, 8 for CASP14-style quality runs."
              />

              <SettingField
                id="mmseqs2_max_seqs"
                label={`MMseqs2 Max Sequences: ${settings.mmseqs2_max_seqs || 'default'}`}
                type="number"
                value={settings.mmseqs2_max_seqs ?? ''}
                onChange={(value) => handleSettingChange('mmseqs2_max_seqs', value === '' ? null : parseInt(value, 10))}
                placeholder="512 (speed) to 10000 (quality)"
                help="Lower values favor speed; higher values improve coverage and sensitivity."
              />

              <div className="rounded-2xl border border-white/10 bg-white/5 p-4 lg:col-span-2">
                <label htmlFor="msa_mode" className="mb-2 block text-sm font-medium text-slate-200">
                  MSA Generation Mode
                </label>
                <select
                  id="msa_mode"
                  value={settings.msa_mode || 'mmseqs2'}
                  onChange={(event) => handleSettingChange('msa_mode', event.target.value)}
                  className={fieldClassName}
                >
                  <option value="mmseqs2">MMseqs2 (faster, requires database)</option>
                  <option value="jackhmmer">JackHMMER (slower, more compatible)</option>
                </select>
                <p className="mt-2 text-xs leading-5 text-slate-400">
                  MMseqs2 is faster in prepared environments; JackHMMER is more portable when databases differ.
                </p>
              </div>
            </div>
          </details>

          {error && (
            <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 p-3 text-sm text-rose-100">{error}</div>
          )}

          {success && (
            <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/10 p-3 text-sm text-emerald-100">
              {success}
            </div>
          )}

          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex gap-3 lg:w-[360px]">
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex-1 rounded-2xl bg-gradient-to-r from-cyan-400 to-violet-500 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save Settings'}
              </button>
              <button
                onClick={handleReset}
                disabled={saving}
                className="flex-1 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-semibold text-slate-100 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Reset to Defaults
              </button>
            </div>

            <div className="min-w-0 flex-1 rounded-2xl border border-white/10 bg-slate-950/60 p-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Current Settings (JSON)</p>
              <pre className="max-h-40 overflow-auto text-xs text-cyan-100">{JSON.stringify(settings, null, 2)}</pre>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-2 text-sm font-medium text-slate-100">{value}</div>
    </div>
  )
}

function SettingField({
  id,
  label,
  value,
  onChange,
  placeholder,
  help,
  type,
}: {
  id: string
  label: string
  value: string | number
  onChange: (value: string) => void
  placeholder: string
  help: string
  type: 'number' | 'text'
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
      <label htmlFor={id} className="mb-2 block text-sm font-medium text-slate-200">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={fieldClassName}
        placeholder={placeholder}
      />
      <p className="mt-2 text-xs leading-5 text-slate-400">{help}</p>
    </div>
  )
}
