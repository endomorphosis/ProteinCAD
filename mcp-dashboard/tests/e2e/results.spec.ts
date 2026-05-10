import { test, expect, type Page } from '@playwright/test'
import { examplePdb, installMockEventSource, jsonRoute } from './helpers/mocks'

const analysisPdb = `ATOM      1  N   ALA A   1      10.000  12.000   2.100  1.00 12.00           N
ATOM      2  CA  ALA A   1      11.400  12.400   2.100  1.00 12.00           C
ATOM      3  N   GLY A   2      12.700  13.200   2.100  1.00 18.00           N
ATOM      4  CA  GLY A   2      13.900  14.000   2.100  1.00 18.00           C
ATOM      5  N   SER B   9      17.500  16.200   2.100  1.00 65.00           N
ATOM      6  CA  SER B   9      18.900  16.700   2.100  1.00 65.00           C
ATOM      7  N   TYR B  10      20.300  17.500   2.100  1.00 72.00           N
ATOM      8  CA  TYR B  10      21.700  18.100   2.100  1.00 72.00           C
TER
END
`

function makeCompletedJob() {
  return {
    job_id: 'job_completed_0',
    status: 'completed',
    created_at: new Date(Date.now() - 60_000).toISOString(),
    updated_at: new Date().toISOString(),
    job_name: 'Completed Job',
    input: { sequence: 'ACDEFGHIKLMNPQRSTVWY', num_designs: 5 },
    progress: {
      alphafold: 'completed',
      rfdiffusion: 'completed',
      proteinmpnn: 'completed',
      alphafold_multimer: 'completed',
    },
    results: {
      target_structure: { pdb: examplePdb },
      designs: [
        {
          design_id: 0,
          backbone: { pdb: examplePdb },
          sequence: { sequence: 'ACDEFGHIKLMNPQRSTVWY' },
          complex_structure: { pdb: examplePdb },
        },
      ],
    },
    error: null,
  }
}

function makeAnalysisJob() {
  return {
    ...makeCompletedJob(),
    input: { sequence: 'ACDEFGHIKLMNPQRSTVWY', num_designs: 5 },
    results: {
      target_structure: { pdb: analysisPdb },
      designs: [
        {
          design_id: 0,
          backbone: { pdb: analysisPdb },
          sequence: { sequence: 'ACDEFGHIKLMNPQRSTVWY' },
          complex_structure: { pdb: analysisPdb },
        },
      ],
    },
  }
}

async function installCompletedJobRoutes(page: Page, job: ReturnType<typeof makeCompletedJob>) {
  await page.route('**/api/mcp/services/status', async (route) => {
    await jsonRoute(route, { alphafold: { status: 'ready', url: 'x' } })
  })

  await page.route('**/api/mcp/jobs', async (route) => {
    if (route.request().method() === 'GET') {
      await jsonRoute(route, [job])
      return
    }
    await route.fallback()
  })
}

async function openCompletedJob(page: Page) {
  await page.getByTestId('job-card-job_completed_0').click()
}

