'use client'

import { useEffect, useMemo, useState } from 'react'

type ProviderName = 'nim' | 'external' | 'embedded'

type ServiceName = 'alphafold' | 'rfdiffusion' | 'proteinmpnn' | 'alphafold_multimer'
type RetrievalProviderName = 'ncbi_blast_remote' | 'local_blast'

type RoutingConfig = {
  mode: 'single' | 'fallback'
  primary: ProviderName
  order: ProviderName[]
}

type ProviderConfig = {
  enabled: boolean
  service_urls: Record<ServiceName, string | null>
}

type EmbeddedConfig = {
  enabled: boolean
  model_dir: string
  auto_install: boolean
  auto_download: boolean
  downloads: {
    proteinmpnn_source_tarball_url: string | null
    proteinmpnn_weights_url: string | null
    rfdiffusion_weights_url: string | null
    alphafold_db_url: string | null
    alphafold_db_url_full: string | null
    alphafold_db_subdir: string

    // AlphaFold2 / MGnify (optional; used by installers / embedded provisioning)
    alphafold_mgnify_url: string | null
    alphafold_mgnify_fallback: 'none' | 'huggingface'
    alphafold_mgnify_hf_dataset: string
    alphafold_mgnify_hf_token: string | null
  }
  runners: {
    alphafold: { argv: string[]; timeout_seconds: number }
    rfdiffusion: { argv: string[]; timeout_seconds: number }
    alphafold_multimer: { argv: string[]; timeout_seconds: number }
  }
}

type MCPServerConfig = {
  version: number
  routing: RoutingConfig
  nim: ProviderConfig
  external: ProviderConfig
  embedded: EmbeddedConfig
  retrieval: {
    provider: RetrievalProviderName
    feature_flags: {
      enabled: boolean
      expose_rest: boolean
      expose_mcp: boolean
      allow_job_grounding: boolean
      evidence_enrichment: boolean
      export_parquet: boolean
      create_schema_on_startup: boolean
    }
    blast: {
      remote_base_url: string
      default_program: string
      default_database: string
      default_hitlist_size: number
      max_hitlist_size: number
      poll_interval_seconds: number
      max_poll_attempts: number
      request_timeout_seconds: number
    }
    storage: {
      data_dir: string
      duckdb_path: string
      parquet_export_dir: string
      raw_payload_dir: string
      manifest_dir: string
    }
  }
  allow_runtime_updates: boolean
}

const SERVICES: ServiceName[] = ['alphafold', 'rfdiffusion', 'proteinmpnn', 'alphafold_multimer']
const PROVIDERS: ProviderName[] = ['nim', 'external', 'embedded']

