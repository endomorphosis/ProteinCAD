import { test, expect } from '@playwright/test'
import { installMockEventSource, jsonRoute } from './helpers/mocks'

function toolResult(textObj: any) {
  return {
    content: [{ type: 'text', text: JSON.stringify(textObj) }],
    isError: false,
  }
}

test.describe('Settings + utility buttons', () => {
  let putConfigPayloads: any[] = []

  test.beforeEach(async ({ page }) => {
    await installMockEventSource(page)
    putConfigPayloads = []

    // Spy on window.open so we can assert the button wiring without requiring
    // a real Jupyter server to be running.
    await page.addInitScript(() => {
      const originalOpen = window.open
      ;(window as any).__lastWindowOpenUrl = null
      window.open = ((url?: string | URL, target?: string, features?: string) => {
        ;(window as any).__lastWindowOpenUrl = String(url ?? '')
        return originalOpen.call(window, url as any, target as any, features as any)
      }) as any
    })

    // AlphaFoldSettings calls tools via the dashboard proxy route.
    const baseSettings = {
      speed_preset: 'balanced',
      disable_templates: false,
      num_recycles: 3,
      num_ensemble: 1,
      mmseqs2_max_seqs: 512,
      msa_mode: 'mmseqs2',
    }

    await page.route('**/api/mcp/tools/call', async (route) => {
      const body = route.request().postDataJSON() as any
      const name = body?.name

      if (name === 'get_alphafold_settings') {
        await jsonRoute(route, toolResult(baseSettings))
        return
      }

      if (name === 'update_alphafold_settings') {
        await jsonRoute(
          route,
          toolResult({ success: true, settings: baseSettings, message: 'AlphaFold settings updated successfully' })
        )
        return
      }

      if (name === 'reset_alphafold_settings') {
        await jsonRoute(
          route,
          toolResult({ success: true, settings: baseSettings, message: 'AlphaFold settings reset to defaults' })
        )
        return
      }

      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'unknown tool' }) })
    })

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

    // ToolsPanel loads tool metadata on page load.
    await page.route('**/api/mcp/tools', async (route) => {
      await jsonRoute(route, { tools: [] })
    })

    // BackendSettings uses these dashboard routes.
    const minimalConfig = {
      version: 2,
      allow_runtime_updates: true,
      routing: { mode: 'fallback', primary: 'nim', order: ['nim', 'external', 'embedded'] },
      nim: { enabled: true, service_urls: { alphafold: null, rfdiffusion: null, proteinmpnn: null, alphafold_multimer: null } },
      external: { enabled: false, service_urls: { alphafold: null, rfdiffusion: null, proteinmpnn: null, alphafold_multimer: null } },
      embedded: {
        enabled: true,
        model_dir: '/models',
        auto_install: false,
        auto_download: false,
        downloads: {
          proteinmpnn_source_tarball_url: null,
          proteinmpnn_weights_url: null,
          rfdiffusion_weights_url: null,
          alphafold_db_url: null,
          alphafold_db_url_full: null,
          alphafold_db_subdir: 'alphafold_db',
          alphafold_mgnify_url: null,
          alphafold_mgnify_fallback: 'none',
          alphafold_mgnify_hf_dataset: 'tattabio/OMG_prot50',
          alphafold_mgnify_hf_token: null,
        },
        runners: {
          alphafold: { argv: [], timeout_seconds: 3600 },
          rfdiffusion: { argv: [], timeout_seconds: 3600 },
          alphafold_multimer: { argv: [], timeout_seconds: 3600 },
        },
      },
      retrieval: {
        provider: 'ncbi_blast_remote',
        feature_flags: {
          enabled: true,
          expose_rest: true,
          expose_mcp: true,
          allow_job_grounding: false,
          evidence_enrichment: true,
          export_parquet: false,
          create_schema_on_startup: true,
        },
        blast: {
          remote_base_url: 'https://blast.ncbi.nlm.nih.gov/Blast.cgi',
          default_program: 'blastp',
          default_database: 'swissprot',
          default_hitlist_size: 25,
          max_hitlist_size: 100,
          poll_interval_seconds: 5,
          max_poll_attempts: 60,
          request_timeout_seconds: 30,
        },
        storage: {
          data_dir: '/tmp/retrieval',
          duckdb_path: '/tmp/retrieval/blast_retrieval.duckdb',
          parquet_export_dir: '/tmp/retrieval/parquet',
          raw_payload_dir: '/tmp/retrieval/raw_payloads',
          manifest_dir: '/tmp/retrieval/manifests',
        },
      },
    }

    await page.route('**/api/mcp/config', async (route) => {
      const method = route.request().method()
      if (method === 'GET') {
        await jsonRoute(route, minimalConfig)
        return
      }
      if (method === 'PUT') {
        putConfigPayloads.push(route.request().postDataJSON())
        await jsonRoute(route, minimalConfig)
        return
      }
      await route.fallback()
    })

    await page.route('**/api/mcp/config/reset', async (route) => {
      await jsonRoute(route, minimalConfig)
    })

    await page.route('**/api/mcp/embedded/bootstrap', async (route) => {
      await jsonRoute(route, { ok: true })
    })
  })

  test('Backend settings modal opens and closes', async ({ page }) => {
    await page.goto('/')

    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Backend Settings' })).toBeVisible()

    // Avoid viewport edge cases by dispatching the click event.
    await page.getByRole('button', { name: 'Close' }).dispatchEvent('click')
    await expect(page.getByRole('heading', { name: 'Backend Settings' })).toBeHidden()
  })

  test('AlphaFold settings expands and save/reset buttons work', async ({ page }) => {
    page.on('dialog', async (dialog) => {
      await dialog.accept()
    })

    await page.goto('/')

    await page.getByRole('button', { name: /AlphaFold Optimization Settings/i }).click()
    await expect(page.getByRole('button', { name: 'Save Settings' })).toBeVisible()

    await page.getByRole('button', { name: 'Save Settings' }).click()
    await expect(page.getByText(/updated successfully/i)).toBeVisible()

    await page.getByRole('button', { name: 'Reset to Defaults' }).click()
    await expect(page.getByText('AlphaFold settings reset to defaults')).toBeVisible()
  })

  test('Jupyter launcher button opens a new tab', async ({ page }) => {
    await page.goto('/')

    await page.getByRole('button', { name: /Open Jupyter Notebook/i }).click()

    // The app uses a fixed localhost URL today.
    const openedUrl = await page.evaluate(() => (window as any).__lastWindowOpenUrl)
    expect(openedUrl).toContain('http://localhost:8888')
  })

  test('BLAST retrieval settings render and are included in saved config', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()

    await expect(page.getByRole('heading', { name: 'BLAST Retrieval' })).toBeVisible()
    await expect(page.getByLabel('allow job grounding (opt-in)')).toBeVisible()

    await page.getByLabel('allow job grounding (opt-in)').check()
    await page.getByLabel('Program').fill('blastx')
    await page.getByRole('button', { name: 'Save' }).click()

    expect(putConfigPayloads.length).toBeGreaterThan(0)
    const latest = putConfigPayloads[putConfigPayloads.length - 1]
    expect(latest?.retrieval?.feature_flags?.allow_job_grounding).toBe(true)
    expect(latest?.retrieval?.blast?.default_program).toBe('blastx')
  })
})
