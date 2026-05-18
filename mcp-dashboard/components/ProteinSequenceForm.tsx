'use client'

import { useEffect, useMemo, useState } from 'react'
import { mcpClient } from '@/lib/mcp-client'
import { ProteinSequenceInput } from '@/lib/types'

interface Props {
  onJobCreated: () => void
  prefill?: Partial<ProteinSequenceInput>
}

const exampleSequences = [
  {
    label: 'Helical binder',
    sequence: 'MKWVTFISLLLLFSSAYSRGVFRRDAHKSEVAHRFKDLGE',
    numDesigns: 6,
  },
  {
    label: 'Membrane target',
    sequence: 'MNNRWLFSTNHKDIGTLYLLFGAWAGVLGTALSLLIRAEL',
    numDesigns: 4,
  },
  {
    label: 'Antibody loop',
    sequence: 'QVQLQESGPGLVKPSQTLSLTCTVSGGSISSYYWSWIRQP',
    numDesigns: 8,
  },
]
const RETRIEVAL_HITLIST_MIN = 1
const RETRIEVAL_HITLIST_MAX = 100

export default function ProteinSequenceForm({ onJobCreated, prefill }: Props) {
  const [formData, setFormData] = useState<ProteinSequenceInput>({
    sequence: '',
    job_name: '',
    num_designs: 5,
    ground_with_blast_evidence: false,
    retrieval_program: '',
    retrieval_database: '',
    retrieval_hitlist_size: 25,
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

  const applyExample = (example: (typeof exampleSequences)[number]) => {
    setFormData((prev) => ({
      ...prev,
      sequence: example.sequence,
      num_designs: example.numDesigns,
      job_name: prev.job_name || example.label,
    }))
  }

  const handleDesignCountChange = (value: string) => {
    const parsed = parseInt(value, 10)
    setFormData((prev) => ({
      ...prev,
      num_designs: Number.isFinite(parsed) ? parsed : prev.num_designs,
    }))
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setLoading(true)
    setError(null)

    try {
      await mcpClient.createJob({
        sequence: formData.sequence,
        job_name: formData.job_name || undefined,
        num_designs: formData.num_designs,
        ground_with_blast_evidence: Boolean(formData.ground_with_blast_evidence),
        retrieval_program: formData.ground_with_blast_evidence ? formData.retrieval_program || undefined : undefined,
        retrieval_database: formData.ground_with_blast_evidence ? formData.retrieval_database || undefined : undefined,
        retrieval_hitlist_size:
          formData.ground_with_blast_evidence && typeof formData.retrieval_hitlist_size === 'number'
            ? formData.retrieval_hitlist_size
            : undefined,
      })

      setFormData({
        sequence: '',
        job_name: '',
        num_designs: 5,
        ground_with_blast_evidence: false,
        retrieval_program: '',
        retrieval_database: '',
        retrieval_hitlist_size: 25,
      })
      onJobCreated()
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Failed to create job')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Starter sequences</p>
          <span className="text-xs text-slate-500">Load a sample with one click</span>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {exampleSequences.map((example) => (
            <button
              key={example.label}
              type="button"
              onClick={() => applyExample(example)}
              className="rounded-full border border-white/10 bg-slate-950/60 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:border-cyan-400/30 hover:bg-cyan-400/10 hover:text-cyan-100"
            >
              {example.label}
            </button>
          ))}
        </div>
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
          onChange={(event) => handleDesignCountChange(event.target.value)}
          min="1"
          max="20"
          className="w-full rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-cyan-400/40 focus:ring-2 focus:ring-cyan-400/20"
        />
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
        <label className="flex items-center gap-2 text-sm font-medium text-slate-200">
          <input
            type="checkbox"
            checked={Boolean(formData.ground_with_blast_evidence)}
            onChange={(event) =>
              setFormData((prev) => ({
                ...prev,
                ground_with_blast_evidence: event.target.checked,
              }))
            }
            className="h-4 w-4 rounded border-white/20 bg-slate-900 text-cyan-400"
          />
          Ground with BLAST evidence (opt-in)
        </label>
        <p className="mt-2 text-xs text-slate-400">
          Uses cached or live BLAST retrieval when enabled in backend settings.
        </p>

        {formData.ground_with_blast_evidence && (
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <label className="text-xs text-slate-300">
              Program
              <input
                value={formData.retrieval_program || ''}
                onChange={(event) =>
                  setFormData((prev) => ({ ...prev, retrieval_program: event.target.value.toLowerCase() }))
                }
                placeholder="blastp"
                className="mt-1 w-full rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400/40 focus:ring-2 focus:ring-cyan-400/20"
              />
            </label>
            <label className="text-xs text-slate-300">
              Database
              <input
                value={formData.retrieval_database || ''}
                onChange={(event) =>
                  setFormData((prev) => ({ ...prev, retrieval_database: event.target.value }))
                }
                placeholder="swissprot"
                className="mt-1 w-full rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400/40 focus:ring-2 focus:ring-cyan-400/20"
              />
            </label>
            <label className="text-xs text-slate-300">
              Hitlist size
              <input
                type="number"
                min={RETRIEVAL_HITLIST_MIN}
                max={RETRIEVAL_HITLIST_MAX}
                value={formData.retrieval_hitlist_size ?? 25}
                onChange={(event) =>
                  setFormData((prev) => {
                    const parsed = Number.parseInt(event.target.value, 10)
                    return {
                      ...prev,
                      retrieval_hitlist_size: Number.isNaN(parsed) ? 25 : parsed,
                    }
                  })
                }
                className="mt-1 w-full rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400/40 focus:ring-2 focus:ring-cyan-400/20"
              />
            </label>
          </div>
        )}
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
