import { test, type Page } from '@playwright/test'

const MOCK_JOB_AGE_MS = 2 * 60_000
const SCREENSHOT_TEST_TIMEOUT_MS = 120_000
const WAIT_SHORT_MS = 300
const WAIT_MEDIUM_MS = 600
const WAIT_LONG_MS = 800
const WAIT_VIEWER_BOOT_MS = 2_000

// 18-residue alpha-helix (chain A) + 8-residue beta-strand (chain B) for realistic 3D preview
const PDB = `ATOM      1  N   ALA A   1      13.500  13.700   1.100  1.00 12.00           N
ATOM      2  CA  ALA A   1      14.300  14.000   1.500  1.00 12.00           C
ATOM      3  C   ALA A   1      15.400  14.500   1.800  1.00 12.00           C
ATOM      4  O   ALA A   1      16.100  14.700   1.000  1.00 12.00           O
ATOM      5  N   LEU A   2      10.801  15.965   2.600  1.00 13.20           N
ATOM      6  CA  LEU A   2      11.601  16.265   3.000  1.00 13.20           C
ATOM      7  C   LEU A   2      12.701  16.765   3.300  1.00 13.20           C
ATOM      8  O   LEU A   2      13.401  16.965   2.500  1.00 13.20           O
ATOM      9  N   ILE A   3       9.039  12.913   4.100  1.00 14.40           N
ATOM     10  CA  ILE A   3       9.839  13.213   4.500  1.00 14.40           C
ATOM     11  C   ILE A   3      10.939  13.713   4.800  1.00 14.40           C
ATOM     12  O   ILE A   3      11.639  13.913   4.000  1.00 14.40           O
ATOM     13  N   GLU A   4      12.350  11.708   5.600  1.00 15.60           N
ATOM     14  CA  GLU A   4      13.150  12.008   6.000  1.00 15.60           C
ATOM     15  C   GLU A   4      14.250  12.508   6.300  1.00 15.60           C
ATOM     16  O   GLU A   4      14.950  12.708   5.500  1.00 15.60           O
ATOM     17  N   LYS A   5      12.962  15.178   7.100  1.00 16.80           N
ATOM     18  CA  LYS A   5      13.762  15.478   7.500  1.00 16.80           C
ATOM     19  C   LYS A   5      14.862  15.978   7.800  1.00 16.80           C
ATOM     20  O   LYS A   5      15.562  16.178   7.000  1.00 16.80           O
ATOM     21  N   ALA A   6       9.438  15.178   8.600  1.00 18.00           N
ATOM     22  CA  ALA A   6      10.238  15.478   9.000  1.00 18.00           C
ATOM     23  C   ALA A   6      11.338  15.978   9.300  1.00 18.00           C
ATOM     24  O   ALA A   6      12.038  16.178   8.500  1.00 18.00           O
ATOM     25  N   LEU A   7      10.050  11.708  10.100  1.00 19.20           N
ATOM     26  CA  LEU A   7      10.850  12.008  10.500  1.00 19.20           C
ATOM     27  C   LEU A   7      11.950  12.508  10.800  1.00 19.20           C
ATOM     28  O   LEU A   7      12.650  12.708  10.000  1.00 19.20           O
ATOM     29  N   GLU A   8      13.361  12.913  11.600  1.00 20.40           N
ATOM     30  CA  GLU A   8      14.161  13.213  12.000  1.00 20.40           C
ATOM     31  C   GLU A   8      15.261  13.713  12.300  1.00 20.40           C
ATOM     32  O   GLU A   8      15.961  13.913  11.500  1.00 20.40           O
ATOM     33  N   LYS A   9      11.599  15.965  13.100  1.00 21.60           N
ATOM     34  CA  LYS A   9      12.399  16.265  13.500  1.00 21.60           C
ATOM     35  C   LYS A   9      13.499  16.765  13.800  1.00 21.60           C
ATOM     36  O   LYS A   9      14.199  16.965  13.000  1.00 21.60           O
ATOM     37  N   ASP A  10       8.900  13.700  14.600  1.00 22.80           N
ATOM     38  CA  ASP A  10       9.700  14.000  15.000  1.00 22.80           C
ATOM     39  C   ASP A  10      10.800  14.500  15.300  1.00 22.80           C
ATOM     40  O   ASP A  10      11.500  14.700  14.500  1.00 22.80           O
ATOM     41  N   ARG A  11      11.599  11.435  16.100  1.00 24.00           N
ATOM     42  CA  ARG A  11      12.399  11.735  16.500  1.00 24.00           C
ATOM     43  C   ARG A  11      13.499  12.235  16.800  1.00 24.00           C
ATOM     44  O   ARG A  11      14.199  12.435  16.000  1.00 24.00           O
ATOM     45  N   ALA A  12      13.361  14.487  17.600  1.00 25.20           N
ATOM     46  CA  ALA A  12      14.161  14.787  18.000  1.00 25.20           C
ATOM     47  C   ALA A  12      15.261  15.287  18.300  1.00 25.20           C
ATOM     48  O   ALA A  12      15.961  15.487  17.500  1.00 25.20           O
ATOM     49  N   LEU A  13      10.050  15.692  19.100  1.00 26.40           N
ATOM     50  CA  LEU A  13      10.850  15.992  19.500  1.00 26.40           C
ATOM     51  C   LEU A  13      11.950  16.492  19.800  1.00 26.40           C
ATOM     52  O   LEU A  13      12.650  16.692  19.000  1.00 26.40           O
ATOM     53  N   ILE A  14       9.438  12.222  20.600  1.00 27.60           N
ATOM     54  CA  ILE A  14      10.238  12.522  21.000  1.00 27.60           C
ATOM     55  C   ILE A  14      11.338  13.022  21.300  1.00 27.60           C
ATOM     56  O   ILE A  14      12.038  13.222  20.500  1.00 27.60           O
ATOM     57  N   SER A  15      12.962  12.222  22.100  1.00 28.80           N
ATOM     58  CA  SER A  15      13.762  12.522  22.500  1.00 28.80           C
ATOM     59  C   SER A  15      14.862  13.022  22.800  1.00 28.80           C
ATOM     60  O   SER A  15      15.562  13.222  22.000  1.00 28.80           O
ATOM     61  N   GLU A  16      12.350  15.692  23.600  1.00 30.00           N
ATOM     62  CA  GLU A  16      13.150  15.992  24.000  1.00 30.00           C
ATOM     63  C   GLU A  16      14.250  16.492  24.300  1.00 30.00           C
ATOM     64  O   GLU A  16      14.950  16.692  23.500  1.00 30.00           O
ATOM     65  N   LYS A  17       9.039  14.487  25.100  1.00 31.20           N
ATOM     66  CA  LYS A  17       9.839  14.787  25.500  1.00 31.20           C
ATOM     67  C   LYS A  17      10.939  15.287  25.800  1.00 31.20           C
ATOM     68  O   LYS A  17      11.639  15.487  25.000  1.00 31.20           O
ATOM     69  N   ARG A  18      10.801  11.435  26.600  1.00 32.40           N
ATOM     70  CA  ARG A  18      11.601  11.735  27.000  1.00 32.40           C
ATOM     71  C   ARG A  18      12.701  12.235  27.300  1.00 32.40           C
ATOM     72  O   ARG A  18      13.401  12.435  26.500  1.00 32.40           O
TER
ATOM     73  N   VAL B   1       4.200   7.000   2.100  1.00 20.00           N
ATOM     74  CA  VAL B   1       5.500   7.000   3.000  1.00 20.00           C
ATOM     75  C   VAL B   1       6.800   7.000   3.700  1.00 20.00           C
ATOM     76  O   VAL B   1       6.800   8.200   4.000  1.00 20.00           O
ATOM     77  N   ILE B   2       6.800   6.300   5.200  1.00 24.00           N
ATOM     78  CA  ILE B   2       5.500   6.000   6.600  1.00 24.00           C
ATOM     79  C   ILE B   2       4.200   6.000   7.300  1.00 24.00           C
ATOM     80  O   ILE B   2       4.200   4.800   7.600  1.00 24.00           O
ATOM     81  N   LEU B   3       4.200   6.700   8.800  1.00 28.00           N
ATOM     82  CA  LEU B   3       5.500   7.000  10.200  1.00 28.00           C
ATOM     83  C   LEU B   3       6.800   7.000  10.900  1.00 28.00           C
ATOM     84  O   LEU B   3       6.800   8.200  11.200  1.00 28.00           O
ATOM     85  N   PHE B   4       6.800   6.300  12.400  1.00 32.00           N
ATOM     86  CA  PHE B   4       5.500   6.000  13.800  1.00 32.00           C
ATOM     87  C   PHE B   4       4.200   6.000  14.500  1.00 32.00           C
ATOM     88  O   PHE B   4       4.200   4.800  14.800  1.00 32.00           O
ATOM     89  N   TYR B   5       4.200   6.700  16.000  1.00 36.00           N
ATOM     90  CA  TYR B   5       5.500   7.000  17.400  1.00 36.00           C
ATOM     91  C   TYR B   5       6.800   7.000  18.100  1.00 36.00           C
ATOM     92  O   TYR B   5       6.800   8.200  18.400  1.00 36.00           O
ATOM     93  N   ALA B   6       6.800   6.300  19.600  1.00 40.00           N
ATOM     94  CA  ALA B   6       5.500   6.000  21.000  1.00 40.00           C
ATOM     95  C   ALA B   6       4.200   6.000  21.700  1.00 40.00           C
ATOM     96  O   ALA B   6       4.200   4.800  22.000  1.00 40.00           O
ATOM     97  N   GLY B   7       4.200   6.700  23.200  1.00 44.00           N
ATOM     98  CA  GLY B   7       5.500   7.000  24.600  1.00 44.00           C
ATOM     99  C   GLY B   7       6.800   7.000  25.300  1.00 44.00           C
ATOM    100  O   GLY B   7       6.800   8.200  25.600  1.00 44.00           O
ATOM    101  N   LEU B   8       6.800   6.300  26.800  1.00 48.00           N
ATOM    102  CA  LEU B   8       5.500   6.000  28.200  1.00 48.00           C
ATOM    103  C   LEU B   8       4.200   6.000  28.900  1.00 48.00           C
ATOM    104  O   LEU B   8       4.200   4.800  29.200  1.00 48.00           O
TER
END
`

