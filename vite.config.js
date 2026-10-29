import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the build works both at a domain root and under
  // the GitHub Pages sub-path (/A2-to-A3/).
  base: './',
})
