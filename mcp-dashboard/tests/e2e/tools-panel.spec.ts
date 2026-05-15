import { test, expect } from '@playwright/test'
import { installMockEventSource, jsonRoute } from './helpers/mocks'

const toolsPayload = {
  tools: [
    {
      name: 'check_services',
      description: 'Check backend services',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'list_jobs',
      description: 'List jobs',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'predict_structure',
      description: 'Predict structure',
      inputSchema: {
        type: 'object',
        properties: { sequence: { type: 'string', description: 'Protein sequence' } },
        required: ['sequence'],
      },
    },
  ],
}

function toolResult(textObj: any) {
  return {
    content: [{ type: 'text', text: JSON.stringify(textObj) }],
    isError: false,
  }
}

test.describe('MCP Tools panel', () => {
  test.beforeEach(async ({ page }) => {
    await installMockEventSource(page)

    await page.route('**/api/mcp/services/status', async (route) => {
      await jsonRoute(route, { alphafold: { status: 'ready', url: 'x' } })
    })

    await page.route('**/api/mcp/jobs', async (route) => {
      if (route.request().method() === 'GET') {
        await jsonRoute(route, [])
        return
      }
      await route.fallback()
    })

    await page.route('**/api/mcp/tools', async (route) => {
      await jsonRoute(route, toolsPayload)
    })

    await page.route('**/api/mcp/tools/call', async (route) => {
      const body = route.request().postDataJSON() as any
      const name = body?.name

      if (name === 'check_services') {
        await jsonRoute(route, toolResult({ alphafold: { status: 'ready', url: 'http://x' } }))
        return
      }

      if (name === 'list_jobs') {
        await jsonRoute(
          route,
          toolResult([
            {
              job_id: 'job_1',
              status: 'running',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              job_name: 'Job One',
              progress: {
                alphafold: 'running',
                rfdiffusion: 'pending',
                proteinmpnn: 'pending',
                alphafold_multimer: 'pending',
              },
            },
          ])
        )
        return
      }

      if (name === 'predict_structure') {
        const seq = body?.arguments?.sequence || ''
        await jsonRoute(route, toolResult({ pdb: 'mock', sequence: seq, backend: 'test' }))
        return
      }

      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'unknown tool' }) })
    })
  })

  test('quick actions render pretty results', async ({ page }) => {
    await page.goto('/')

    await expect(page.getByRole('heading', { name: 'MCP Tools' })).toBeVisible()

    await page.getByRole('button', { name: 'Check Services' }).click()
    const servicesTable = page.getByRole('table')
    await expect(servicesTable).toBeVisible()
    await expect(servicesTable.getByText('alphafold', { exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'List Jobs' }).click()
    await expect(page.getByText(/Jobs \(1\)/)).toBeVisible()
    await expect(page.getByText('Job One', { exact: true })).toBeVisible()
  })

  test('manual tool call works with arguments', async ({ page }) => {
    await page.goto('/')

    await page.getByText('Advanced manual tool call').click()
    await page.getByLabel('Tool').selectOption('predict_structure')
    await page.getByLabel('sequence *', { exact: true }).fill('ACDE')

    await page.getByRole('button', { name: 'Run Tool' }).click()

    await expect(page.getByText('Raw Result')).toBeVisible()
    await expect(page.getByText(/"sequence":\s*"ACDE"/)).toBeVisible()
  })
})
