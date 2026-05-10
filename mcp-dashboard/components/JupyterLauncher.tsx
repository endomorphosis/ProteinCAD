'use client'

export default function JupyterLauncher() {
  const handleLaunchJupyter = () => {
    window.open('http://localhost:8888', '_blank')
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-orange-400/20 bg-orange-400/10 p-4">
        <p className="text-sm leading-6 text-orange-50/95">
          Launch Jupyter Notebook to explore the protein design workflow interactively and prototype analyses next to the dashboard.
        </p>
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

      <div className="grid gap-3 sm:grid-cols-3">
        <InfoBlock label="Notebook" value="protein-binder-design.ipynb" />
        <InfoBlock label="Default port" value="8888" />
        <InfoBlock label="Requirement" value="Jupyter server running" />
      </div>

      <div className="rounded-2xl border border-white/10 bg-slate-950/70 p-4">
        <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Quick Start</h4>
        <pre className="mt-3 overflow-auto rounded-xl bg-black/30 p-3 font-mono text-xs text-cyan-100">
{`cd src
jupyter notebook`}
        </pre>
      </div>
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
