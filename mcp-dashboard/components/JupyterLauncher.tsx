'use client'

interface Props {
  tips?: string[]
}

export default function JupyterLauncher({ tips = [] }: Props) {
  const handleLaunchJupyter = () => {
    window.open('http://localhost:8888', '_blank')
  }

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-orange-400/20 bg-gradient-to-br from-orange-400/15 via-orange-400/10 to-amber-400/10 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-orange-50">Notebook workspace</p>
            <p className="mt-1 text-sm leading-6 text-orange-50/85">
              Open Jupyter for exploratory analysis and structure prototyping beside the dashboard workflow.
            </p>
          </div>
          <span className="rounded-full border border-orange-300/20 bg-white/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-orange-100">
            Optional
          </span>
        </div>
      </div>

      <button
        onClick={handleLaunchJupyter}
        className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-orange-500 to-amber-500 px-4 py-3 text-sm font-semibold text-white transition hover:brightness-110"
      >
        <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
        </svg>
        <span>Open Jupyter Notebook</span>
      </button>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <InfoBlock label="Notebook" value="protein-binder-design.ipynb" />
        <InfoBlock label="Default port" value="8888" />
        <InfoBlock label="Requirement" value="Jupyter server running" />
      </div>

      <details className="group rounded-2xl border border-white/10 bg-slate-950/70 p-4">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold uppercase tracking-wide text-slate-300">
          Quick Start
          <span className="text-xs text-slate-500 transition group-open:rotate-180">⌄</span>
        </summary>
        <pre className="mt-3 overflow-auto rounded-xl bg-black/30 p-3 font-mono text-xs text-cyan-100">
{`cd src
jupyter notebook`}
        </pre>
      </details>

      {tips.length > 0 && (
        <details className="group rounded-2xl border border-cyan-400/15 bg-cyan-400/5 p-4">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold uppercase tracking-wide text-cyan-100">
            Analysis tips
            <span className="text-xs text-cyan-200/70 transition group-open:rotate-180">⌄</span>
          </summary>
          <ul className="mt-3 space-y-2 text-sm leading-6 text-slate-300">
            {tips.map((tip) => (
              <li key={tip} className="flex gap-3 rounded-xl bg-slate-950/20 px-3 py-2">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-300" />
                <span>{tip}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function InfoBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-2 text-sm text-slate-100">{value}</div>
    </div>
  )
}