test.describe('Results viewer', () => {
  test.beforeEach(async ({ page }) => {
    await installMockEventSource(page)
    await page.addInitScript(() => {
      let copiedText = ''
      Object.defineProperty(window, '__copiedText', {
        get: () => copiedText,
      })
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: async (text: string) => {
            copiedText = text
          },
        },
        configurable: true,
      })
    })
  })

  test('shows completed results + allows download', async ({ page }) => {
    const job = makeCompletedJob()
    await installCompletedJobRoutes(page, job)

    await page.goto('/')
    await openCompletedJob(page)

    await expect(page.getByText('✓ Completed')).toBeVisible()
    await expect(page.getByText('Target Structure')).toBeVisible()
    await expect(page.getByText(/Generated Designs/i)).toBeVisible()
    await expect(page.getByText(/Binder Sequence/i)).toBeVisible()

    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: /Download All Results/i }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/job_completed_0_results\.json$/)
  })

  test('iterate from a completed job pre-fills the input form', async ({ page }) => {
    const job = makeCompletedJob()
    await installCompletedJobRoutes(page, job)

    await page.goto('/')
    await openCompletedJob(page)

    await page.getByRole('button', { name: 'Iterate From This Job' }).click()

    await expect(page.getByLabel(/Target Protein Sequence/i)).toHaveValue(job.input.sequence)
    await expect(page.getByLabel(/Number of Designs/i)).toHaveValue(String(job.input.num_designs))
  })

  test('3D viewer opens and closes', async ({ page }) => {
    const job = makeCompletedJob()
    await installCompletedJobRoutes(page, job)

    await page.goto('/')
    await openCompletedJob(page)

    await page.getByRole('button', { name: /View Target in 3D/i }).click()
    await expect(page.getByText('🔬 3D Protein Structure Viewer')).toBeVisible()

    await page.getByRole('button', { name: 'Close 3D Viewer' }).click()
    await expect(page.getByText('🔬 3D Protein Structure Viewer')).toBeHidden()
  })

  test('3D viewer can propose sequence variants (mock tool)', async ({ page }) => {
    const job = makeCompletedJob()
    await installCompletedJobRoutes(page, job)

    await page.goto('/')
    await openCompletedJob(page)

    await page.getByRole('button', { name: /View 3D/i }).click()
    await expect(page.getByText('🔬 3D Protein Structure Viewer')).toBeVisible()

    await page.getByLabel('Variant positions').fill('1,2,3')
    await page.getByTestId('propose-variants').click()

    await expect(page.getByText(/Proposed variants/i)).toBeVisible()

    const variantSequenceEl = page.getByTestId('variant-sequence-0')
    await expect(variantSequenceEl).toBeVisible()
    const variantSequence = (await variantSequenceEl.innerText()).trim()
    await page.getByTestId('save-variant-0').evaluate((el: HTMLElement) => el.click())
    await page.getByTestId('iterate-variant-0').evaluate((el: HTMLElement) => el.click())

    await expect(page.getByText('🔬 3D Protein Structure Viewer')).toBeHidden()
    await expect(page.getByLabel(/Target Protein Sequence/i)).toHaveValue(variantSequence)
  })

  test('saving a variant adds it to the Design Library', async ({ page }) => {
    const job = makeCompletedJob()
    await installCompletedJobRoutes(page, job)

    await page.goto('/')
    await openCompletedJob(page)

    await page.getByRole('button', { name: /View 3D/i }).click()
    await expect(page.getByText('🔬 3D Protein Structure Viewer')).toBeVisible()

    await page.getByLabel('Variant positions').fill('1,2,3')
    await page.getByTestId('propose-variants').click()

    const variantSequenceEl = page.getByTestId('variant-sequence-0')
    await expect(variantSequenceEl).toBeVisible()
    const variantSequence = (await variantSequenceEl.innerText()).trim()

    await page.getByTestId('save-variant-0').evaluate((el: HTMLElement) => el.click())
    await page.getByRole('button', { name: 'Close 3D Viewer' }).click()

    const library = page.getByTestId('design-library')
    await expect(library).toBeVisible()
    await expect(library.getByText(variantSequence)).toBeVisible()

    await library.getByRole('button', { name: 'View 3D' }).click()
    await expect(page.getByText('🔬 3D Protein Structure Viewer')).toBeVisible()
    await page.getByRole('button', { name: 'Close 3D Viewer' }).click()
    await expect(page.getByText('🔬 3D Protein Structure Viewer')).toBeHidden()
  })

  test('saving a binder design adds it to the Design Library and can reopen 3D', async ({ page }) => {
    const job = makeCompletedJob()
    await installCompletedJobRoutes(page, job)

    await page.goto('/')
    await openCompletedJob(page)

    await page.getByTestId('save-design-0').click()

    const library = page.getByTestId('design-library')
    await expect(library).toBeVisible()

    await library.getByRole('button', { name: 'View 3D' }).click()
    await expect(page.getByText('🔬 3D Protein Structure Viewer')).toBeVisible()

    await page.getByRole('button', { name: 'Close 3D Viewer' }).click()
    await expect(page.getByText('🔬 3D Protein Structure Viewer')).toBeHidden()
  })

  test('3D viewer supports chain filtering and residue focus controls', async ({ page }) => {
    const job = makeCompletedJob()
    await installCompletedJobRoutes(page, job)

    await page.goto('/')
    await openCompletedJob(page)

    await page.getByRole('button', { name: /View Target in 3D/i }).click()
    await expect(page.getByText('🔬 3D Protein Structure Viewer')).toBeVisible()

    await page.getByTestId('viewer-chain-filter').selectOption('A')
    await page.getByTestId('viewer-focus-residue').fill('A:2')
    await page.getByTestId('viewer-focus-button').click()

    const modalBox = await page.getByTestId('viewer-modal').boundingBox()
    expect(modalBox?.width || 0).toBeGreaterThan((page.viewportSize()?.width || 0) * 0.75)
    await expect(page.getByText(/Focused on residue A:2/i)).toBeVisible()
    await expect(page.getByText('A:2 GLY ×')).toBeVisible()
    await expect(page.getByTestId('viewer-inspector-primary')).toHaveText('A:2 GLY')
    await expect(page.getByTestId('viewer-selected-atom-count')).toHaveText('2')
    await expect(page.getByTestId('viewer-selected-sequence-residue')).toHaveText(job.input.sequence[1])

    await page.getByTestId('viewer-focus-selection').click()
    await expect(page.getByText(/Centered 1 selected residue/i)).toBeVisible()
    await page.getByTestId('viewer-auto-rotate').click()
    await expect(page.getByTestId('viewer-auto-rotate')).toHaveText(/Auto-rotate on/i)

    const downloadPromise = page.waitForEvent('download')
    await page.getByTestId('viewer-snapshot').click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/\.png$/)

    await page.getByRole('button', { name: 'Close 3D Viewer' }).click()
    await expect(page.getByText('🔬 3D Protein Structure Viewer')).toBeHidden()
  })

  test('3D viewer surfaces chain summaries and hotspot analysis actions', async ({ page }) => {
    const job = makeAnalysisJob()
    await installCompletedJobRoutes(page, job)

    await page.goto('/')
    await openCompletedJob(page)

    await page.getByRole('button', { name: /View Target in 3D/i }).click()
    await expect(page.getByText('🔬 3D Protein Structure Viewer')).toBeVisible()

    await expect(page.getByTestId('viewer-chain-card-A')).toBeVisible()
    await expect(page.getByTestId('viewer-chain-card-B')).toBeVisible()

    await page.getByTestId('viewer-chain-hotspots-B').click()
    await expect(page.getByTestId('viewer-chain-filter')).toHaveValue('B')
    await expect(page.getByTestId('variant-positions')).toHaveValue('9,10')
    await expect(page.getByText(/Selected 2 high B-factor hotspots in chain B/i)).toBeVisible()

    await page.getByTestId('viewer-copy-positions').click()
    await expect(page.getByText(/Copied variant positions 9,10/i)).toBeVisible()
    await expect.poll(async () => page.evaluate(() => (window as any).__copiedText)).toBe('9,10')

    await page.getByTestId('viewer-chain-solo-B').click()
    await expect(page.getByTestId('viewer-chain-filter')).toHaveValue('all')
  })
})
