import { test } from '@playwright/test'

const PDB = `ATOM      1  N   ALA A   1      10.000  12.000   2.100  1.00 12.00           N
ATOM      2  CA  ALA A   1      11.400  12.400   2.100  1.00 12.00           C
ATOM      3  N   GLY A   2      12.700  13.200   2.100  1.00 18.00           N
ATOM      4  CA  GLY A   2      13.900  14.000   2.100  1.00 18.00           C
ATOM      5  N   SER A   3      14.800  15.300   2.800  1.00 24.00           N
ATOM      6  CA  SER A   3      15.900  16.100   2.400  1.00 24.00           C
ATOM      7  N   THR A   4      17.200  16.500   3.100  1.00 32.00           N
ATOM      8  CA  THR A   4      18.400  17.200   2.800  1.00 32.00           C
ATOM      9  N   HIS B   1      17.500  16.200   2.100  1.00 65.00           N
ATOM     10  CA  HIS B   1      18.900  16.700   2.100  1.00 65.00           C
ATOM     11  N   TYR B   2      20.300  17.500   2.100  1.00 72.00           N
ATOM     12  CA  TYR B   2      21.700  18.100   2.100  1.00 72.00           C
ATOM     13  N   GLU B   3      22.800  18.900   2.800  1.00 55.00           N
ATOM     14  CA  GLU B   3      24.100  19.400   2.500  1.00 55.00           C
TER
END
`

const JOB = {
  job_id: 'job_ss0',
  status: 'completed',
  created_at: new Date(Date.now() - 120000).toISOString(),
  updated_at: new Date().toISOString(),
  job_name: 'Screenshot Job',
  input: { sequence: 'AGSTHYE', num_designs: 2 },
  progress: { alphafold: 'completed', rfdiffusion: 'completed', proteinmpnn: 'completed', alphafold_multimer: 'completed' },
  results: {
    target_structure: { pdb: PDB },
    designs: [
      { design_id: 0, backbone: { pdb: PDB }, sequence: { sequence: 'AGSTHYE' }, complex_structure: { pdb: PDB } },
      { design_id: 1, backbone: { pdb: PDB }, sequence: { sequence: 'AGSTKYERR' }, complex_structure: { pdb: PDB } },
    ],
  },
  error: null,
}

test('take screenshots', async ({ page }) => {
  await page.route('**/api/mcp/services/status', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ alphafold: { status: 'ready', url: 'x' } })
  }))
  await page.route('**/api/mcp/jobs', async r => {
    if (r.request().method() === 'GET') return r.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify([JOB])
    })
    await r.fallback()
  })
  await page.route('**/api/mcp/tools', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ tools: [{ name: 'predict_structure', description: 'Predict protein structure', inputSchema: { type: 'object', properties: { sequence: { type: 'string' } }, required: ['sequence'] } }] })
  }))

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await page.waitForTimeout(2000)
  await page.screenshot({ path: '/tmp/ss1-dashboard.png', fullPage: false })

  await page.getByTestId('job-card-job_ss0').click()
  await page.waitForTimeout(1000)
  await page.screenshot({ path: '/tmp/ss2-job-selected.png', fullPage: false })

  // Scroll down to see score chart
  const resultsSection = page.locator('[data-testid="design-score-chart"]')
  if (await resultsSection.isVisible()) {
    await resultsSection.scrollIntoViewIfNeeded()
    await page.waitForTimeout(400)
    await page.screenshot({ path: '/tmp/ss2b-score-chart.png', fullPage: false })
  }

  // Open 3D viewer
  await page.getByRole('button', { name: /View Target in 3D/i }).click()
  await page.waitForTimeout(2500)
  await page.screenshot({ path: '/tmp/ss3-3d-viewer.png', fullPage: false })

  // Click hotspots
  try {
    await page.getByTestId('viewer-hotspots-3').click()
    await page.waitForTimeout(600)
    await page.screenshot({ path: '/tmp/ss4-hotspots.png', fullPage: false })
  } catch(e) {}

  // Test Top 5 hotspots
  try {
    await page.getByTestId('viewer-hotspots-5').click()
    await page.waitForTimeout(600)
    await page.screenshot({ path: '/tmp/ss4b-hotspots5.png', fullPage: false })
  } catch(e) {}

  // Test fullscreen
  try {
    await page.getByTestId('viewer-fullscreen').click()
    await page.waitForTimeout(600)
    await page.screenshot({ path: '/tmp/ss5-fullscreen.png', fullPage: false })
    // Restore
    await page.getByTestId('viewer-fullscreen').click()
    await page.waitForTimeout(400)
  } catch(e) {}

  // Toggle chain colors + labels to capture style states
  try {
    await page.getByTestId('viewer-color-by-chain').click()
    await page.waitForTimeout(400)
    await page.screenshot({ path: '/tmp/ss5b-chain-colors-off.png', fullPage: false })
    await page.getByTestId('viewer-show-labels').click()
    await page.waitForTimeout(400)
    await page.screenshot({ path: '/tmp/ss5c-labels-off.png', fullPage: false })
    await page.getByTestId('viewer-show-labels').click()
    await page.getByTestId('viewer-color-by-chain').click()
  } catch(e) {}

  // Close viewer
  try {
    await page.getByTestId('close-3d-viewer').click()
    await page.waitForTimeout(500)
  } catch(e) {}

  // Expand a design to see annotated sequence
  try {
    await page.locator('[data-testid^="design-spotlight-"]').first().click()
    await page.waitForTimeout(600)
    await page.screenshot({ path: '/tmp/ss6-design-expanded.png', fullPage: false })
  } catch(e) {}
})
