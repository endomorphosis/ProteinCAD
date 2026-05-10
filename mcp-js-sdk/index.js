import { Client } from '@modelcontextprotocol/sdk/dist/client/index.js'

function defaultBaseUrl() {
  const base =
    process.env.MCP_SERVER_URL ||
    process.env.NEXT_PUBLIC_MCP_SERVER_URL ||
    'http://localhost:8010'

  return String(base).replace(/\/$/, '')
}

/**
 * Minimal HTTP JSON-RPC transport for MCP servers exposing POST /mcp.
 *
 * This is request/response only (no streaming).
 */
export class HttpJsonRpcTransport {
  /** @type {(() => void) | undefined} */
  onclose
  /** @type {((error: Error) => void) | undefined} */
  onerror
  /** @type {((message: any) => void) | undefined} */
  onmessage

  /** @type {string} */
  #endpoint
  /** @type {boolean} */
  #closed = false

  /** @param {string} endpoint */
  constructor(endpoint) {
    this.#endpoint = endpoint
  }

  async start() {
    // no-op
  }

  async close() {
    this.#closed = true
    this.onclose?.()
  }

  /** @param {any} message */
  async send(message) {
    if (this.#closed) return

    try {
      const res = await fetch(this.#endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
        cache: 'no-store',
      })

      const text = await res.text()
      /** @type {any} */
      let payload = null
      try {
        payload = text ? JSON.parse(text) : null
      } catch {
        throw new Error(`Invalid JSON-RPC response: ${text.slice(0, 200)}`)
      }

      if (!res.ok) {
        const msg =
          payload?.error?.message ||
          payload?.detail ||
          `HTTP ${res.status} from MCP server`
        throw new Error(msg)
      }

      if (payload && this.onmessage) {
        this.onmessage(payload)
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      this.onerror?.(error)
      throw error
    }
  }
}

/** @param {any} result */
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

/**
 * @param {string} text
 * @returns {any | null}
 */
export function tryParseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * @template T
 * @param {{ baseUrl?: string, clientName?: string, clientVersion?: string }} [options]
 * @param {(client: import('@modelcontextprotocol/sdk/dist/client/index.js').Client) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withMcpClient(options, fn) {
  const baseUrl = (options?.baseUrl || defaultBaseUrl()).replace(/\/$/, '')
  const transport = new HttpJsonRpcTransport(`${baseUrl}/mcp`)
  const client = new Client(
    {
      name: options?.clientName || 'mcp-js-sdk',
      version: options?.clientVersion || '0.1.0',
    },
    { capabilities: {} }
  )

  await client.connect(transport)
  try {
    return await fn(client)
  } finally {
    await transport.close()
  }
}

export class McpProteinDesignClient {
  /**
   * @param {{ baseUrl?: string, clientName?: string, clientVersion?: string }} [options]
   */
  constructor(options) {
    this.options = options || {}
  }

  async listTools() {
    return withMcpClient(this.options, (client) => client.listTools())
  }

  async listResources() {
    return withMcpClient(this.options, (client) => client.listResources())
  }

  /** @param {string} uri */
  async readResource(uri) {
    return withMcpClient(this.options, (client) => client.readResource({ uri }))
  }

  /** @param {string} name @param {Record<string, any>} args */
  async callTool(name, args) {
    return withMcpClient(this.options, (client) => client.callTool({ name, arguments: args || {} }))
  }

  /** @param {string} name @param {Record<string, any>} args */
  async callToolJson(name, args) {
    const raw = await this.callTool(name, args)
    const text = extractFirstTextContent(raw)
    const parsed = text ? tryParseJson(text) : null
    return { raw, text, json: parsed }
  }

  // High-level convenience wrappers
  async checkServices() {
    return this.callToolJson('check_services', {})
  }

  async listJobs() {
    return this.callToolJson('list_jobs', {})
  }

  /** @param {{ sequence: string, job_name?: string, num_designs?: number }} input */
  async designProteinBinder(input) {
    return this.callToolJson('design_protein_binder', input || {})
  }

  /** @param {string} jobId */
  async getJobStatus(jobId) {
    return this.callToolJson('get_job_status', { job_id: jobId })
  }

  /** @param {string} jobId */
  async deleteJob(jobId) {
    return this.callToolJson('delete_job', { job_id: jobId })
  }

  async getRuntimeConfig() {
    return this.callToolJson('get_runtime_config', {})
  }

  /** @param {any} patch */
  async updateRuntimeConfig(patch) {
    return this.callToolJson('update_runtime_config', { patch: patch || {} })
  }

  async resetRuntimeConfig() {
    return this.callToolJson('reset_runtime_config', {})
  }

  /** @param {string[]} models */
  async embeddedBootstrap(models) {
    return this.callToolJson('embedded_bootstrap', { models: Array.isArray(models) ? models : [] })
  }

  async getAlphaFoldSettings() {
    return this.callToolJson('get_alphafold_settings', {})
  }

  /** @param {Record<string, any>} settings */
  async updateAlphaFoldSettings(settings) {
    return this.callToolJson('update_alphafold_settings', settings || {})
  }

  async resetAlphaFoldSettings() {
    return this.callToolJson('reset_alphafold_settings', {})
  }
}
