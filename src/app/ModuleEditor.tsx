import { useEffect } from 'react'
import { param, type Patch } from '../params/patch'
import { MODULES, type ModuleLayout, type Page, type Slot } from '../ui/layout'
import { isShown } from '../ui/visibility'
import { isWaveKey, shownEntry, waveImage, waveOf } from '../ui/waves'
import { ParamControl } from './controls/ParamControl'
import { ModuleDisplay } from './ModuleDisplay'
import { StepEditor } from './StepEditor'
import { useEditor } from './store'

/** The Desktop shows 8 characters of a macro name (A5's "FiltAtckMixer" reads "FiltAtck"). */
const MACRO_NAME_SHOWN = 8

/** Captions the synth takes from the patch: macro knobs and buttons are named after their macro. */
function captionFor(key: string, patch: Patch): string | undefined {
  const w = key.match(/^osc\dwavscanwave(\d)$/)
  if (w) return `Wave ${w[1]}`
  const m = key.match(/^macro(\d)panel(value|buttonstate)$/)
  if (!m) return undefined
  const name = patch.macroName(+m[1]).slice(0, MACRO_NAME_SHOWN).trim() || `Macro ${m[1]}`
  return m[2] === 'value' ? name : `${name} button`
}

function MacroName({ macro }: { macro: number }) {
  const name = useEditor((s) => s.sync?.patch?.macroName(macro) ?? '')
  const setMacroName = useEditor((s) => s.setMacroName)
  return (
    <input
      className="macro-name"
      aria-label={`Macro ${macro} name`}
      maxLength={MACRO_NAME_SHOWN}
      value={name.slice(0, MACRO_NAME_SHOWN)}
      onChange={(e) => setMacroName(macro, e.target.value)}
    />
  )
}

/**
 * A wavelist slot's picture: a button that shows the wave large in the display (again: back
 * to following the WaveScan position). The slot number sits in its corner.
 */
function WaveThumb({ patch, paramKey }: { patch: Patch; paramKey: string }) {
  const m = paramKey.match(/^osc(\d)wavscanwave(\d)$/)!
  const osc = `osc${m[1]}`
  const slot = +m[2]
  const picked = useEditor((s) => s.waveView[osc])
  const setWaveView = useEditor((s) => s.setWaveView)
  const wave = waveOf(paramKey, patch.get(paramKey))
  const shown = shownEntry(patch, +m[1], picked)?.slot === slot
  const badge = <span className="wave-thumb__slot">{slot}</span>
  if (wave === null) {
    return (
      <div className="wave-thumb wave-thumb--off">
        {badge}Off
      </div>
    )
  }
  return (
    <button
      type="button"
      className={`wave-thumb${shown ? ' is-shown' : ''}${wave === 'silence' ? ' wave-thumb--off' : ''}`}
      aria-label={`Show wave ${slot} in the display`}
      aria-pressed={shown}
      onClick={() => setWaveView(osc, picked === slot ? undefined : slot)}
    >
      {badge}
      {wave === 'silence' ? 'Silence' : <img src={waveImage(wave)} alt="" />}
    </button>
  )
}

/**
 * The key a slot shows right now: the alternative whose mode is active, or null when none is
 * (an FX knob under Bypass, which has no parameters).
 */
function activeKey(slot: Exclude<Slot, null>, isActive: (key: string) => boolean): string | null {
  if (typeof slot === 'string') return slot
  return slot.find(isActive) ?? null
}

/** The key to show for a slot, or null for an empty knob position. */
function visibleKey(slot: Slot, patch: Patch): string | null {
  if (slot === null) return null
  const key = activeKey(slot, (k) => patch.isActive(param(k)))
  return key !== null && isShown(key, patch) ? key : null
}

function PageView({ title, slots }: { title: string; slots: Slot[] }) {
  const patch = useEditor((s) => s.sync?.patch)
  useEditor((s) => s.sync?.revision)
  if (!patch) return null
  const shown = slots.map((slot) => visibleKey(slot, patch))
  if (shown.every((k) => k === null)) return null
  return (
    <section className="page">
      <h3 className="page__title">{title}</h3>
      <div className="page__slots">
        {shown.map((key, i) =>
          key === null ? (
            <div key={i} className="control control--empty" aria-hidden="true" />
          ) : isWaveKey(key) && /wavscanwave/.test(key) ? (
            <div key={i} className="wave-slot">
              <WaveThumb patch={patch} paramKey={key} />
              {/* The picture names the wave; the caption is for screen readers only. */}
              <ParamControl paramKey={key} label="" />
            </div>
          ) : (
            <ParamControl key={i} paramKey={key} label={captionFor(key, patch)} />
          ),
        )}
      </div>
    </section>
  )
}