const JOB = {
  job_id: 'job_ss0',
  status: 'completed',
  created_at: new Date(Date.now() - MOCK_JOB_AGE_MS).toISOString(),
  updated_at: new Date().toISOString(),
  job_name: 'Screenshot Job',
  input: { sequence: 'ALIEKALE', num_designs: 2 },
  progress: { alphafold: 'completed', rfdiffusion: 'completed', proteinmpnn: 'completed', alphafold_multimer: 'completed' },
  results: {
    target_structure: { pdb: PDB },
    designs: [
      { design_id: 0, backbone: { pdb: PDB }, sequence: { sequence: 'ALIEKALE' }, complex_structure: { pdb: PDB } },
      { design_id: 1, backbone: { pdb: PDB }, sequence: { sequence: 'ALIEKDRALE' }, complex_structure: { pdb: PDB } },
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
  test.setTimeout(SCREENSHOT_TEST_TIMEOUT_MS)

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
  await page.waitForTimeout(WAIT_VIEWER_BOOT_MS)
  await page.screenshot({ path: '/tmp/ss-after-dashboard.png', fullPage: false })

  await page.getByTestId('job-card-job_ss0').click()
  await page.waitForTimeout(WAIT_LONG_MS)
  await page.screenshot({ path: '/tmp/ss-after-job.png', fullPage: false })

  await page.getByRole('button', { name: /View Target in 3D/i }).click()
  await page.waitForTimeout(WAIT_VIEWER_BOOT_MS)
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
    await page.waitForTimeout(WAIT_MEDIUM_MS)
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
  await page.waitForTimeout(WAIT_MEDIUM_MS)
  await page.screenshot({ path: '/tmp/ss-after-selection.png', fullPage: false })

  // Angle measurement card (3-residue selection shows the Cα–Cα–Cα angle)
  try {
    const angleCard = page.getByTestId('viewer-angle-card')
    if (await angleCard.isVisible()) {
      const ab = await angleCard.boundingBox()
      if (ab && ab.width > 10 && ab.height > 10) {
        const y = Math.max(0, ab.y - 10)
        const h = Math.min(ab.height + 20, vp.height - y)
        if (h > 0) {
          await page.screenshot({
            path: '/tmp/ss-after-angle-card.png',
            clip: { x: 0, y, width: vp.width, height: h },
          })
        }
      }
    }
  } catch { /* ok */ }

  // Sequence map with B-factor sparkline bars
  try {
    // First click a chain-B hotspot so the sequence map populates
    await page.getByTestId('viewer-chain-hotspots-B').click()
    await page.waitForTimeout(WAIT_MEDIUM_MS)
    const seqMap = page.getByTestId('viewer-sequence-map')
    if (await seqMap.isVisible()) {
      await seqMap.scrollIntoViewIfNeeded()
      await page.waitForTimeout(WAIT_SHORT_MS)
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

  // Measure overlay SVG (select 2 residues then scroll 3D canvas into view)
  try {
    await page.getByTestId('viewer-chain-hotspots-B').click()
    await page.waitForTimeout(WAIT_SHORT_MS)
    // Remove one residue to get exactly 2 selected → distance line should appear
    const chips = page.locator('[data-testid^="viewer-selection-spotlight-chip-"]')
    const chipCount = await chips.count()
    if (chipCount > 2) {
      await chips.first().click()
      await page.waitForTimeout(WAIT_SHORT_MS)
    }
    const overlay = page.getByTestId('viewer-measure-overlay')
    if (await overlay.isVisible()) {
      await page.screenshot({ path: '/tmp/ss-after-measure-overlay.png', fullPage: false })
    }
  } catch { /* ok */ }

  // Spacefill (surface) render mode
  try {
    await page.getByTestId('viewer-selection-spotlight-clear').click().catch(() => {})
    await page.getByRole('button', { name: 'Spacefill', exact: true }).click()
    await page.waitForTimeout(WAIT_LONG_MS)
    await page.screenshot({ path: '/tmp/ss-after-spacefill.png', fullPage: false })
    // Switch back to ribbon
    await page.getByRole('button', { name: 'Ribbon', exact: true }).click()
    await page.waitForTimeout(WAIT_SHORT_MS)
  } catch { /* ok */ }

  // Cartoon mode
  try {
    await page.getByRole('button', { name: 'Cartoon', exact: true }).click()
    await page.waitForTimeout(WAIT_MEDIUM_MS)
    await page.screenshot({ path: '/tmp/ss-after-cartoon.png', fullPage: false })
    await page.getByRole('button', { name: 'Ribbon', exact: true }).click()
    await page.waitForTimeout(WAIT_SHORT_MS)
  } catch { /* ok */ }

  // 3D distance measurement lines (2-residue selection)
  try {
    await page.getByTestId('viewer-hotspots-3').click()
    await page.waitForTimeout(WAIT_LONG_MS)
    await page.screenshot({ path: '/tmp/ss-after-3d-with-selection.png', fullPage: false })
  } catch { /* ok */ }
})
