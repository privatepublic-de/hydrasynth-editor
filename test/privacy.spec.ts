import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Published with every push to main (.github/workflows/pages.yml), which runs these tests first.
describe('privacy statement', () => {
  const page = readFileSync(new URL('../public/privacy.html', import.meta.url), 'utf8')

  it('names a contact, not the placeholder', () => {
    expect(page).not.toContain('[CONTACT EMAIL]')
  })

  it('names the browser storage keys the editor uses', () => {
    expect(page).toContain('hydrasynth-editor.channel')
  })
})
