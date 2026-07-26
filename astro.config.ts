import { defineConfig } from 'astro/config'
import cloudflare from '@astrojs/cloudflare'
import solid from '@astrojs/solid-js'

export default defineConfig({
  output: 'server',
  adapter: cloudflare({ imageService: 'passthrough' }),
  integrations: [solid()],
  vite: { ssr: { external: ['node:buffer'] } },
})
