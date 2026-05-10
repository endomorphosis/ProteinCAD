'use client'

import { useState, useEffect } from 'react'
import ProteinSequenceForm from '@/components/ProteinSequenceForm'
import JobList from '@/components/JobList'
import ResultsViewer from '@/components/ResultsViewer'
import ServiceStatus from '@/components/ServiceStatus'
import JupyterLauncher from '@/components/JupyterLauncher'
import ToolsPanel from '@/components/ToolsPanel'
import BackendSettings from '@/components/BackendSettings'
import AlphaFoldSettings from '@/components/AlphaFoldSettings'
import { Job } from '@/lib/types'

const workflowCards = [
  {
    title: 'Design',
    description: 'Create binder jobs with reusable inputs and tuned AlphaFold presets.',
    accent: 'from-violet-500 to-indigo-500',
  },
  {
    title: 'Track',
    description: 'Monitor live job progress, backend readiness, and error states in one place.',
    accent: 'from-sky-500 to-cyan-500',
  },
  {
    title: 'Analyze',
    description: 'Inspect structures in 3D, propose variants, and iterate on promising designs.',
    accent: 'from-emerald-500 to-teal-500',
  },
]

const quickTips = [
  'Select any completed job to compare structures, scores, and saved variants.',
  'Use the 3D viewer chain filter and residue focus controls to inspect hotspots quickly.',
  'Save strong candidates to the design library so they can be revisited or iterated later.',
]

