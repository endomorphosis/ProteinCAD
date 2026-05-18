import { test, expect } from '@playwright/test'
import { installMockEventSource, jsonRoute } from './helpers/mocks'

function isoNow() {
  return new Date().toISOString()
}

test.describe('Jobs flow', () => {
  test.beforeEach(async ({ page }) => {
    await installMockEventSource(page)
  })

  test('create a job and see it in the list + results placeholder', async ({ page }) => {
    const jobs: any[] = []
    let createdPayload: any = null

    page.on('dialog', async (dialog) => {
      await dialog.accept()
    })

    await page.route('**/api/mcp/services/status', async (route) => {
      await jsonRoute(route, { alphafold: { status: 'ready', url: 'x' } })
    })

    await page.route('**/api/mcp/jobs', async (route) => {
      const method = route.request().method()
      if (method === 'GET') {
        await jsonRoute(route, jobs)
        return
      }

      if (method === 'POST') {
        const body = route.request().postDataJSON() as any
        createdPayload = body
        const job = {
          job_id: 'job_20250101_000000_0',
          status: 'created',
          created_at: isoNow(),
          updated_at: isoNow(),
          job_name: body?.job_name || undefined,
          progress: {
            alphafold: 'pending',
            rfdiffusion: 'pending',
            proteinmpnn: 'pending',
            alphafold_multimer: 'pending',
          },
          results: null,
          error: null,
        }
        jobs.unshift(job)
        await jsonRoute(route, job)
        return
      }

      if (method === 'DELETE') {
        const body = route.request().postDataJSON() as any
        const idx = jobs.findIndex((j) => j.job_id === body?.job_id)
        if (idx >= 0) jobs.splice(idx, 1)
        await jsonRoute(route, { deleted: body?.job_id })
        return
      }

      await route.fallback()
    })

    await page.goto('/')

    await page.getByLabel(/Target Protein Sequence/i).fill('MKTAYIAKQRQISFVKSHFSRQ')
    await page.getByLabel(/Job Name/i).fill('e2e job')
    await page.getByLabel(/Number of Designs/i).fill('3')
    await page.getByLabel('Ground with BLAST evidence (opt-in)').click()
    await page.getByLabel('Program').fill('blastp')
    await page.getByLabel('Database').fill('swissprot')
    await page.getByLabel('Hitlist size').fill('10')

    await page.getByRole('button', { name: /Start Design Job/i }).click()
    expect(createdPayload?.ground_with_blast_evidence).toBe(true)
    expect(createdPayload?.retrieval_program).toBe('blastp')
    expect(createdPayload?.retrieval_database).toBe('swissprot')
    expect(createdPayload?.retrieval_hitlist_size).toBe(10)

    const jobCard = page.getByTestId('job-card-job_20250101_000000_0')
    await expect(jobCard).toBeVisible()
    await jobCard.click()

    await expect(page.getByText(/Job is created/i)).toBeVisible()

    await jobCard.getByRole('button', { name: 'Delete job e2e job' }).click()
    await expect(jobCard).toBeHidden()
  })

  test('shows BLAST retrieval badge on grounded jobs', async ({ page }) => {
    const jobs = [
      {
        job_id: 'job_grounded_0',
        status: 'running',
        created_at: isoNow(),
        updated_at: isoNow(),
        job_name: 'grounded job',
        input: {
          sequence: 'MKTAYIAKQRQISFVKSHFSRQ',
          num_designs: 3,
          ground_with_blast_evidence: true,
        },
        retrieval: {
          requested: true,
          status: 'cached',
          cached: true,
          hit_count: 2,
        },
        progress: {
          alphafold: 'running',
          rfdiffusion: 'pending',
          proteinmpnn: 'pending',
          alphafold_multimer: 'pending',
        },
        results: null,
        error: null,
      },
    ]

    await page.route('**/api/mcp/services/status', async (route) => {
      await jsonRoute(route, { alphafold: { status: 'ready', url: 'x' } })
    })
    await page.route('**/api/mcp/jobs', async (route) => {
      if (route.request().method() === 'GET') {
        await jsonRoute(route, jobs)
        return
      }
      await route.fallback()
    })

    await page.goto('/')
    const card = page.getByTestId('job-card-job_grounded_0')
    await expect(card).toBeVisible()
    await expect(card.getByText('BLAST cached')).toBeVisible()
    await expect(card.getByText('2 hits')).toBeVisible()
    await expect(card.getByText('cache hit')).toBeVisible()
  })
})
