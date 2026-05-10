'use client'

import { useEffect, useMemo, useState } from 'react'
import { mcpClient } from '@/lib/mcp-client'
import { ProteinSequenceInput } from '@/lib/types'

interface Props {
  onJobCreated: () => void
  prefill?: Partial<ProteinSequenceInput>
}

const exampleSequences = [
  'Helical binder',
  'Membrane target',
  'Antibody loop',
]

export default function ProteinSequenceForm({ onJobCreated, prefill }: Props) {
  const [formData, setFormData] = useState<ProteinSequenceInput>({
    sequence: '',
    job_name: '',
    num_designs: 5,
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const prefillSequence = prefill?.sequence
  const prefillNumDesigns = prefill?.num_designs

  useEffect(() => {
    if (prefillSequence === undefined && prefillNumDesigns === undefined) return

    setFormData((prev) => ({
      ...prev,
      sequence: typeof prefillSequence === 'string' ? prefillSequence : prev.sequence,
      num_designs:
        typeof prefillNumDesigns === 'number' && Number.isFinite(prefillNumDesigns)
          ? prefillNumDesigns
          : prev.num_designs,
    }))
  }, [prefillNumDesigns, prefillSequence])

  const sequenceStats = useMemo(() => {
    const normalized = formData.sequence.replace(/\s+/g, '')
    const uniqueResidues = new Set(normalized.split('').filter(Boolean))
    return {
      length: normalized.length,
      uniqueResidues: uniqueResidues.size,
    }
  }, [formData.sequence])

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setLoading(true)
    setError(null)

    try {
      await mcpClient.createJob({
        sequence: formData.sequence,
        job_name: formData.job_name || undefined,
        num_designs: formData.num_designs,
      })

      setFormData({ sequence: '', job_name: '', num_designs: 5 })
      onJobCreated()
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Failed to create job')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {exampleSequences.map((label) => (
          <span
            key={label}
            className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium text-slate-300"
          >
            {label}
          </span>
        ))}
      </div>

      <div>
        <label htmlFor="job_name" className="mb-1.5 block text-sm font-medium text-slate-200">
          Job Name (Optional)
        </label>
        <input
          type="text"
          id="job_name"
          value={formData.job_name}
          onChange={(event) => setFormData({ ...formData, job_name: event.target.value })}
          className="w-full rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-cyan-400/40 focus:ring-2 focus:ring-cyan-400/20"
          placeholder="My Protein Design"
        />
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between gap-3">
          <label htmlFor="sequence" className="block text-sm font-medium text-slate-200">
            Target Protein Sequence *
          </label>
          <span className="text-xs text-slate-400">{sequenceStats.length} aa · {sequenceStats.uniqueResidues} unique residues</span>
        </div>
        <textarea
          id="sequence"
          value={formData.sequence}
          onChange={(event) => setFormData({ ...formData, sequence: event.target.value.toUpperCase() })}
          required
          rows={6}
          className="w-full rounded-2xl border border-white/10 bg-slate-950/70 px-3 py-3 font-mono text-sm text-slate-100 outline-none transition focus:border-cyan-400/40 focus:ring-2 focus:ring-cyan-400/20"
          placeholder="MKFLKFSLLTAVLLSVVFAFSSCGDDDDTGYLPPSQAIQDLLKRMKV..."
        />
        <p className="mt-2 text-xs leading-5 text-slate-400">
          Paste a one-letter amino acid sequence. The dashboard will use it as the design target for binder generation.
        </p>
      </div>

      <div>
        <label htmlFor="num_designs" className="mb-1.5 block text-sm font-medium text-slate-200">
          Number of Designs
        </label>
        <input
          type="number"
          id="num_designs"
          value={formData.num_designs}
          onChange={(event) => setFormData({ ...formData, num_designs: parseInt(event.target.value, 10) })}
          min="1"
          max="20"
          className="w-full rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-cyan-400/40 focus:ring-2 focus:ring-cyan-400/20"
        />
      </div>

      {error && (
        <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 p-3 text-sm text-rose-100">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={loading || !formData.sequence}
        className="w-full rounded-2xl bg-gradient-to-r from-cyan-400 to-violet-500 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? 'Creating Job…' : 'Start Design Job'}
      </button>
    </form>
  )
}
