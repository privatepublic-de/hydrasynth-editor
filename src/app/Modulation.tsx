// Which params are modulated, shown on their controls, and a context menu to add modulation.
import { useEffect, useMemo, useRef } from 'react'
import { formatValue } from '../params/display'
import { param, type Patch } from '../params/patch'
import { MACROS, destinationOf, freeMacroSlot, freeRoute, modulations, type Modulation } from '../ui/modDestinations'
import { useEditor } from './store'

/** Recomputed once per change of the patch, shared by every control on screen. */
export function useModulations(): Map<string, Modulation[]> {
  const patch = useEditor((s) => s.sync?.patch)
  const revision = useEditor((s) => s.sync?.revision)
  return useMemo(() => (patch ? modulations(patch) : new Map()), [patch, revision])
}

function describe(m: Modulation, patch: Patch): string {
  if (m.kind === 'matrix') {
    const src = param(`modmatrix${m.route}modsource`)
    const depth = param(`modmatrix${m.route}depth`)
    return `Mod matrix route ${m.route}: ${formatValue(src, patch.get(src.key))}, depth ${formatValue(depth, patch.get(depth.key))}`
  }
  const depth = param(`macro${m.macro}depth${m.slot}`)
  const name = patch.macroName(m.macro).slice(0, 8).trim() || `Macro ${m.macro}`
  return `Macro ${m.macro} (${name}), assignment ${m.slot}: depth ${formatValue(depth, patch.get(depth.key))}`
}

const badgeText = (m: Modulation) => (m.kind === 'matrix' ? `R${m.route}` : `M${m.macro}`)

/** One small button per route or macro assignment modulating the param; each jumps to its row. */
export function ModBadges({ paramKey }: { paramKey: string }) {
  const mods = useModulations().get(paramKey)
  const patch = useEditor((s) => s.sync?.patch)
  const reveal = useEditor((s) => s.revealModulation)
  if (!mods?.length || !patch) return null
  return (
    <span className="mod-badges">
      {mods.map((m) => (
        <button
          key={m.kind === 'matrix' ? `r${m.route}` : `m${m.macro}-${m.slot}`}
          type="button"
          className={`mod-badge mod-badge--${m.kind}`}
          title={`Modulated by ${describe(m, patch)}. Click to show it.`}
          // Starts with the badge's own text (R3, M1), so it can be named by what it shows.
          aria-label={`${badgeText(m)}: modulated by ${describe(m, patch)}. Show it.`}
          onClick={() => reveal(m)}
        >
          {badgeText(m)}
        </button>
      ))}
    </span>
  )
}

/** The right-click menu of a param: add a mod-matrix route or macro assignment for it, or go to one. */
export function ParamMenu() {
  const menu = useEditor((s) => s.menu)
  const close = useEditor((s) => s.closeMenu)
  const patch = useEditor((s) => s.sync?.patch)
  const addRoute = useEditor((s) => s.addRoute)
  const addToMacro = useEditor((s) => s.addToMacro)
  const reveal = useEditor((s) => s.revealModulation)
  const mods = useModulations()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && close()
    const escape = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('pointerdown', away)
    window.addEventListener('keydown', escape)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('pointerdown', away)
      window.removeEventListener('keydown', escape)
      window.removeEventListener('resize', close)
    }
  }, [menu, close])

  if (!menu || !patch) return null
  const def = param(menu.key)
  const dest = destinationOf(menu.key)
  const existing = mods.get(menu.key) ?? []
  const route = freeRoute(patch)
  const run = (action: () => void) => () => {
    action()
    close()
  }
  const moveFocus = (e: React.KeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowDown') items[(i + 1) % items.length]?.focus()
    else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length]?.focus()
    else return
    e.preventDefault()
  }
  // Keep the menu on screen near the pointer.
  const left = Math.min(menu.x, window.innerWidth - 280)
  const top = Math.min(menu.y, window.innerHeight - 360)

  return (
    <div ref={ref} className="param-menu" role="menu" aria-label={`${def.labels[0] ?? menu.key} modulation`} style={{ left, top }} onKeyDown={moveFocus}>
      <p className="param-menu__title">{def.labels[0] ?? menu.key}</p>
      {dest === undefined ? (
        <p className="param-menu__note">The synth can’t modulate this parameter.</p>
      ) : (
        <>
          <button type="button" role="menuitem" disabled={route === undefined} onClick={run(() => addRoute(menu.key))}>
            {route === undefined ? 'Mod matrix full (32 routes used)' : `Modulate in the mod matrix (route ${route})`}
          </button>
          {Array.from({ length: MACROS }, (_, i) => i + 1).map((macro) => {
            const slot = freeMacroSlot(patch, macro)
            const name = patch.macroName(macro).slice(0, 8).trim()
            return (
              <button key={macro} type="button" role="menuitem" disabled={slot === undefined} onClick={run(() => addToMacro(menu.key, macro))}>
                Assign to Macro {macro}
                {name ? ` (${name})` : ''}
                {slot === undefined ? ', full' : ''}
              </button>
            )
          })}
        </>
      )}
      {existing.length > 0 && <hr />}
      {existing.map((m) => (
        <button key={badgeText(m) + (m.kind === 'macro' ? m.slot : '')} type="button" role="menuitem" onClick={run(() => reveal(m))}>
          Show {m.kind === 'matrix' ? `route ${m.route}` : `Macro ${m.macro}, assignment ${m.slot}`}
        </button>
      ))}
    </div>
  )
}
