'use client'

import { useEffect, useMemo, useState } from 'react'
import { mcpClient } from '@/lib/mcp-client'
import { Job } from '@/lib/types'

interface Props {
  refreshTrigger: number
  onJobSelected: (job: Job) => void
}

type JobFilter = 'all' | Job['status']

const filterOptions: Array<{ key: JobFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'running', label: 'Running' },
  { key: 'completed', label: 'Completed' },
  { key: 'failed', label: 'Failed' },
  { key: 'created', label: 'Queued' },
]

export default function JobList({ refreshTrigger, onJobSelected }: Props) {
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<JobFilter>('all')

  const loadJobs = async () => {
    try {
      const jobList = await mcpClient.listJobs()
      setJobs(
        jobList.sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        )
      )
    } catch (err) {
      console.error('Failed to load jobs:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadJobs()
  }, [refreshTrigger])

  useEffect(() => {
    const interval = setInterval(loadJobs, 5000)
    return () => clearInterval(interval)
  }, [])

  const counts = useMemo(() => {
    return jobs.reduce(
      (acc, job) => {
        acc.all += 1
        acc[job.status] += 1
        return acc
      },
      { all: 0, created: 0, running: 0, completed: 0, failed: 0 } as Record<JobFilter, number>
    )
  }, [jobs])

  const filteredJobs = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return jobs.filter((job) => {
      if (filter !== 'all' && job.status !== filter) return false
      if (!normalizedQuery) return true
      const haystack = `${job.job_name || ''} ${job.job_id} ${job.status}`.toLowerCase()
      return haystack.includes(normalizedQuery)
    })
  }, [filter, jobs, query])

  const handleJobClick = (job: Job) => {
    setSelectedJobId(job.job_id)
    onJobSelected(job)
  }

  const handleDelete = async (jobId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (confirm('Are you sure you want to delete this job?')) {
      try {
        await mcpClient.deleteJob(jobId)
        await loadJobs()
        if (selectedJobId === jobId) {
          setSelectedJobId(null)
        }
      } catch (err) {
        console.error('Failed to delete job:', err)
      }
    }
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed':
        return 'bg-emerald-400/10 text-emerald-200 border border-emerald-400/20'
      case 'running':
        return 'bg-sky-400/10 text-sky-200 border border-sky-400/20'
      case 'failed':
        return 'bg-rose-400/10 text-rose-200 border border-rose-400/20'
      default:
        return 'bg-slate-400/10 text-slate-200 border border-slate-400/20'
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[240px] items-center justify-center rounded-2xl border border-white/10 bg-slate-950/30">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-cyan-400" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="sm:col-span-2">
          <span className="mb-2 block text-xs font-medium uppercase tracking-wide text-slate-400">
            Search jobs
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by name, id, or status"
            className="w-full rounded-xl border border-white/10 bg-slate-950/50 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-cyan-400/50 focus:ring-2 focus:ring-cyan-400/20"
          />
        </label>
        <div className="sm:col-span-2 flex flex-wrap gap-2">
          {filterOptions.map((option) => (
            <button
              key={option.key}
              onClick={() => setFilter(option.key)}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                filter === option.key
                  ? 'bg-cyan-400 text-slate-950'
                  : 'bg-white/5 text-slate-300 hover:bg-white/10'
              }`}
            >
              {option.label} ({counts[option.key]})
            </button>
          ))}
        </div>
      </div>

      {jobs.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 bg-slate-950/30 px-4 py-10 text-center text-sm text-slate-400">
          No jobs yet. Create one to get started.
        </div>
      ) : filteredJobs.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 bg-slate-950/30 px-4 py-10 text-center text-sm text-slate-400">
          No jobs match the current filters.
        </div>
      ) : (
        <div className="space-y-3 max-h-[calc(100vh-280px)] overflow-y-auto pr-1">
          {filteredJobs.map((job) => (
            <div
              key={job.job_id}
              onClick={() => handleJobClick(job)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  handleJobClick(job)
                }
                if (event.key === 'Escape' && selectedJobId === job.job_id) {
                  event.preventDefault()
                  setSelectedJobId(null)
                }
              }}
              role="button"
              tabIndex={0}
              data-testid={`job-card-${job.job_id}`}
              className={`w-full rounded-2xl border p-4 text-left transition-all duration-200 ${
                selectedJobId === job.job_id
                  ? 'border-cyan-400/50 bg-cyan-400/10 shadow-lg shadow-cyan-950/10'
                  : 'border-white/10 bg-slate-950/40 hover:border-cyan-400/30 hover:bg-slate-900/80'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-sm font-semibold text-white">
                      {job.job_name || job.job_id}
                    </h3>
                    <span className={`rounded-full px-2 py-1 text-[11px] font-semibold ${getStatusColor(job.status)}`}>
                      {job.status}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-400">{new Date(job.created_at).toLocaleString()}</p>
                  <p className="mt-2 truncate text-xs text-slate-500">{job.job_id}</p>
                </div>
                <button
                  onClick={(e) => handleDelete(job.job_id, e)}
                  aria-label={`Delete job ${job.job_name || job.job_id}`}
                  className="rounded-lg border border-rose-400/20 bg-rose-400/10 px-2.5 py-1 text-xs font-medium text-rose-200 transition hover:bg-rose-400/20"
                >
                  Delete
                </button>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-2 text-xs text-slate-300">
                {Object.entries(job.progress).map(([step, status]) => (
                  <div key={step} className="rounded-xl bg-white/5 px-3 py-2">
                    <div className="capitalize text-slate-400">{step.replace(/_/g, ' ')}</div>
                    <div
                      className={`mt-1 font-medium ${
                        status === 'completed'
                          ? 'text-emerald-300'
                          : status === 'running'
                            ? 'text-sky-300'
                            : status.startsWith('error')
                              ? 'text-rose-300'
                              : 'text-slate-300'
                      }`}
                    >
                      {status}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
