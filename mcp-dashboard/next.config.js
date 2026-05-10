const fs = require('fs')
const path = require('path')

class EnsureLegacyPagesManifestPlugin {
  apply(compiler) {
    compiler.hooks.afterEmit.tap('EnsureLegacyPagesManifestPlugin', () => {
      const outputRoot = compiler.options.output.path
      const pagesDir = path.join(outputRoot, 'pages')
      const manifestPath = path.join(outputRoot, 'pages-manifest.json')

      if (!fs.existsSync(pagesDir)) return

      const collectEntries = (dir, prefix = '') => {
        const entries = {}

        for (const name of fs.readdirSync(dir)) {
          const absolute = path.join(dir, name)
          const relative = prefix ? `${prefix}/${name}` : name
          const stat = fs.statSync(absolute)

          if (stat.isDirectory()) {
            Object.assign(entries, collectEntries(absolute, relative))
            continue
          }

          if (!name.endsWith('.js')) continue

          const withoutExtension = relative.replace(/\.js$/, '')
          const route =
            withoutExtension === 'index'
              ? '/'
              : withoutExtension.endsWith('/index')
                ? `/${withoutExtension.slice(0, -'/index'.length)}`
                : `/${withoutExtension}`

          entries[route] = `pages/${relative}`
        }

        return entries
      }

      const discoveredEntries = collectEntries(pagesDir)
      if (Object.keys(discoveredEntries).length === 0) return

      let currentManifest = {}
      if (fs.existsSync(manifestPath)) {
        try {
          currentManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        } catch {
          currentManifest = {}
        }
      }

      fs.writeFileSync(
        manifestPath,
        JSON.stringify(
          {
            ...currentManifest,
            ...discoveredEntries,
          },
          null,
          2
        )
      )
    })
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  env: {
    NEXT_PUBLIC_MCP_SERVER_URL: process.env.NEXT_PUBLIC_MCP_SERVER_URL || 'http://localhost:8000',
  },
  webpack: (config, { dev, isServer }) => {
    if (isServer && !dev) {
      config.plugins.push(new EnsureLegacyPagesManifestPlugin())
    }
    return config
  },
}

module.exports = nextConfig
