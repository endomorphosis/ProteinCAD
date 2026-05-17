import { Job, ServiceStatus, ProteinSequenceInput } from './types'

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { cache: 'no-store' })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

async function sendJson<T>(path: string, method: 'POST' | 'DELETE', body?: any): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

// AlphaFold settings interface
export interface AlphaFoldSettings {
  speed_preset?: string
  disable_templates?: boolean
  num_recycles?: number
  num_ensemble?: number
  mmseqs2_max_seqs?: number
  msa_mode?: string
}

class MCPClient {
  // MCP Protocol methods
  async listTools() {
    return getJson('/api/mcp/tools')
  }

  async listResources() {
    return getJson('/api/mcp/resources')
  }

  async readResource(uri: string) {
    return sendJson('/api/mcp/resources/read', 'POST', { uri })
  }

  async getResource(jobId: string) {
    return this.readResource(`job://${jobId}`)
  }

  // Job management methods (implemented via MCP tools)
  async createJob(input: ProteinSequenceInput): Promise<Job> {
    return sendJson<Job>('/api/mcp/jobs', 'POST', input)
  }

  async listJobs(): Promise<Job[]> {
    return getJson<Job[]>('/api/mcp/jobs')
  }

  async getJob(jobId: string): Promise<Job> {
    return sendJson<Job>('/api/mcp/jobs/status', 'POST', { job_id: jobId })
  }

  async deleteJob(jobId: string): Promise<void> {
    await sendJson('/api/mcp/jobs', 'DELETE', { job_id: jobId })
  }

  async getServiceStatus(): Promise<ServiceStatus> {
    return getJson<ServiceStatus>('/api/mcp/services/status')
  }

  // AlphaFold settings methods
  async getAlphaFoldSettings(): Promise<AlphaFoldSettings> {
    return getJson<AlphaFoldSettings>('/api/alphafold/settings')
  }

  async updateAlphaFoldSettings(settings: AlphaFoldSettings): Promise<any> {
    return sendJson('/api/alphafold/settings', 'POST', settings)
  }

  async resetAlphaFoldSettings(): Promise<any> {
    return sendJson('/api/alphafold/settings/reset', 'POST')
  }

}


const client = new MCPClient()
export const mcpClient = client
export default client