/** Consecutive pages sharing a `table` title become one grid: rows = pages, columns = knobs. */
function TableView({ title, rows }: { title: string; rows: Page[] }) {
  const patch = useEditor((s) => s.sync?.patch)
  useEditor((s) => s.sync?.revision)
  if (!patch) return null
  const visibleRows = rows.filter((row) => row.slots.some((slot) => visibleKey(slot, patch) !== null))
  if (visibleRows.length === 0) return null
  rows = visibleRows
  const steps = title === 'Step Edit' && firstKey(rows)?.match(/^lfo(\d)step/)
  if (steps) {
    return (
      <section className="page page--wide">
        <h3 className="page__title">{title}</h3>
        <StepEditor lfo={Number(steps[1])} />
      </section>
    )
  }
  // A long table (the 32 mod-matrix routes) in two halves side by side.
  if (rows.length > SPLIT_ROWS) {
    const half = Math.ceil(rows.length / 2)
    return (
      <section className="page page--wide">
        <h3 className="page__title">{title}</h3>
        <div className="param-table-halves">
          <ParamTable rows={rows.slice(0, half)} />
          <ParamTable rows={rows.slice(half)} />
        </div>
      </section>
    )
  }
  return (
    <section className="page page--table">
      <h3 className="page__title">
        {title}
        {/^Macro \d$/.test(title) && <MacroName macro={Number(title.slice(6))} />}
      </h3>
      <ParamTable rows={rows} />
    </section>
  )
}

const SPLIT_ROWS = 16

function firstKey(rows: Page[]): string | undefined {
  const slot = rows[0]?.slots.find((s) => s !== null)
  return slot === undefined || slot === null ? undefined : typeof slot === 'string' ? slot : slot[0]
}

function ParamTable({ rows }: { rows: Page[] }) {
  const patch = useEditor((s) => s.sync?.patch)!
  const columns = rows[0].slots.map((_, i) => {
    const key = rows.map((r) => visibleKey(r.slots[i], patch)).find((k) => k !== null)
    return key ? columnName(param(key).labels[0] ?? '') : ''
  })
  return (
      <table className="param-table">
        <thead>
          <tr>
            <th scope="col" />
            {columns.map((c, i) => (
              <th key={i} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} data-keys={row.slots.flatMap((sl) => (sl === null ? [] : typeof sl === 'string' ? [sl] : sl)).join(' ')}>
              <th scope="row">{row.title.replace(/^Macro \d /, '')}</th>
              {row.slots.map((slot, i) => {
                const key = visibleKey(slot, patch)
                if (key === null) return <td key={i} />
                const label = param(key).labels[0] ?? key
                return (
                  <td key={i}>
                    <ParamControl paramKey={key} label={rows.length > 1 ? '' : label} />
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
  )
}

/** A column heading from the first row's label: "Target 1" -> "Target", "Step 9" -> "Step". */
const columnName = (label: string) => label.replace(/\s*\d+$/, '')

type Block = { kind: 'page'; page: Page } | { kind: 'table'; title: string; rows: Page[] }

function blocks(pages: Page[]): Block[] {
  const out: Block[] = []
  for (const page of pages) {
    const last = out.at(-1)
    if (page.table && last?.kind === 'table' && last.title === page.table) last.rows.push(page)
    else if (page.table) out.push({ kind: 'table', title: page.table, rows: [page] })
    else out.push({ kind: 'page', page })
  }
  return out
}

/** Scrolls to the row a modulation badge or menu asked for, highlights it, and focuses into it. */
function useRevealedRow() {
  const reveal = useEditor((s) => s.reveal)
  useEffect(() => {
    if (!reveal) return
    const row = document.querySelector<HTMLElement>(`tr[data-keys~="${reveal.rowKey}"]`)
    if (!row) return
    row.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    row.classList.remove('is-revealed')
    void row.offsetWidth // restart the highlight when the same row is shown again
    row.classList.add('is-revealed')
    const focus = reveal.focusKey && row.querySelector<HTMLElement>(`[data-param="${reveal.focusKey}"] select, [data-param="${reveal.focusKey}"] [role="slider"]`)
    ;(focus || row.querySelector<HTMLElement>('select, [role="slider"]'))?.focus({ preventScroll: true })
  }, [reveal])
}

export function ModuleEditor() {
  const id = useEditor((s) => s.module)
  const hasPatch = useEditor((s) => !!s.sync?.patch)
  const module: ModuleLayout | undefined = MODULES.find((m) => m.id === id)
  useRevealedRow()
  if (!hasPatch) {
    return (
      <section className="module-editor module-editor--empty">
        <p>Open a patch from the synth to edit it. Its sound changes on the synth as you turn the controls here.</p>
      </section>
    )
  }
  if (!module) return null
  return (
    <section className="module-editor" aria-label={module.label}>
      <h2 className="module-editor__title">{module.label}</h2>
      <div className="module-editor__pages">
        <ModuleDisplay module={module.id} />
        {blocks(module.pages).map((b, i) =>
          b.kind === 'page' ? (
            <PageView key={`${id}-${i}`} title={b.page.title} slots={b.page.slots} />
          ) : (
            <TableView key={`${id}-${i}`} title={b.title} rows={b.rows} />
          ),
        )}
      </div>
    </section>
  )
}