export default function Home() {
  const [selectedJob, setSelectedJob] = useState<Job | null>(null)
  const [refreshTrigger, setRefreshTrigger] = useState(0)
  const [prefill, setPrefill] = useState<{ sequence?: string; num_designs?: number } | null>(null)

  const handleJobCreated = () => {
    setRefreshTrigger((prev) => prev + 1)
  }

  const handleJobSelected = (job: Job) => {
    setSelectedJob(job)
  }

  const handleIterate = (input: { sequence: string; num_designs?: number }) => {
    setPrefill({ sequence: input.sequence, num_designs: input.num_designs })
  }

  useEffect(() => {
    let es: EventSource | null = null
    try {
      es = new EventSource('/sse')
      es.onmessage = () => {
        setRefreshTrigger((prev) => prev + 1)
      }
      es.onerror = (err) => {
        console.warn('SSE error', err)
      }
    } catch (e) {
      console.warn('Failed to connect to MCP SSE', e)
    }

    return () => {
      es?.close()
    }
  }, [])

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <header className="overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-slate-900 via-slate-900 to-slate-800 shadow-2xl shadow-slate-950/30">
          <div className="flex flex-col gap-8 px-6 py-8 lg:px-8 lg:py-10">
            <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
              <div className="max-w-3xl">
                <span className="inline-flex items-center rounded-full border border-cyan-400/30 bg-cyan-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.25em] text-cyan-200">
                  MCP server dashboard
                </span>
                <h1 className="mt-4 text-4xl font-semibold tracking-tight text-white sm:text-5xl">
                  Protein Binder Design Control Center
                </h1>
                <p className="mt-4 max-w-2xl text-base leading-7 text-slate-300 sm:text-lg">
                  Design, monitor, and analyze generated protein binders with a workflow-oriented UI
                  tuned for structural review and rapid iteration.
                </p>
              </div>
              <div className="flex items-center gap-3 self-start">
                <BackendSettings />
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              {workflowCards.map((card) => (
                <div
                  key={card.title}
                  className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur-sm"
                >
                  <div className={`mb-4 h-1.5 w-16 rounded-full bg-gradient-to-r ${card.accent}`} />
                  <h2 className="text-lg font-semibold text-white">{card.title}</h2>
                  <p className="mt-2 text-sm leading-6 text-slate-300">{card.description}</p>
                </div>
              ))}
            </div>
          </div>
        </header>

        <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,2.4fr)_minmax(0,1.6fr)]">
          <ServiceStatus />
          <AlphaFoldSettings onSettingsChanged={handleJobCreated} />
        </div>

        <div className="mt-6 grid gap-6 xl:grid-cols-12">
          <div className="space-y-6 xl:col-span-3">
            <section className="rounded-3xl border border-white/10 bg-slate-900/70 p-6 shadow-xl shadow-slate-950/20 backdrop-blur">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-2xl font-semibold text-white">New Design Job</h2>
                  <p className="mt-1 text-sm text-slate-400">Launch a new binder generation run.</p>
                </div>
                <span className="rounded-full bg-emerald-400/10 px-3 py-1 text-xs font-medium text-emerald-200">
                  Interactive
                </span>
              </div>
              <ProteinSequenceForm onJobCreated={handleJobCreated} prefill={prefill ?? undefined} />
            </section>

            <section className="rounded-3xl border border-white/10 bg-slate-900/70 p-6 shadow-xl shadow-slate-950/20 backdrop-blur">
              <div className="mb-4">
                <h2 className="text-2xl font-semibold text-white">MCP Tools</h2>
                <p className="mt-1 text-sm text-slate-400">Inspect tool schemas and run focused operations.</p>
              </div>
              <ToolsPanel />
            </section>

            <section className="rounded-3xl border border-white/10 bg-slate-900/70 p-6 shadow-xl shadow-slate-950/20 backdrop-blur">
              <h2 className="text-2xl font-semibold text-white">Notebook Access</h2>
              <p className="mt-1 text-sm text-slate-400">Open exploratory notebooks next to the dashboard workflow.</p>
              <div className="mt-4">
                <JupyterLauncher />
              </div>
            </section>

            <section className="rounded-3xl border border-cyan-400/20 bg-cyan-400/5 p-6 shadow-lg shadow-cyan-950/10">
              <h2 className="text-lg font-semibold text-white">Analysis tips</h2>
              <ul className="mt-4 space-y-3 text-sm leading-6 text-slate-300">
                {quickTips.map((tip) => (
                  <li key={tip} className="flex gap-3">
                    <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-cyan-300" />
                    <span>{tip}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <div className="xl:col-span-3">
            <section className="rounded-3xl border border-white/10 bg-slate-900/70 p-6 shadow-xl shadow-slate-950/20 backdrop-blur">
              <div className="mb-4">
                <h2 className="text-2xl font-semibold text-white">Jobs</h2>
                <p className="mt-1 text-sm text-slate-400">
                  Filter active and completed runs, then drill into structural output.
                </p>
              </div>
              <JobList refreshTrigger={refreshTrigger} onJobSelected={handleJobSelected} />
            </section>
          </div>

          <div className="xl:col-span-6">
            <section className="rounded-3xl border border-white/10 bg-slate-900/70 p-6 shadow-xl shadow-slate-950/20 backdrop-blur">
              <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-2xl font-semibold text-white">Results & Structural Analysis</h2>
                  <p className="mt-1 text-sm text-slate-400">
                    Review generated complexes, compare designs, and launch the interactive 3D viewer.
                  </p>
                </div>
                {selectedJob && (
                  <span className="inline-flex items-center rounded-full border border-violet-400/30 bg-violet-400/10 px-3 py-1 text-xs font-semibold text-violet-100">
                    Selected: {selectedJob.job_name || selectedJob.job_id}
                  </span>
                )}
              </div>
              {selectedJob ? (
                <ResultsViewer job={selectedJob} onIterate={handleIterate} />
              ) : (
                <div className="rounded-2xl border border-dashed border-white/10 bg-slate-950/40 px-6 py-16 text-center text-slate-400">
                  <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full border border-white/10 bg-white/5 text-3xl">
                    🔬
                  </div>
                  <p className="text-lg font-medium text-slate-200">Select a job to inspect the generated structures.</p>
                  <p className="mt-2 text-sm text-slate-400">
                    Completed jobs unlock design comparisons, downloads, and the upgraded 3D viewer.
                  </p>
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
    </main>
  )
}