function normalizeConfig(raw: any): MCPServerConfig {
  const cfg = raw as MCPServerConfig
  // Ensure missing keys exist (backward compatible if server adds/changes fields).
  const ensureUrls = (u: any): Record<ServiceName, string | null> => {
    const out: any = {}
    for (const s of SERVICES) out[s] = u?.[s] ?? null
    return out
  }

  const ensureRunner = (r: any, defaults: { argv: string[]; timeout_seconds: number }) => {
    const argv = Array.isArray(r?.argv) ? r.argv.map((x: any) => String(x)) : defaults.argv
    const timeout = Number.isFinite(r?.timeout_seconds) ? Number(r.timeout_seconds) : defaults.timeout_seconds
    return { argv, timeout_seconds: Math.max(1, timeout | 0) }
  }

  return {
    version: cfg?.version ?? 2,
    allow_runtime_updates: cfg?.allow_runtime_updates ?? true,
    routing: {
      mode: cfg?.routing?.mode ?? 'fallback',
      primary: cfg?.routing?.primary ?? 'nim',
      order: (cfg?.routing?.order ?? ['nim', 'external', 'embedded']).filter((p: any) => PROVIDERS.includes(p)),
    },
    nim: {
      enabled: cfg?.nim?.enabled ?? true,
      service_urls: ensureUrls(cfg?.nim?.service_urls),
    },
    external: {
      enabled: cfg?.external?.enabled ?? true,
      service_urls: ensureUrls(cfg?.external?.service_urls),
    },
    embedded: {
      enabled: cfg?.embedded?.enabled ?? true,
      model_dir: cfg?.embedded?.model_dir ?? '/models',
      auto_install: cfg?.embedded?.auto_install ?? false,
      auto_download: cfg?.embedded?.auto_download ?? false,
      downloads: {
        proteinmpnn_source_tarball_url: cfg?.embedded?.downloads?.proteinmpnn_source_tarball_url ?? null,
        proteinmpnn_weights_url: cfg?.embedded?.downloads?.proteinmpnn_weights_url ?? null,
        rfdiffusion_weights_url: cfg?.embedded?.downloads?.rfdiffusion_weights_url ?? null,
        alphafold_db_url: cfg?.embedded?.downloads?.alphafold_db_url ?? null,
        alphafold_db_url_full: cfg?.embedded?.downloads?.alphafold_db_url_full ?? null,
        alphafold_db_subdir: cfg?.embedded?.downloads?.alphafold_db_subdir ?? 'alphafold_db',

        alphafold_mgnify_url: cfg?.embedded?.downloads?.alphafold_mgnify_url ?? null,
        alphafold_mgnify_fallback:
          cfg?.embedded?.downloads?.alphafold_mgnify_fallback === 'huggingface' ? 'huggingface' : 'none',
        alphafold_mgnify_hf_dataset: cfg?.embedded?.downloads?.alphafold_mgnify_hf_dataset ?? 'tattabio/OMG_prot50',
        alphafold_mgnify_hf_token: cfg?.embedded?.downloads?.alphafold_mgnify_hf_token ?? null,
      },
      runners: {
        alphafold: ensureRunner(cfg?.embedded?.runners?.alphafold, { argv: [], timeout_seconds: 3600 }),
        rfdiffusion: ensureRunner(cfg?.embedded?.runners?.rfdiffusion, { argv: [], timeout_seconds: 3600 }),
        alphafold_multimer: ensureRunner(cfg?.embedded?.runners?.alphafold_multimer, { argv: [], timeout_seconds: 3600 }),
      },
    },
    retrieval: {
      provider: cfg?.retrieval?.provider === 'local_blast' ? 'local_blast' : 'ncbi_blast_remote',
      feature_flags: {
        enabled: cfg?.retrieval?.feature_flags?.enabled ?? false,
        expose_rest: cfg?.retrieval?.feature_flags?.expose_rest ?? false,
        expose_mcp: cfg?.retrieval?.feature_flags?.expose_mcp ?? false,
        allow_job_grounding: cfg?.retrieval?.feature_flags?.allow_job_grounding ?? false,
        evidence_enrichment: cfg?.retrieval?.feature_flags?.evidence_enrichment ?? false,
        export_parquet: cfg?.retrieval?.feature_flags?.export_parquet ?? false,
        create_schema_on_startup: cfg?.retrieval?.feature_flags?.create_schema_on_startup ?? true,
      },
      blast: {
        remote_base_url: cfg?.retrieval?.blast?.remote_base_url ?? 'https://blast.ncbi.nlm.nih.gov/Blast.cgi',
        default_program: cfg?.retrieval?.blast?.default_program ?? 'blastp',
        default_database: cfg?.retrieval?.blast?.default_database ?? 'swissprot',
        default_hitlist_size: Number(cfg?.retrieval?.blast?.default_hitlist_size ?? 25) || 25,
        max_hitlist_size: Number(cfg?.retrieval?.blast?.max_hitlist_size ?? 100) || 100,
        poll_interval_seconds: Number(cfg?.retrieval?.blast?.poll_interval_seconds ?? 5) || 5,
        max_poll_attempts: Number(cfg?.retrieval?.blast?.max_poll_attempts ?? 60) || 60,
        request_timeout_seconds: Number(cfg?.retrieval?.blast?.request_timeout_seconds ?? 30) || 30,
      },
      storage: {
        data_dir: cfg?.retrieval?.storage?.data_dir ?? '',
        duckdb_path: cfg?.retrieval?.storage?.duckdb_path ?? '',
        parquet_export_dir: cfg?.retrieval?.storage?.parquet_export_dir ?? '',
        raw_payload_dir: cfg?.retrieval?.storage?.raw_payload_dir ?? '',
        manifest_dir: cfg?.retrieval?.storage?.manifest_dir ?? '',
      },
    },
  }
}

