export type BasicMcpClient = {
  listTools(): Promise<any>
  listResources(): Promise<any>
  readResource(input: { uri: string }): Promise<any>
  callTool(input: { name: string; arguments?: Record<string, any> }): Promise<any>
}

export declare class HttpJsonRpcTransport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: any) => void
  constructor(endpoint: string)
  start(): Promise<void>
  close(): Promise<void>
  send(message: any): Promise<any>
}

export declare function extractFirstTextContent(result: any): string
export declare function tryParseJson(text: string): any | null

export declare function withMcpClient<T>(
  options: { baseUrl?: string; clientName?: string; clientVersion?: string } | undefined,
  fn: (client: BasicMcpClient) => Promise<T>
): Promise<T>

export declare class McpProteinDesignClient {
  constructor(options?: { baseUrl?: string; clientName?: string; clientVersion?: string })

  listTools(): Promise<any>
  listResources(): Promise<any>
  readResource(uri: string): Promise<any>
  callTool(name: string, args: Record<string, any>): Promise<any>

  callToolJson(
    name: string,
    args: Record<string, any>
  ): Promise<{ raw: any; text: string; json: any | null }>

  checkServices(): Promise<{ raw: any; text: string; json: any | null }>
  listJobs(): Promise<{ raw: any; text: string; json: any | null }>
  designProteinBinder(input: {
    sequence: string
    job_name?: string
    num_designs?: number
  }): Promise<{ raw: any; text: string; json: any | null }>

  getJobStatus(jobId: string): Promise<{ raw: any; text: string; json: any | null }>
  deleteJob(jobId: string): Promise<{ raw: any; text: string; json: any | null }>

  getRuntimeConfig(): Promise<{ raw: any; text: string; json: any | null }>
  updateRuntimeConfig(patch: any): Promise<{ raw: any; text: string; json: any | null }>
  resetRuntimeConfig(): Promise<{ raw: any; text: string; json: any | null }>

  embeddedBootstrap(models: string[]): Promise<{ raw: any; text: string; json: any | null }>

  getAlphaFoldSettings(): Promise<{ raw: any; text: string; json: any | null }>
  updateAlphaFoldSettings(settings: Record<string, any>): Promise<{ raw: any; text: string; json: any | null }>
  resetAlphaFoldSettings(): Promise<{ raw: any; text: string; json: any | null }>
}
