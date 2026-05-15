import { test, expect } from '@playwright/test'
import { installMockEventSource, jsonRoute } from './helpers/mocks'

test.describe('Dashboard home', () => {
  test.beforeEach(async ({ page }) => {
    await installMockEventSource(page)
  })

  test('renders and shows service status', async ({ page }) => {
    const status = {
      alphafold: { status: 'ready', url: 'http://localhost:8081' },
      rfdiffusion: { status: 'not_ready', url: 'http://localhost:8082' },
      proteinmpnn: { status: 'error', url: 'http://localhost:8083', error: 'boom' },
      alphafold_multimer: { status: 'ready', url: 'http://localhost:8084' },
    }

    await page.route('**/api/mcp/services/status', async (route) => {
      await jsonRoute(route, status)
    })

    await page.route('**/api/mcp/jobs', async (route) => {
      if (route.request().method() === 'GET') {
        await jsonRoute(route, [])
        return
      }
      await route.fallback()
    })

    await page.goto('/')

    await expect(page.getByRole('heading', { name: /Protein Binder Design/i })).toBeVisible()
    const servicePanel = page.getByTestId('service-status-panel')
    await expect(page.getByRole('heading', { name: 'Service Status' })).toBeVisible()

    await expect(servicePanel.getByTestId('service-card-alphafold')).toContainText('alphafold')
    await expect(servicePanel.getByTestId('service-card-rfdiffusion')).toContainText('rfdiffusion')
    await expect(servicePanel.getByTestId('service-card-proteinmpnn')).toContainText('proteinmpnn')
    await expect(servicePanel.getByTestId('service-card-alphafold_multimer')).toContainText('alphafold_multimer')

    await expect(servicePanel.getByText('ready').first()).toBeVisible()

    // Verbose warnings should be visible for non-ready services
    await expect(page.getByRole('heading', { name: 'Warnings' })).toBeVisible()
    await expect(page.getByText(/rfdiffusion is not_ready/i)).toBeVisible()
    await expect(page.getByText(/proteinmpnn is error/i)).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Warnings' }).locator('..').getByText('boom')).toBeVisible()
  })

  test('service status error state is visible', async ({ page }) => {
    await page.route('**/api/mcp/services/status', async (route) => {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'nope' }) })
    })

    await page.route('**/api/mcp/jobs', async (route) => {
      if (route.request().method() === 'GET') {
        await jsonRoute(route, [])
        return
      }
      await route.fallback()
    })

    await page.goto('/')

    await expect(page.getByRole('heading', { name: 'Service Status' })).toBeVisible()
    await expect(page.getByText('Unable to load service status')).toBeVisible()
  })
})
