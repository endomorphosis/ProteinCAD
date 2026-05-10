function defaultBaseUrl() {
  const base =
    process.env.MCP_SERVER_URL ||
    process.env.NEXT_PUBLIC_MCP_SERVER_URL ||
    'http://localhost:8010'

  return String(base).replace(/\/$/, '')
}

let FALLBACK_RPC_COUNTER = 0

function rpcPayload(method, params) {
  return {
    jsonrpc: '2.0',
    id:
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${method}-${Date.now()}-${FALLBACK_RPC_COUNTER++}`,
    method,
    params,
  }
}

async function postJsonRpc(endpoint, payload) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    cache: 'no-store',
  })

  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    throw new Error(`Invalid JSON-RPC response: ${text.slice(0, 200)}`)
  }

  if (!response.ok) {
    throw new Error(data?.error?.message || data?.detail || `HTTP ${response.status} from MCP server`)
  }

  if (data?.error) {
    throw new Error(data.error.message || 'MCP JSON-RPC error')
  }

  return data?.result ?? data
}

export class HttpJsonRpcTransport {
  onclose
  onerror
  onmessage
  #endpoint
  #closed = false

  constructor(endpoint) {
    this.#endpoint = endpoint
  }

  async start() {}

  async close() {
    this.#closed = true
    this.onclose?.()
  }

  async send(message) {
    if (this.#closed) return
    try {
      const result = await postJsonRpc(this.#endpoint, message)
      this.onmessage?.(result)
      return result
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      this.onerror?.(error)
      throw error
    }
  }
}

export function extractFirstTextContent(result) {
  if (!result) return ''

  const content = result.content
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item) continue
      const text = item.text
      if (typeof text === 'string' && text.trim()) return text
    }
  }

  const msg = result.message
  if (typeof msg === 'string') return msg

  try {
    return JSON.stringify(result)
  } catch {
    return String(result)
  }
}

export function tryParseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function createMcpClient(options) {
  const baseUrl = (options?.baseUrl || defaultBaseUrl()).replace(/\/$/, '')
  const endpoint = `${baseUrl}/mcp`

  return {
    async listTools() {
      return postJsonRpc(endpoint, rpcPayload('tools/list', {}))
    },
    async listResources() {
      return postJsonRpc(endpoint, rpcPayload('resources/list', {}))
    },
    async readResource({ uri }) {
      return postJsonRpc(endpoint, rpcPayload('resources/read', { uri }))
    },
    async callTool({ name, arguments: args }) {
      return postJsonRpc(endpoint, rpcPayload('tools/call', { name, arguments: args || {} }))
    },
  }
}

export async function withMcpClient(options, fn) {
  const client = createMcpClient(options)
  return fn(client)
}

export class McpProteinDesignClient {
  constructor(options) {
    this.options = options || {}
  }

  async listTools() {
    return withMcpClient(this.options, (client) => client.listTools())
  }

  async listResources() {
    return withMcpClient(this.options, (client) => client.listResources())
  }

  async readResource(uri) {
    return withMcpClient(this.options, (client) => client.readResource({ uri }))
  }

  async callTool(name, args) {
    return withMcpClient(this.options, (client) => client.callTool({ name, arguments: args || {} }))
  }

  async callToolJson(name, args) {
    const raw = await this.callTool(name, args)
    const text = extractFirstTextContent(raw)
    const parsed = text ? tryParseJson(text) : null
    return { raw, text, json: parsed }
  }

  async checkServices() {
    return this.callToolJson('check_services', {})
  }

  async listJobs() {
    return this.callToolJson('list_jobs', {})
  }

  async designProteinBinder(input) {
    return this.callToolJson('design_protein_binder', input || {})
  }

  async getJobStatus(jobId) {
    return this.callToolJson('get_job_status', { job_id: jobId })
  }

  async deleteJob(jobId) {
    return this.callToolJson('delete_job', { job_id: jobId })
  }

  async getRuntimeConfig() {
    return this.callToolJson('get_runtime_config', {})
  }

  async updateRuntimeConfig(patch) {
    return this.callToolJson('update_runtime_config', { patch: patch || {} })
  }

  async resetRuntimeConfig() {
    return this.callToolJson('reset_runtime_config', {})
  }

  async embeddedBootstrap(models) {
    return this.callToolJson('embedded_bootstrap', { models: Array.isArray(models) ? models : [] })
  }

  async getAlphaFoldSettings() {
    return this.callToolJson('get_alphafold_settings', {})
  }

  async updateAlphaFoldSettings(settings) {
    return this.callToolJson('update_alphafold_settings', settings || {})
  }

  async resetAlphaFoldSettings() {
    return this.callToolJson('reset_alphafold_settings', {})
  }
}
