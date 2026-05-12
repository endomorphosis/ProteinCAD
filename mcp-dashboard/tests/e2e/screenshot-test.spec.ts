import { test, type Page } from '@playwright/test'

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

async function revealHoverSpotlight(page: Page) {
  const canvas = page.locator('canvas').first()
  const box = await canvas.boundingBox()
  if (!box) return false

  const hoverSpotlight = page.getByTestId('viewer-hover-spotlight')
  const xSteps = [0.28, 0.35, 0.42, 0.5, 0.58, 0.65, 0.72]
  const ySteps = [0.24, 0.32, 0.4, 0.5, 0.6, 0.68]

  for (const xFactor of xSteps) {
    for (const yFactor of ySteps) {
      await page.mouse.move(box.x + box.width * xFactor, box.y + box.height * yFactor, { steps: 8 })
      await page.waitForTimeout(80)
      if (await hoverSpotlight.isVisible()) return true
    }
  }

  return false
}

test('take after screenshots', async ({ page }) => {
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

  await page.goto('/')
  await page.waitForTimeout(2000)
  await page.screenshot({ path: '/tmp/ss-after-dashboard.png', fullPage: false })

  await page.getByTestId('job-card-job_ss0').click()
  await page.waitForTimeout(800)
  await page.screenshot({ path: '/tmp/ss-after-job.png', fullPage: false })

  await page.getByRole('button', { name: /View Target in 3D/i }).click()
  await page.waitForTimeout(2000)
  await page.screenshot({ path: '/tmp/ss-after-3d.png', fullPage: false })

  // Hover spotlight state
  try {
    if (await revealHoverSpotlight(page)) {
      await page.waitForTimeout(300)
      await page.screenshot({ path: '/tmp/ss-after-hover-spotlight.png', fullPage: false })
    }
  } catch { /* ok */ }

  // Sidebar full viewport height
  const aside = page.locator('aside').first()
  const box = await aside.boundingBox()
  const vp = page.viewportSize() || { width: 1440, height: 900 }
  if (box && box.width > 10) {
    const x = Math.max(0, box.x)
    const w = Math.min(box.width, vp.width - x)
    if (w > 0) {
      await page.screenshot({
        path: '/tmp/ss-after-sidebar.png',
        clip: { x, y: 0, width: w, height: vp.height },
      })
    }
  }

  // Toolbar
  try {
    const toolbar = page.getByTestId('viewer-controls-toolbar')
    const tb = await toolbar.boundingBox()
    if (tb && tb.width > 10) {
      await page.screenshot({
        path: '/tmp/ss-after-toolbar.png',
        clip: { x: 0, y: Math.max(0, tb.y), width: vp.width, height: Math.min(tb.height + 70, vp.height - tb.y) },
      })
    }
  } catch { /* ok */ }

  // Legend interaction state
  try {
    await page.getByTestId('viewer-legend-chain-B').click()
    await page.waitForTimeout(500)
    const legend = page.getByTestId('viewer-legend-chain-B')
    const lb = await legend.boundingBox()
    if (lb && lb.width > 10) {
      await page.screenshot({
        path: '/tmp/ss-after-legend.png',
        clip: { x: 0, y: Math.max(0, lb.y - 90), width: vp.width, height: Math.min(220, vp.height - Math.max(0, lb.y - 90)) },
      })
    }
  } catch { /* ok */ }

  // Select hotspots to show selection spotlight
  await page.getByTestId('viewer-hotspots-3').click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: '/tmp/ss-after-selection.png', fullPage: false })

  // Sequence map
  try {
    const seqMap = page.getByTestId('viewer-sequence-map')
    if (await seqMap.isVisible()) {
      const sm = await seqMap.boundingBox()
      if (sm && sm.width > 10 && sm.height > 10) {
        const y = Math.max(0, sm.y)
        const h = Math.min(sm.height, vp.height - y)
        if (h > 0) {
          await page.screenshot({
            path: '/tmp/ss-after-seqmap.png',
            clip: { x: Math.max(0, sm.x), y, width: Math.min(sm.width, vp.width - sm.x), height: h },
          })
        }
      }
    }
  } catch { /* ok */ }
})