export default function BackendSettings() {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [config, setConfig] = useState<MCPServerConfig | null>(null)
  const [bootstrapping, setBootstrapping] = useState(false)
  const [bootstrapResult, setBootstrapResult] = useState<any | null>(null)

  const [bootstrapModels, setBootstrapModels] = useState<Record<ServiceName, boolean>>({
    alphafold: false,
    rfdiffusion: false,
    proteinmpnn: true,
    alphafold_multimer: false,
  })

  const canEdit = config?.allow_runtime_updates !== false

  const title = useMemo(() => {
    if (!config) return 'Backend Settings'
    if (config.routing.mode === 'single') return `Backend: ${config.routing.primary}`
    return `Backend: fallback (${config.routing.order.join(' → ')})`
  }, [config])

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/mcp/config', { cache: 'no-store' })
      if (!res.ok) throw new Error(`Failed to load config (${res.status})`)
      const json = await res.json()
      setConfig(normalizeConfig(json))
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load config')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open && !config && !loading) {
      load()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const save = async () => {
    if (!config) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/mcp/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      })
      const text = await res.text()
      if (!res.ok) {
        throw new Error(text || `Save failed (${res.status})`)
      }
      setConfig(normalizeConfig(JSON.parse(text)))
      setOpen(false)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to save config')
    } finally {
      setSaving(false)
    }
  }

  const runEmbeddedBootstrap = async () => {
    if (!config) return
    setBootstrapping(true)
    setError(null)
    setBootstrapResult(null)
    try {
      const models = Object.entries(bootstrapModels)
        .filter(([, v]) => v)
        .map(([k]) => k)
        // multimer isn’t supported by the embedded bootstrap today
        .filter((k) => k !== 'alphafold_multimer')

      const res = await fetch('/api/mcp/embedded/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ models }),
      })
      const text = await res.text()
      if (!res.ok) throw new Error(text || `Bootstrap failed (${res.status})`)
      const json = JSON.parse(text)
      setBootstrapResult(json)
    } catch (e: any) {
      setError(e?.message ?? 'Embedded bootstrap failed')
    } finally {
      setBootstrapping(false)
    }
  }

  const reset = async () => {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/mcp/config/reset', { method: 'POST' })
      const text = await res.text()
      if (!res.ok) throw new Error(text || `Reset failed (${res.status})`)
      setConfig(normalizeConfig(JSON.parse(text)))
    } catch (e: any) {
      setError(e?.message ?? 'Failed to reset config')
    } finally {
      setSaving(false)
    }
  }

  const move = (dir: -1 | 1, idx: number) => {
    if (!config) return
    const order = [...config.routing.order]
    const j = idx + dir
    if (j < 0 || j >= order.length) return
    ;[order[idx], order[j]] = [order[j], order[idx]]
    setConfig({ ...config, routing: { ...config.routing, order } })
  }

  const setUrl = (provider: ProviderName, service: ServiceName, value: string) => {
    if (!config) return
    const trimmed = value.trim()
    const next = trimmed.length ? trimmed : null
    if (provider === 'nim') {
      setConfig({ ...config, nim: { ...config.nim, service_urls: { ...config.nim.service_urls, [service]: next } } })
    } else if (provider === 'external') {
      setConfig({
        ...config,
        external: { ...config.external, service_urls: { ...config.external.service_urls, [service]: next } },
      })
    }
  }

  const setRunnerArgv = (runnerKey: 'alphafold' | 'rfdiffusion' | 'alphafold_multimer', text: string) => {
    if (!config) return
    const argv = text
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    setConfig({
      ...config,
      embedded: {
        ...config.embedded,
        runners: {
          ...config.embedded.runners,
          [runnerKey]: { ...config.embedded.runners[runnerKey], argv },
        },
      },
    })
  }

  const setRunnerTimeout = (runnerKey: 'alphafold' | 'rfdiffusion' | 'alphafold_multimer', value: string) => {
    if (!config) return
    const t = Math.max(1, parseInt(value || '0', 10) || 0)
    setConfig({
      ...config,
      embedded: {
        ...config.embedded,
        runners: {
          ...config.embedded.runners,
          [runnerKey]: { ...config.embedded.runners[runnerKey], timeout_seconds: t },
        },
      },
    })
  }

  const setRetrievalFlag = (
    key:
      | 'enabled'
      | 'expose_rest'
      | 'expose_mcp'
      | 'allow_job_grounding'
      | 'evidence_enrichment'
      | 'export_parquet'
      | 'create_schema_on_startup',
    value: boolean
  ) => {
    if (!config) return
    setConfig({
      ...config,
      retrieval: {
        ...config.retrieval,
        feature_flags: {
          ...config.retrieval.feature_flags,
          [key]: value,
        },
      },
    })
  }

  const setRetrievalBlast = (
    key:
      | 'remote_base_url'
      | 'default_program'
      | 'default_database'
      | 'default_hitlist_size'
      | 'max_hitlist_size'
      | 'poll_interval_seconds'
      | 'max_poll_attempts'
      | 'request_timeout_seconds',
    value: string | number
  ) => {
    if (!config) return
    const numericFieldMins: Partial<
      Record<
        | 'default_hitlist_size'
        | 'max_hitlist_size'
        | 'poll_interval_seconds'
        | 'max_poll_attempts'
        | 'request_timeout_seconds',
        number
      >
    > = {
      default_hitlist_size: 1,
      max_hitlist_size: 1,
      poll_interval_seconds: 1,
      max_poll_attempts: 1,
      request_timeout_seconds: 1,
    }

    let nextValue: string | number = typeof value === 'string' ? value : Number(value)
    if (key in numericFieldMins) {
      const parsed = Number(value)
      const min = numericFieldMins[key as keyof typeof numericFieldMins] ?? 1
      nextValue = Number.isFinite(parsed) ? Math.max(min, parsed) : min
    }

    setConfig({
      ...config,
      retrieval: {
        ...config.retrieval,
        blast: {
          ...config.retrieval.blast,
          [key]: nextValue,
        },
      },
    })
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        data-testid="open-backend-settings"
        className="inline-flex items-center gap-2 rounded-xl border border-cyan-300/25 bg-cyan-400/10 px-3.5 py-2 text-sm font-semibold text-cyan-50 shadow-sm shadow-cyan-900/30 transition hover:bg-cyan-400/20 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
        title={title}
      >
        <span aria-hidden="true">⚙️</span>
        Settings
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-3xl rounded-lg bg-white shadow-xl dark:bg-gray-900">
            <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4 dark:border-gray-800">
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Backend Settings</h3>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Choose NIM, external services, or embedded execution. Fallback mode tries providers in order.
                </p>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="rounded-md px-2 py-1 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                Close
              </button>
            </div>

            <div className="px-5 py-4">
              {loading && <div className="text-sm text-gray-500">Loading…</div>}

              {error && (
                <div className="mb-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
                  {error}
                </div>
              )}

              {config && (
                <div className="space-y-6">
                  {!canEdit && (
                    <div className="rounded-md border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800 dark:border-yellow-900/50 dark:bg-yellow-950/30 dark:text-yellow-200">
                      Runtime edits are disabled on the server (MCP_CONFIG_READONLY=1).
                    </div>
                  )}

                  <section>
                    <h4 className="mb-2 text-sm font-semibold text-gray-900 dark:text-white">Routing</h4>
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                      <label className="text-sm">
                        <div className="mb-1 text-gray-700 dark:text-gray-300">Mode</div>
                        <select
                          disabled={!canEdit}
                          value={config.routing.mode}
                          onChange={(e) =>
                            setConfig({ ...config, routing: { ...config.routing, mode: e.target.value as any } })
                          }
                          className="w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
                        >
                          <option value="fallback">fallback (recommended)</option>
                          <option value="single">single provider</option>
                        </select>
                      </label>

                      <label className="text-sm">
                        <div className="mb-1 text-gray-700 dark:text-gray-300">Primary (single mode)</div>
                        <select
                          disabled={!canEdit || config.routing.mode !== 'single'}
                          value={config.routing.primary}
                          onChange={(e) =>
                            setConfig({
                              ...config,
                              routing: { ...config.routing, primary: e.target.value as ProviderName },
                            })
                          }
                          className="w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
                        >
                          {PROVIDERS.map((p) => (
                            <option key={p} value={p}>
                              {p}
                            </option>
                          ))}
                        </select>
                      </label>

                      <div className="text-sm">
                        <div className="mb-1 text-gray-700 dark:text-gray-300">Fallback order</div>
                        <div className="space-y-2 rounded-md border border-gray-200 p-2 dark:border-gray-800">
                          {config.routing.order.map((p, idx) => (
                            <div key={`${p}-${idx}`} className="flex items-center justify-between">
                              <span className="font-medium text-gray-800 dark:text-gray-200">{p}</span>
                              <div className="flex items-center gap-2">
                                <button
                                  disabled={!canEdit}
                                  onClick={() => move(-1, idx)}
                                  className="rounded bg-gray-100 px-2 py-1 text-xs text-gray-700 hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-200"
                                >
                                  ↑
                                </button>
                                <button
                                  disabled={!canEdit}
                                  onClick={() => move(1, idx)}
                                  className="rounded bg-gray-100 px-2 py-1 text-xs text-gray-700 hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-200"
                                >
                                  ↓
                                </button>
                              </div>
                            </div>
                          ))}
                          <p className="text-xs text-gray-500 dark:text-gray-400">
                            Tip: for ARM64, you’ll often want “embedded” last.
                          </p>
                        </div>
                      </div>
                    </div>
                  </section>

                  <section>
                    <h4 className="mb-2 text-sm font-semibold text-gray-900 dark:text-white">Providers</h4>
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                      <div className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
                        <div className="flex items-center justify-between">
                          <h5 className="font-semibold text-gray-900 dark:text-white">NIM</h5>
                          <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                            <input
                              type="checkbox"
                              checked={config.nim.enabled}
                              disabled={!canEdit}
                              onChange={(e) => setConfig({ ...config, nim: { ...config.nim, enabled: e.target.checked } })}
                            />
                            enabled
                          </label>
                        </div>
                        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                          Uses NIM-style REST endpoints. Usually handled by docker compose stacks.
                        </p>
                      </div>

                      <div className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
                        <div className="flex items-center justify-between">
                          <h5 className="font-semibold text-gray-900 dark:text-white">External</h5>
                          <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                            <input
                              type="checkbox"
                              checked={config.external.enabled}
                              disabled={!canEdit}
                              onChange={(e) =>
                                setConfig({ ...config, external: { ...config.external, enabled: e.target.checked } })
                              }
                            />
                            enabled
                          </label>
                        </div>
                        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                          Point at any compatible model services (Docker, k8s, remote).
                        </p>
                      </div>

                      <div className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
                        <div className="flex items-center justify-between">
                          <h5 className="font-semibold text-gray-900 dark:text-white">Embedded</h5>
                          <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                            <input
                              type="checkbox"
                              checked={config.embedded.enabled}
                              disabled={!canEdit}
                              onChange={(e) =>
                                setConfig({ ...config, embedded: { ...config.embedded, enabled: e.target.checked } })
                              }
                            />
                            enabled
                          </label>
                        </div>
                        <div className="mt-3 space-y-2">
                          <label className="block text-xs text-gray-600 dark:text-gray-300">
                            Model dir (inside container)
                            <input
                              disabled={!canEdit}
                              value={config.embedded.model_dir}
                              onChange={(e) =>
                                setConfig({
                                  ...config,
                                  embedded: { ...config.embedded, model_dir: e.target.value },
                                })
                              }
                              className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
                            />
                          </label>
                          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                            <input
                              type="checkbox"
                              checked={config.embedded.auto_install}
                              disabled={!canEdit}
                              onChange={(e) =>
                                setConfig({
                                  ...config,
                                  embedded: { ...config.embedded, auto_install: e.target.checked },
                                })
                              }
                            />
                            allow auto-install (advanced)
                          </label>

                          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                            <input
                              type="checkbox"
                              checked={config.embedded.auto_download}
                              disabled={!canEdit}
                              onChange={(e) =>
                                setConfig({
                                  ...config,
                                  embedded: { ...config.embedded, auto_download: e.target.checked },
                                })
                              }
                            />
                            allow auto-download (requires explicit URLs)
                          </label>

                          <p className="text-xs text-gray-500 dark:text-gray-400">
                            Embedded mode can download assets into the model dir. ProteinMPNN can run embedded once code+weights+deps are present. AlphaFold/RFDiffusion embedded execution is not enabled by default (downloads are supported, but running them still requires extra installs).
                          </p>

                          <div className="mt-2 rounded-md border border-gray-200 p-2 dark:border-gray-800">
                            <div className="mb-2 text-xs font-semibold text-gray-800 dark:text-gray-200">
                              Embedded runner commands (advanced)
                            </div>
                            <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
                              Provide one CLI arg per line. Placeholders supported: {'{model_dir}'}, {'{work_dir}'}, {'{fasta_path}'}, {'{target_pdb_path}'}, {'{output_dir}'}, {'{output_pdb_path}'}, {'{num_designs}'}.
                            </p>

                            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                              <div>
                                <div className="mb-1 text-xs font-semibold text-gray-800 dark:text-gray-200">AlphaFold</div>
                                <textarea
                                  disabled={!canEdit}
                                  value={(config.embedded.runners.alphafold.argv || []).join('\n')}
                                  onChange={(e) => setRunnerArgv('alphafold', e.target.value)}
                                  className="h-24 w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-xs dark:border-gray-700 dark:bg-gray-950"
                                  placeholder="python\n/app/run_alphafold.py\n--fasta\n{fasta_path}\n--out\n{output_pdb_path}"
                                />
                                <label className="mt-2 block text-xs text-gray-600 dark:text-gray-300">
                                  Timeout (seconds)
                                  <input
                                    disabled={!canEdit}
                                    type="number"
                                    min={1}
                                    value={config.embedded.runners.alphafold.timeout_seconds}
                                    onChange={(e) => setRunnerTimeout('alphafold', e.target.value)}
                                    className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
                                  />
                                </label>
                              </div>

                              <div>
                                <div className="mb-1 text-xs font-semibold text-gray-800 dark:text-gray-200">RFDiffusion</div>
                                <textarea
                                  disabled={!canEdit}
                                  value={(config.embedded.runners.rfdiffusion.argv || []).join('\n')}
                                  onChange={(e) => setRunnerArgv('rfdiffusion', e.target.value)}
                                  className="h-24 w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-xs dark:border-gray-700 dark:bg-gray-950"
                                  placeholder="python\n/app/run_rfdiffusion.py\n--target\n{target_pdb_path}\n--outdir\n{output_dir}\n--num\n{num_designs}"
                                />
                                <label className="mt-2 block text-xs text-gray-600 dark:text-gray-300">
                                  Timeout (seconds)
                                  <input
                                    disabled={!canEdit}
                                    type="number"
                                    min={1}
                                    value={config.embedded.runners.rfdiffusion.timeout_seconds}
                                    onChange={(e) => setRunnerTimeout('rfdiffusion', e.target.value)}
                                    className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
                                  />
                                </label>
                              </div>

                              <div>
                                <div className="mb-1 text-xs font-semibold text-gray-800 dark:text-gray-200">AlphaFold multimer</div>
                                <textarea
                                  disabled={!canEdit}
                                  value={(config.embedded.runners.alphafold_multimer.argv || []).join('\n')}
                                  onChange={(e) => setRunnerArgv('alphafold_multimer', e.target.value)}
                                  className="h-24 w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-xs dark:border-gray-700 dark:bg-gray-950"
                                  placeholder="python\n/app/run_alphafold_multimer.py\n--fasta\n{fasta_path}\n--out\n{output_pdb_path}"
                                />
                                <label className="mt-2 block text-xs text-gray-600 dark:text-gray-300">
                                  Timeout (seconds)
                                  <input
                                    disabled={!canEdit}
                                    type="number"
                                    min={1}
                                    value={config.embedded.runners.alphafold_multimer.timeout_seconds}
                                    onChange={(e) => setRunnerTimeout('alphafold_multimer', e.target.value)}
                                    className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
                                  />
                                </label>
                              </div>
                            </div>
                          </div>

                          <div className="mt-2 rounded-md border border-gray-200 p-2 dark:border-gray-800">
                            <div className="mb-2 text-xs font-semibold text-gray-800 dark:text-gray-200">
                              Embedded download URLs
                            </div>

                            <label className="block text-xs text-gray-600 dark:text-gray-300">
                              ProteinMPNN source tarball URL
                              <input
                                disabled={!canEdit}
                                value={config.embedded.downloads.proteinmpnn_source_tarball_url ?? ''}
                                onChange={(e) =>
                                  setConfig({
                                    ...config,
                                    embedded: {
                                      ...config.embedded,
                                      downloads: {
                                        ...config.embedded.downloads,
                                        proteinmpnn_source_tarball_url: e.target.value.trim() || null,
                                      },
                                    },
                                  })
                                }
                                className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
                                placeholder="https://github.com/dauparas/ProteinMPNN/archive/refs/heads/main.tar.gz"
                              />
                            </label>

                            <label className="mt-2 block text-xs text-gray-600 dark:text-gray-300">
                              ProteinMPNN weights URL
                              <input
                                disabled={!canEdit}
                                value={config.embedded.downloads.proteinmpnn_weights_url ?? ''}
                                onChange={(e) =>
                                  setConfig({
                                    ...config,
                                    embedded: {
                                      ...config.embedded,
                                      downloads: {
                                        ...config.embedded.downloads,
                                        proteinmpnn_weights_url: e.target.value.trim() || null,
                                      },
                                    },
                                  })
                                }
                                className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
                                placeholder="https://.../v_48_020.pt"
                              />
                            </label>

                            <label className="mt-2 block text-xs text-gray-600 dark:text-gray-300">
                              RFDiffusion weights URL
                              <input
                                disabled={!canEdit}
                                value={config.embedded.downloads.rfdiffusion_weights_url ?? ''}
                                onChange={(e) =>
                                  setConfig({
                                    ...config,
                                    embedded: {
                                      ...config.embedded,
                                      downloads: {
                                        ...config.embedded.downloads,
                                        rfdiffusion_weights_url: e.target.value.trim() || null,
                                      },
                                    },
                                  })
                                }
                                className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
                                placeholder="https://.../rfdiffusion_weights.zip"
                              />
                            </label>

                            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                              If you want full AlphaFold DBs, either configure staged downloads here (reduced first, then full extras) or
                              set the AlphaFold URL under NIM/External to point at a service that already has the full DBs.
                            </p>

                            <label className="mt-2 block text-xs text-gray-600 dark:text-gray-300">
                              AlphaFold DB URL (reduced / initial)
                              <input
                                disabled={!canEdit}
                                value={config.embedded.downloads.alphafold_db_url ?? ''}
                                onChange={(e) =>
                                  setConfig({
                                    ...config,
                                    embedded: {
                                      ...config.embedded,
                                      downloads: {
                                        ...config.embedded.downloads,
                                        alphafold_db_url: e.target.value.trim() || null,
                                      },
                                    },
                                  })
                                }
                                className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
                                placeholder="https://.../alphafold_db.tar.gz"
                              />
                            </label>

                            <label className="mt-2 block text-xs text-gray-600 dark:text-gray-300">
                              AlphaFold DB URL (full extras, optional)
                              <input
                                disabled={!canEdit}
                                value={config.embedded.downloads.alphafold_db_url_full ?? ''}
                                onChange={(e) =>
                                  setConfig({
                                    ...config,
                                    embedded: {
                                      ...config.embedded,
                                      downloads: {
                                        ...config.embedded.downloads,
                                        alphafold_db_url_full: e.target.value.trim() || null,
                                      },
                                    },
                                  })
                                }
                                className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
                                placeholder="https://.../alphafold_db_full_extras.tar.gz"
                              />
                              <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
                                Downloaded after the reduced pack completes.
                              </p>
                            </label>

                            <label className="mt-2 block text-xs text-gray-600 dark:text-gray-300">
                              AlphaFold DB subdir
                              <input
                                disabled={!canEdit}
                                value={config.embedded.downloads.alphafold_db_subdir}
                                onChange={(e) =>
                                  setConfig({
                                    ...config,
                                    embedded: {
                                      ...config.embedded,
                                      downloads: {
                                        ...config.embedded.downloads,
                                        alphafold_db_subdir: e.target.value.trim() || 'alphafold_db',
                                      },
                                    },
                                  })
                                }
                                className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
                                placeholder="alphafold_db"
                              />
                            </label>

                            <div className="mt-3 rounded-md border border-gray-200 bg-gray-50 p-2 text-xs text-gray-700 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-200">
                              <div className="mb-1 font-semibold">MGnify (AlphaFold reduced DB)</div>
                              <p className="text-[11px] text-gray-600 dark:text-gray-400">
                                AlphaFold’s reduced DB tier downloads an MGnify cluster FASTA from Google Cloud Storage.
                                In some networks this can return <span className="font-mono">403</span>.
                              </p>
                              <ul className="mt-2 list-disc space-y-1 pl-4 text-[11px] text-gray-600 dark:text-gray-400">
                                <li>
                                  If you have access via a mirror or signed URL, paste it below.
                                </li>
                                <li>
                                  Otherwise, you can opt into a HuggingFace fallback dataset. This generates a smaller substitute FASTA to unblock installs (not the official MGnify cluster DB), and may reduce MSA coverage/accuracy.
                                </li>
                              </ul>

                              <label className="mt-2 block text-xs text-gray-600 dark:text-gray-300">
                                MGnify URL override (mirror / signed URL)
                                <input
                                  disabled={!canEdit}
                                  value={config.embedded.downloads.alphafold_mgnify_url ?? ''}
                                  onChange={(e) =>
                                    setConfig({
                                      ...config,
                                      embedded: {
                                        ...config.embedded,
                                        downloads: {
                                          ...config.embedded.downloads,
                                          alphafold_mgnify_url: e.target.value.trim() || null,
                                        },
                                      },
                                    })
                                  }
                                  className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
                                  placeholder="https://.../mgy_clusters_2022_05.fa.gz"
                                />
                              </label>

                              <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-3">
                                <label className="text-xs text-gray-600 dark:text-gray-300">
                                  Fallback
                                  <select
                                    disabled={!canEdit}
                                    value={config.embedded.downloads.alphafold_mgnify_fallback}
                                    onChange={(e) =>
                                      setConfig({
                                        ...config,
                                        embedded: {
                                          ...config.embedded,
                                          downloads: {
                                            ...config.embedded.downloads,
                                            alphafold_mgnify_fallback:
                                              e.target.value === 'huggingface' ? 'huggingface' : 'none',
                                          },
                                        },
                                      })
                                    }
                                    className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
                                  >
                                    <option value="none">none (default)</option>
                                    <option value="huggingface">huggingface</option>
                                  </select>
                                </label>

                                <label className="text-xs text-gray-600 dark:text-gray-300 md:col-span-2">
                                  HuggingFace dataset
                                  <input
                                    disabled={!canEdit || config.embedded.downloads.alphafold_mgnify_fallback !== 'huggingface'}
                                    value={config.embedded.downloads.alphafold_mgnify_hf_dataset}
                                    onChange={(e) =>
                                      setConfig({
                                        ...config,
                                        embedded: {
                                          ...config.embedded,
                                          downloads: {
                                            ...config.embedded.downloads,
                                            alphafold_mgnify_hf_dataset: e.target.value.trim() || 'tattabio/OMG_prot50',
                                          },
                                        },
                                      })
                                    }
                                    className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm disabled:opacity-60 dark:border-gray-700 dark:bg-gray-950"
                                    placeholder="tattabio/OMG_prot50"
                                  />
                                </label>
                              </div>

                              <label className="mt-2 block text-xs text-gray-600 dark:text-gray-300">
                                HuggingFace token (optional)
                                <input
                                  disabled={!canEdit || config.embedded.downloads.alphafold_mgnify_fallback !== 'huggingface'}
                                  type="password"
                                  value={config.embedded.downloads.alphafold_mgnify_hf_token ?? ''}
                                  onChange={(e) =>
                                    setConfig({
                                      ...config,
                                      embedded: {
                                        ...config.embedded,
                                        downloads: {
                                          ...config.embedded.downloads,
                                          alphafold_mgnify_hf_token: e.target.value.trim() || null,
                                        },
                                      },
                                    })
                                  }
                                  className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm disabled:opacity-60 dark:border-gray-700 dark:bg-gray-950"
                                  placeholder="hf_..."
                                />
                                <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
                                  Token can be created at huggingface.co/settings/tokens. Note: saving this here may persist it in the MCP config file.
                                </p>
                              </label>
                            </div>
                          </div>

                          <div className="mt-2 rounded-md border border-gray-200 p-2 dark:border-gray-800">
                            <div className="mb-2 text-xs font-semibold text-gray-800 dark:text-gray-200">
                              Download now
                            </div>
                            <div className="flex flex-wrap gap-3 text-sm text-gray-700 dark:text-gray-300">
                              {(['proteinmpnn', 'rfdiffusion', 'alphafold'] as ServiceName[]).map((m) => (
                                <label key={m} className="flex items-center gap-2">
                                  <input
                                    type="checkbox"
                                    checked={bootstrapModels[m]}
                                    onChange={(e) => setBootstrapModels({ ...bootstrapModels, [m]: e.target.checked })}
                                  />
                                  {m}
                                </label>
                              ))}
                            </div>
                            <button
                              onClick={runEmbeddedBootstrap}
                              disabled={!config.embedded.enabled || bootstrapping}
                              className="mt-2 rounded-md bg-gray-100 px-3 py-2 text-sm text-gray-800 hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-200"
                              title="Downloads into the embedded model dir (/models)"
                            >
                              {bootstrapping ? 'Downloading…' : 'Download embedded assets'}
                            </button>

                            {bootstrapResult && (
                              <pre className="mt-2 max-h-48 overflow-auto rounded bg-gray-50 p-2 text-xs text-gray-700 dark:bg-gray-950 dark:text-gray-200">
                                {JSON.stringify(bootstrapResult, null, 2)}
                              </pre>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  </section>

                  <section>
                    <h4 className="mb-2 text-sm font-semibold text-gray-900 dark:text-white">BLAST Retrieval</h4>
                    <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
                      Controls retrieval API exposure, evidence enrichment, and opt-in design-job grounding.
                    </p>

                    <div className="space-y-4 rounded-md border border-gray-200 p-3 dark:border-gray-800">
                      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                          <input
                            type="checkbox"
                            checked={config.retrieval.feature_flags.enabled}
                            disabled={!canEdit}
                            onChange={(e) => setRetrievalFlag('enabled', e.target.checked)}
                          />
                          retrieval enabled
                        </label>
                        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                          <input
                            type="checkbox"
                            checked={config.retrieval.feature_flags.allow_job_grounding}
                            disabled={!canEdit}
                            onChange={(e) => setRetrievalFlag('allow_job_grounding', e.target.checked)}
                          />
                          allow job grounding (opt-in)
                        </label>
                        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                          <input
                            type="checkbox"
                            checked={config.retrieval.feature_flags.expose_rest}
                            disabled={!canEdit}
                            onChange={(e) => setRetrievalFlag('expose_rest', e.target.checked)}
                          />
                          expose REST endpoints
                        </label>
                        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                          <input
                            type="checkbox"
                            checked={config.retrieval.feature_flags.expose_mcp}
                            disabled={!canEdit}
                            onChange={(e) => setRetrievalFlag('expose_mcp', e.target.checked)}
                          />
                          expose MCP tools/resources
                        </label>
                        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                          <input
                            type="checkbox"
                            checked={config.retrieval.feature_flags.evidence_enrichment}
                            disabled={!canEdit}
                            onChange={(e) => setRetrievalFlag('evidence_enrichment', e.target.checked)}
                          />
                          evidence enrichment
                        </label>
                        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                          <input
                            type="checkbox"
                            checked={config.retrieval.feature_flags.export_parquet}
                            disabled={!canEdit}
                            onChange={(e) => setRetrievalFlag('export_parquet', e.target.checked)}
                          />
                          export parquet bundles
                        </label>
                        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                          <input
                            type="checkbox"
                            checked={config.retrieval.feature_flags.create_schema_on_startup}
                            disabled={!canEdit}
                            onChange={(e) => setRetrievalFlag('create_schema_on_startup', e.target.checked)}
                          />
                          create schema on startup
                        </label>
                      </div>

                      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                        <label className="text-xs text-gray-600 dark:text-gray-300">
                          Provider
                          <select
                            disabled={!canEdit}
                            value={config.retrieval.provider}
                            onChange={(e) =>
                              setConfig({
                                ...config,
                                retrieval: {
                                  ...config.retrieval,
                                  provider: e.target.value as RetrievalProviderName,
                                },
                              })
                            }
                            className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
                          >
                            <option value="ncbi_blast_remote">ncbi_blast_remote</option>
                            <option value="local_blast">local_blast</option>
                          </select>
                        </label>
                        <label className="text-xs text-gray-600 dark:text-gray-300">
                          Remote BLAST URL
                          <input
                            disabled={!canEdit}
                            value={config.retrieval.blast.remote_base_url}
                            onChange={(e) => setRetrievalBlast('remote_base_url', e.target.value)}
                            className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
                            placeholder="https://blast.ncbi.nlm.nih.gov/Blast.cgi"
                          />
                        </label>
                        <label className="text-xs text-gray-600 dark:text-gray-300">
                          Program
                          <input
                            disabled={!canEdit}
                            value={config.retrieval.blast.default_program}
                            onChange={(e) => setRetrievalBlast('default_program', e.target.value)}
                            className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
                            placeholder="blastp"
                          />
                        </label>
                        <label className="text-xs text-gray-600 dark:text-gray-300">
                          Database
                          <input
                            disabled={!canEdit}
                            value={config.retrieval.blast.default_database}
                            onChange={(e) => setRetrievalBlast('default_database', e.target.value)}
                            className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
                            placeholder="swissprot"
                          />
                        </label>
                        <label className="text-xs text-gray-600 dark:text-gray-300">
                          Hitlist size
                          <input
                            disabled={!canEdit}
                            type="number"
                            min={1}
                            value={config.retrieval.blast.default_hitlist_size}
                            onChange={(e) => setRetrievalBlast('default_hitlist_size', e.target.value)}
                            className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
                          />
                        </label>
                        <label className="text-xs text-gray-600 dark:text-gray-300">
                          Max hitlist size
                          <input
                            disabled={!canEdit}
                            type="number"
                            min={1}
                            value={config.retrieval.blast.max_hitlist_size}
                            onChange={(e) => setRetrievalBlast('max_hitlist_size', e.target.value)}
                            className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
                          />
                        </label>
                        <label className="text-xs text-gray-600 dark:text-gray-300">
                          Poll interval (seconds)
                          <input
                            disabled={!canEdit}
                            type="number"
                            min={1}
                            step="0.5"
                            value={config.retrieval.blast.poll_interval_seconds}
                            onChange={(e) => setRetrievalBlast('poll_interval_seconds', e.target.value)}
                            className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
                          />
                        </label>
                        <label className="text-xs text-gray-600 dark:text-gray-300">
                          Max poll attempts
                          <input
                            disabled={!canEdit}
                            type="number"
                            min={1}
                            value={config.retrieval.blast.max_poll_attempts}
                            onChange={(e) => setRetrievalBlast('max_poll_attempts', e.target.value)}
                            className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
                          />
                        </label>
                        <label className="text-xs text-gray-600 dark:text-gray-300">
                          Request timeout (seconds)
                          <input
                            disabled={!canEdit}
                            type="number"
                            min={1}
                            step="0.5"
                            value={config.retrieval.blast.request_timeout_seconds}
                            onChange={(e) => setRetrievalBlast('request_timeout_seconds', e.target.value)}
                            className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
                          />
                        </label>
                      </div>
                    </div>
                  </section>

                  <section>
                    <h4 className="mb-2 text-sm font-semibold text-gray-900 dark:text-white">External URLs</h4>
                    <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
                      Leave blank to disable that service for the provider.
                    </p>
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      {SERVICES.map((svc) => (
                        <div key={svc} className="space-y-2 rounded-md border border-gray-200 p-3 dark:border-gray-800">
                          <div className="text-sm font-semibold text-gray-900 dark:text-white">{svc}</div>
                          <label className="block text-xs text-gray-600 dark:text-gray-300">
                            NIM URL
                            <input
                              disabled={!canEdit}
                              value={config.nim.service_urls[svc] ?? ''}
                              onChange={(e) => setUrl('nim', svc, e.target.value)}
                              className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
                              placeholder="http://alphafold:8000"
                            />
                          </label>
                          <label className="block text-xs text-gray-600 dark:text-gray-300">
                            External URL
                            <input
                              disabled={!canEdit}
                              value={config.external.service_urls[svc] ?? ''}
                              onChange={(e) => setUrl('external', svc, e.target.value)}
                              className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
                              placeholder="http://my-service:8000"
                            />
                          </label>
                        </div>
                      ))}
                    </div>
                  </section>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-gray-200 px-5 py-4 dark:border-gray-800">
              <div className="flex items-center gap-2">
                <button
                  onClick={load}
                  disabled={loading}
                  className="rounded-md bg-gray-100 px-3 py-2 text-sm text-gray-800 hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-200"
                >
                  Reload
                </button>
                <button
                  onClick={reset}
                  disabled={!canEdit || saving}
                  className="rounded-md bg-gray-100 px-3 py-2 text-sm text-gray-800 hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-200"
                >
                  Reset defaults
                </button>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setOpen(false)}
                  className="rounded-md px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
                >
                  Cancel
                </button>
                <button
                  onClick={save}
                  disabled={!canEdit || saving || !config}
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
