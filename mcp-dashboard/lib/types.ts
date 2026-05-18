export interface Job {
  job_id: string
  status: 'created' | 'running' | 'completed' | 'failed'
  created_at: string
  updated_at: string
  job_name?: string
  input?: {
    sequence?: string
    num_designs?: number
    ground_with_blast_evidence?: boolean
    retrieval?: {
      program?: string
      database?: string
      hitlist_size?: number
    }
  }
  retrieval?: {
    requested?: boolean
    enabled?: boolean
    status?: 'not_requested' | 'queued' | 'running' | 'completed' | 'cached' | 'failed' | 'disabled'
    message?: string
    started_at?: string | null
    completed_at?: string | null
    request_id?: string | null
    cached?: boolean | null
    hit_count?: number
    evidence_count?: number
    error?: string | null
    result?: RetrievalBundle | null
  }
  progress: {
    alphafold: string
    rfdiffusion: string
    proteinmpnn: string
    alphafold_multimer: string
  }
  results?: {
    target_structure: any
    designs: Design[]
  }
  error?: string
}

export interface Design {
  design_id: number
  backbone: any
  sequence: any
  complex_structure: any
}

export interface ServiceStatus {
  [service: string]: {
    status: string
    url: string
    error?: string
    reason?: string
    http_status?: number
    backend?: string
    selected_provider?: string
  }
}

export interface ProteinSequenceInput {
  sequence: string
  job_name?: string
  num_designs: number
  ground_with_blast_evidence?: boolean
  retrieval_program?: string
  retrieval_database?: string
  retrieval_hitlist_size?: number
}

export interface RetrievalBundle {
  request_id?: string
  run_id?: string | null
  cache_key?: string | null
  provider?: string | null
  cached?: boolean
  status?: string
  hit_count?: number
  evidence_count?: number
  top_hits?: Array<{
    hit_rank?: number
    accession?: string
    title?: string
    organism?: string
    bit_score?: number
    e_value?: number
    identity_fraction?: number
    query_coverage?: number
  }>
  evidence_summary?: {
    document_count?: number
    packet?: {
      documents?: Array<{
        evidence_id?: string
        hit_rank?: number
        title?: string
        content_text?: string
        source_system?: string
        source_id?: string
        retrieved_at?: string
      }>
    }
  }
  manifest_refs?: Array<{
    manifest_id: string
    uri?: string
  }>
  provenance?: {
    sources?: string[]
    transform_versions?: string[]
    latest_retrieved_at?: string | null
  }
  result?: any
}
export interface AlphaFoldSettings {
  speed_preset?: 'fast' | 'balanced' | 'quality'
  disable_templates?: boolean
  num_recycles?: number
  num_ensemble?: number
  mmseqs2_max_seqs?: number
  msa_mode?: 'jackhmmer' | 'mmseqs2'
}
