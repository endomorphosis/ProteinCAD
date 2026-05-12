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

// Allow a 1px tolerance because browser layout rounding can vary slightly at mobile widths.
const VIEWPORT_LAYOUT_TOLERANCE_PX = 1

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

async function revealHoverSpotlight(page: Page) {
  const canvas = page.locator('canvas').first()
  await expect(canvas).toBeVisible()
  const box = await canvas.boundingBox()
  if (!box) {
    throw new Error('3D canvas was not available for hover interaction')
  }

  const hoverSpotlight = page.getByTestId('viewer-hover-spotlight')
  const xSteps = [0.35, 0.5, 0.65, 0.42, 0.58]
  const ySteps = [0.28, 0.4, 0.5, 0.62]

  for (const xFactor of xSteps) {
    for (const yFactor of ySteps) {
      await page.mouse.move(box.x + box.width * xFactor, box.y + box.height * yFactor, { steps: 8 })
      await page.waitForTimeout(80)
      if (await hoverSpotlight.isVisible()) {
        return
      }
    }
  }

  throw new Error('Unable to reveal hover spotlight in the 3D viewer')
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
    await expect(page.getByTestId('target-structure-atoms')).toHaveText('6')
    await expect(page.getByTestId('target-structure-residues')).toHaveText('2')
    await expect(page.getByTestId('target-structure-chains')).toHaveText('A')
    await expect(page.getByTestId('target-structure-ca')).toHaveText('2/2')

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
    await expect(page.getByTestId('viewer-variant-spotlight')).toBeVisible()

    const variantSequenceEl = page.getByTestId('variant-sequence-0')
    await expect(variantSequenceEl).toBeVisible()
    const variantSequence = (await variantSequenceEl.innerText()).trim()
    await expect(page.getByTestId('viewer-variant-spotlight-sequence-0')).toHaveText(variantSequence)
    await page.getByTestId('viewer-variant-spotlight-iterate-0').click()

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

    await page.getByTestId('viewer-variant-spotlight-save-0').click()
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

  test('results cards surface structure summaries and copy sequence actions', async ({ page }) => {
    const job = makeCompletedJob()
    await installCompletedJobRoutes(page, job)

    await page.goto('/')
    await openCompletedJob(page)

    await expect(page.getByTestId('design-structure-atoms-0')).toHaveText('6')
    await expect(page.getByTestId('design-structure-residues-0')).toHaveText('2')
    await expect(page.getByTestId('design-structure-chains-0')).toHaveText('A')
    await expect(page.getByTestId('design-structure-ca-0')).toHaveText('2/2')

    await page.getByTestId('copy-design-sequence-0').click()
    await expect.poll(async () => page.evaluate(() => (window as any).__copiedText)).toBe(job.input.sequence)

    await page.getByTestId('save-design-0').click()
    await page.getByTestId(/^library-copy-sequence-/).click()
    await expect.poll(async () => page.evaluate(() => (window as any).__copiedText)).toBe(job.input.sequence)
  })

  test('results workspace keeps the design library readable on desktop widths', async ({ page }) => {
    const job = makeCompletedJob()
    await installCompletedJobRoutes(page, job)
    await page.setViewportSize({ width: 1440, height: 1400 })

    await page.goto('/')
    await openCompletedJob(page)

    await page.getByTestId('save-design-0').click()

    const libraryBox = await page.getByTestId('design-library').boundingBox()
    expect(libraryBox?.width || 0).toBeGreaterThan(300)

    await expect(page.getByTestId('design-spotlight-0')).toBeVisible()
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
    await page.getByTestId('viewer-focus-residue').press('Enter')

    const modalBox = await page.getByTestId('viewer-modal').boundingBox()
    expect(modalBox?.width || 0).toBeGreaterThan((page.viewportSize()?.width || 0) * 0.75)
    await expect(page.getByText(/Focused on residue A:2/i)).toBeVisible()
    await expect(page.getByText('A:2 GLY ×')).toBeVisible()
    await expect(page.getByTestId('viewer-inspector-primary')).toHaveText('A:2 GLY')
    await expect(page.getByTestId('viewer-selection-spotlight')).toBeVisible()
    await expect(page.getByTestId('viewer-selection-spotlight-primary')).toHaveText('A:2 GLY')
    await expect(page.getByTestId('viewer-selection-spotlight-atom-count')).toHaveText('2')
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
    await expect(page.getByTestId('viewer-legend-chain-A')).toBeVisible()
    await expect(page.getByTestId('viewer-legend-chain-B')).toBeVisible()

    await page.getByTestId('viewer-legend-chain-B').click()
    await expect(page.getByTestId('viewer-chain-filter')).toHaveValue('B')
    await expect(page.getByText(/Showing only chain B/i)).toBeVisible()
    await expect(page.getByTestId('viewer-legend-chain-B')).toHaveAttribute('aria-pressed', 'true')
    await page.getByTestId('viewer-legend-chain-B').click()
    await expect(page.getByTestId('viewer-chain-filter')).toHaveValue('all')
    await expect(page.getByText(/Showing all chains in the structure/i)).toBeVisible()
    await expect(page.getByTestId('viewer-legend-chain-B')).toHaveAttribute('aria-pressed', 'false')

    await page.getByTestId('viewer-chain-select-B').click()
    await expect(page.getByTestId('variant-positions')).toHaveValue('9,10')
    await expect(page.getByText(/Selected all 2 residues in chain B/i)).toBeVisible()
    await page.getByTestId('viewer-chain-copy-positions-B').click()
    await expect.poll(async () => page.evaluate(() => (window as any).__copiedText)).toBe('9,10')

    await page.getByTestId('viewer-chain-hotspots-B').click()
    await expect(page.getByTestId('viewer-chain-filter')).toHaveValue('B')
    await expect(page.getByTestId('variant-positions')).toHaveValue('9,10')
    await expect(page.getByText(/Selected 2 high B-factor hotspots in chain B/i)).toBeVisible()

    await page.getByTestId('viewer-copy-positions').click()
    await expect(page.getByText(/Copied variant positions 9,10/i)).toBeVisible()
    await expect.poll(async () => page.evaluate(() => (window as any).__copiedText)).toBe('9,10')

    await expect(page.getByTestId('viewer-workflow-summary')).toBeVisible()
    await expect(page.getByTestId('viewer-workflow-positions')).toContainText('9')
    await expect(page.getByTestId('viewer-workflow-positions')).toContainText('10')
    await expect(page.getByTestId('viewer-workflow-chains')).toHaveText('B')
    await expect(page.getByTestId('viewer-workflow-latest')).toHaveText(/B:(9 SER|10 TYR)/)
    await expect(page.getByTestId('viewer-analysis-ribbon')).toBeVisible()
    await expect(page.getByTestId('viewer-analysis-positions')).toContainText('9')
    await expect(page.getByTestId('viewer-analysis-positions')).toContainText('10')
    await expect(page.getByTestId('viewer-analysis-positions-input')).toHaveValue('9,10')
    await expect(page.getByTestId('viewer-analysis-num-variants')).toHaveValue('5')
    await expect(page.getByTestId('viewer-analysis-chip-B-9')).toBeVisible()
    await expect(page.getByTestId('viewer-analysis-chip-B-10')).toBeVisible()
    await expect(page.getByTestId('viewer-selection-spotlight-index')).toHaveText('2 / 2')
    await expect(page.getByTestId('viewer-selection-spotlight-chip-B-9')).toBeVisible()
    await expect(page.getByTestId('viewer-selection-spotlight-chip-B-10')).toBeVisible()
    await page.getByTestId('viewer-selection-spotlight-chip-B-10').click()
    await expect(page.getByTestId('viewer-selection-spotlight-primary')).toHaveText('B:10 TYR')
    await page.getByTestId('viewer-selection-neighbor-radius').fill('2')
    await expect(page.getByTestId('viewer-selection-neighbor-radius-range')).toHaveValue('2')
    await page.getByTestId('viewer-selection-spotlight-nearby').click()
    await expect(page.getByTestId('variant-positions')).toHaveValue('10')
    await expect(page.getByTestId('viewer-selection-spotlight-chip-B-9')).toBeHidden()
    await page.getByTestId('viewer-selection-neighbor-radius-range').fill('4')
    await expect(page.getByTestId('viewer-selection-neighbor-radius')).toHaveValue('4')
    await page.getByTestId('viewer-selection-spotlight-nearby').click()
    await expect(page.getByTestId('variant-positions')).toHaveValue(/9/)
    await expect(page.getByTestId('variant-positions')).toHaveValue(/10/)
    await expect(page.getByTestId('viewer-selection-spotlight-index')).toHaveText('2 / 2')
    await expect(page.getByTestId('viewer-selection-spotlight-index')).toBeVisible()
    const spotlightBeforeCycle = await page.getByTestId('viewer-selection-spotlight-primary').innerText()
    await page.getByTestId('viewer-selection-spotlight-prev').click()
    await expect(page.getByTestId('viewer-selection-spotlight-primary')).not.toHaveText(spotlightBeforeCycle)
    await page.getByTestId('viewer-selection-spotlight-next').click()
    await expect(page.getByTestId('viewer-selection-spotlight-primary')).toHaveText(spotlightBeforeCycle)
    await page.getByTestId('viewer-selection-spotlight-chip-B-9').click()
    await expect(page.getByTestId('viewer-selection-spotlight-primary')).toHaveText('B:9 SER')
    await page.getByTestId('viewer-analysis-chip-B-9').click()
    await expect(page.getByText(/Focused on residue B:9/i)).toBeVisible()
    await page.getByTestId('viewer-analysis-copy').click()
    await expect.poll(async () => page.evaluate(() => (window as any).__copiedText)).toBe('9,10')
    await page.getByTestId('viewer-analysis-copy-residues').click()
    await expect.poll(async () => page.evaluate(() => (window as any).__copiedText)).toMatch(/B:9 SER/)
    await page.getByTestId('viewer-analysis-propose').click()
    await expect(page.getByText(/Proposed variants/i)).toBeVisible()
    await page.getByTestId('viewer-analysis-details').click()
    await expect(page.getByTestId('viewer-workflow-summary')).toBeInViewport()

    await page.getByTestId('viewer-copy-residues').click()
    await expect(page.getByTestId('viewer-selection-chains')).toHaveText('B')
    await expect(page.getByTestId('viewer-selection-pair')).toContainText('B:9 SER')
    await expect(page.getByTestId('viewer-selection-pair')).toContainText('B:10 TYR')
    await expect(page.getByTestId('viewer-selection-distance')).toContainText('Å')
    await page.getByTestId('viewer-selection-copy-pair').click()
    await expect.poll(async () => page.evaluate(() => (window as any).__copiedText)).toMatch(/B:9 SER/)
    await expect.poll(async () => page.evaluate(() => (window as any).__copiedText)).toMatch(/B:10 TYR/)
    await page.getByTestId('viewer-selection-use-pair').click()
    await expect(page.getByTestId('viewer-analysis-positions-input')).toHaveValue(/9/)
    await expect(page.getByTestId('viewer-analysis-positions-input')).toHaveValue(/10/)
    await expect(page.getByTestId('viewer-selection-spotlight-index')).toHaveText('2 / 2')
    await expect.poll(async () => page.evaluate(() => (window as any).__copiedText)).toMatch(/B:9 SER/)
    await expect.poll(async () => page.evaluate(() => (window as any).__copiedText)).toMatch(/B:10 TYR/)

    await page.getByTestId('viewer-chain-solo-B').click()
    await expect(page.getByTestId('viewer-chain-filter')).toHaveValue('all')
  })

  test('3D viewer hover spotlight supports quick residue analysis actions', async ({ page }) => {
    const job = makeCompletedJob()
    await installCompletedJobRoutes(page, job)

    await page.goto('/')
    await openCompletedJob(page)

    await page.getByRole('button', { name: /View Target in 3D/i }).click()
    await expect(page.getByText('🔬 3D Protein Structure Viewer')).toBeVisible()

    await revealHoverSpotlight(page)
    await expect(page.getByTestId('viewer-hover-spotlight')).toBeVisible()
    await expect(page.getByTestId('viewer-hover-spotlight-bfactor')).not.toHaveText('')
    await expect(page.getByTestId('viewer-hover-spotlight-sequence')).not.toHaveText('')

    const hoverLabel = ((await page.getByTestId('viewer-hover-spotlight-label').textContent()) || '').trim()
    const normalizedLabel = hoverLabel.split(' ').slice(0, 2).join(' ')

    await page.getByTestId('viewer-hover-spotlight-toggle').click()
    await expect(page.getByText(/Added residue .* to the active selection/i)).toBeVisible()
    await expect(page.getByText(`${normalizedLabel} ×`)).toBeVisible()
  })

  test('3D viewer sequence map focuses residues and stacks cleanly on mobile', async ({ page }) => {
    const job = makeAnalysisJob()
    await installCompletedJobRoutes(page, job)
    await page.setViewportSize({ width: 430, height: 1200 })

    await page.goto('/')
    await openCompletedJob(page)

    await page.getByRole('button', { name: /View Target in 3D/i }).click()
    await expect(page.getByText('🔬 3D Protein Structure Viewer')).toBeVisible()

    const canvasBox = await page.locator('canvas').boundingBox()
    const sequenceMapBox = await page.getByTestId('viewer-sequence-map').boundingBox()
    expect((sequenceMapBox?.y || 0)).toBeGreaterThanOrEqual(
      (canvasBox?.y || 0) + (canvasBox?.height || 0) - VIEWPORT_LAYOUT_TOLERANCE_PX
    )

    await page.getByTestId('viewer-chain-hotspots-B').click()
    await expect(page.getByTestId('viewer-analysis-ribbon')).toBeVisible()
    await expect(page.getByTestId('viewer-analysis-ribbon')).toBeInViewport()
    await expect(page.getByTestId('viewer-selection-spotlight')).toBeVisible()
    await expect(page.getByTestId('viewer-selection-spotlight')).toBeInViewport()
    await expect(page.getByTestId('viewer-selection-spotlight-primary')).toHaveText(/B:(9 SER|10 TYR)/)
    await expect(page.getByTestId('viewer-selection-spotlight-nearby')).toBeVisible()
    await page.getByTestId('viewer-selection-spotlight-nearby').click()
    await expect(page.getByTestId('variant-positions')).toHaveValue(/9/)
    await expect(page.getByTestId('variant-positions')).toHaveValue(/10/)
    await expect(page.getByTestId('viewer-selection-spotlight-index')).toBeVisible()
    await page.getByTestId('viewer-selection-spotlight-next').click()
    await expect(page.getByTestId('viewer-selection-spotlight-primary')).toHaveText(/B:(9 SER|10 TYR)/)
    await expect(page.getByTestId('viewer-analysis-positions-input')).toHaveValue(/9/)
    await expect(page.getByTestId('viewer-analysis-positions-input')).toHaveValue(/10/)
    await page.getByTestId('viewer-analysis-positions-input').fill('9,10,28')
    await expect(page.getByTestId('viewer-analysis-positions-input')).toHaveValue('9,10,28')
    await page.getByTestId('viewer-analysis-num-variants').fill('3')
    await page.getByTestId('viewer-selection-spotlight-copy').click()
    await expect.poll(async () => page.evaluate(() => (window as any).__copiedText)).toMatch(/B:9 SER/)
    await page.getByTestId('viewer-selection-spotlight-inspector').click()
    await expect(page.getByTestId('viewer-residue-inspector')).toBeInViewport()
    await page.getByTestId('viewer-analysis-details').click()
    await expect(page.getByTestId('viewer-workflow-summary')).toBeInViewport()
    await page.getByTestId('viewer-analysis-jump-variants').click()
    await expect(page.getByTestId('viewer-variant-proposal')).toBeInViewport()
    await expect(page.getByTestId('variant-positions')).toHaveValue('9,10,28')
    await expect(page.getByTestId('variant-num')).toHaveValue('3')
    await page.getByTestId('viewer-analysis-propose').click()
    await expect(page.getByText(/Proposed variants/i)).toBeVisible()
    await expect(page.getByTestId('viewer-variant-spotlight')).toBeVisible()
    await page.getByTestId('viewer-variant-spotlight-open-results').scrollIntoViewIfNeeded()
    await expect(page.getByTestId('viewer-variant-spotlight')).toBeInViewport()
    await expect(page.getByTestId('viewer-variant-results')).not.toBeInViewport()
    await page.getByTestId('viewer-variant-spotlight-open-results').click()
    await expect(page.getByTestId('viewer-variant-results')).toBeInViewport()

    await page.getByTestId('viewer-workflow-jump-variants').click()
    await expect(page.getByText(/Jumped to the variant proposal workspace/i)).toBeVisible()
    await expect(page.getByTestId('variant-positions')).toBeInViewport()

    await page.getByTestId('viewer-sequence-token-B-10').click()
    await expect(page.getByTestId('viewer-inspector-primary')).toHaveText('B:10 TYR')
    await expect(page.getByTestId('variant-positions')).toHaveValue('10')
    await expect(page.getByText(/Focused on residue B:10/i)).toBeVisible()
  })

  test('3D viewer keeps the top control toolbar on a single row at tablet widths', async ({ page }) => {
    const job = makeAnalysisJob()
    await installCompletedJobRoutes(page, job)
    await page.setViewportSize({ width: 1024, height: 1400 })

    await page.goto('/')
    await openCompletedJob(page)

    await page.getByRole('button', { name: /View Target in 3D/i }).click()
    await expect(page.getByText('🔬 3D Protein Structure Viewer')).toBeVisible()

    const toolbar = page.getByTestId('viewer-controls-toolbar')
    const buttonTops = await Promise.all(
      ['Ribbon', 'Cartoon', 'Ball & Stick', 'Stick', 'B-factor heatmap', 'Reset view', 'Center selection', 'Auto-rotate off', 'Save PNG'].map(
        async (name) => {
          const box = await toolbar.getByRole('button', { name, exact: true }).boundingBox()
          return Math.round(box?.y || 0)
        }
      )
    )

    expect(new Set(buttonTops).size).toBe(1)
  })

  test('3D viewer heatmap legend, PDB download, distance card, and selection helpers', async ({ page }) => {
    const job = makeAnalysisJob()
    await installCompletedJobRoutes(page, job)

    await page.goto('/')
    await openCompletedJob(page)

    await page.getByRole('button', { name: /View Target in 3D/i }).click()
    await expect(page.getByText('🔬 3D Protein Structure Viewer')).toBeVisible()

    // Heatmap legend appears when heatmap is on, hidden when off
    await expect(page.getByTestId('viewer-heatmap-legend')).toBeHidden()
    await page.getByRole('button', { name: 'B-factor heatmap', exact: true }).click()
    await expect(page.getByTestId('viewer-heatmap-legend')).toBeVisible()
    await expect(page.getByTestId('viewer-heatmap-legend')).toContainText('B-factor scale')
    await page.getByRole('button', { name: 'B-factor heatmap', exact: true }).click()
    await expect(page.getByTestId('viewer-heatmap-legend')).toBeHidden()

    // Keyboard shortcuts toggle key viewer modes and focus the residue input.
    await page.keyboard.press('h')
    await expect(page.getByTestId('viewer-heatmap-legend')).toBeVisible()
    await page.keyboard.press('h')
    await expect(page.getByTestId('viewer-heatmap-legend')).toBeHidden()
    await page.keyboard.press('l')
    await expect(page.getByTestId('viewer-show-labels')).toHaveText(/Labels off/i)
    await page.keyboard.press('c')
    await expect(page.getByTestId('viewer-color-by-chain')).toHaveClass(/bg-white\/5/)
    await page.keyboard.press('/')
    await expect(page.getByTestId('viewer-focus-residue')).toBeFocused()
    await page.keyboard.type('B:9')
    await page.getByTestId('viewer-focus-button').click()
    await expect(page.getByText(/Focused on residue B:9/i)).toBeVisible()
    await page.keyboard.press('f')
    await expect(page.getByTestId('viewer-fullscreen')).toHaveText(/Restore/i)
    await page.keyboard.press('f')
    await expect(page.getByTestId('viewer-fullscreen')).toHaveText(/Expand/i)

    // Download PDB button triggers a download
    const pdbDownload = page.waitForEvent('download')
    await page.getByTestId('viewer-download-pdb').click()
    const pdbFile = await pdbDownload
    expect(pdbFile.suggestedFilename()).toMatch(/\.pdb$/)

    // Select all & invert selection helpers
    await page.getByTestId('viewer-select-all').click()
    await expect(page.getByText(/Selected all 4 visible residues/i)).toBeVisible()
    await page.getByTestId('viewer-invert-selection').click()
    await expect(page.getByText(/Nothing left after inverting/i)).toBeVisible()

    // Distance card appears for exactly 2 residues
    await page.getByTestId('viewer-chain-hotspots-B').click()
    // B chain has 2 residues → exactly 2 selected → distance card should appear
    await expect(page.getByTestId('viewer-distance-card')).toBeVisible()
    await expect(page.getByTestId('viewer-distance-value')).toContainText('Å')

    // Copy button in distance card works
    await page.getByTestId('viewer-distance-copy').click()
    await expect.poll(async () => page.evaluate(() => (window as any).__copiedText)).toMatch(/Å/)

    // Add a third residue → distance card should disappear (requires > 2 or < 2 residues)
    // Clear the selection → 0 residues → distance card hidden
    await page.getByTestId('viewer-selection-spotlight-clear').click()
    await expect(page.getByTestId('viewer-distance-card')).toBeHidden()
  })
})
