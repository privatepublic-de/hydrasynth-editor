import { useEffect } from 'react'
import { param, type Patch } from '../params/patch'
import { MODULES, type ModuleLayout, type Page, type Slot } from '../ui/layout'
import { destinationOf } from '../ui/modDestinations'
import { isShown } from '../ui/visibility'
import { ParamControl } from './controls/ParamControl'
import { ModuleDisplay } from './ModuleDisplay'
import { StepEditor } from './StepEditor'
import { WavelistView } from './WavelistView'
import { useEditor } from './store'

/** The Desktop shows 8 characters of a macro name (A5's "FiltAtckMixer" reads "FiltAtck"). */
const MACRO_NAME_SHOWN = 8

/** Captions the synth takes from the patch: macro knobs and buttons are named after their macro. */
function captionFor(key: string, patch: Patch): string | undefined {
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
  // The WaveScan list has its own view: Off gaps, each wave's share, the position.
  const wavelistOsc = title === 'Wavelist' && shown[0]?.match(/^osc(\d)wavscanwave/)?.[1]
  if (wavelistOsc) return <WavelistView osc={Number(wavelistOsc)} />
  return (
    <section className="page">
      <h3 className="page__title">{title}</h3>
      <div className="page__slots">
        {shown.map((key, i) =>
          key === null ? (
            <div key={i} className="control control--empty" aria-hidden="true" />
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
  const keys = rows[0].slots.map((_, i) => rows.map((r) => visibleKey(r.slots[i], patch)).find((k) => k !== null) ?? null)
  const columns = keys.map((key) => (key ? columnName(param(key).labels[0] ?? '') : ''))
  // Fixed column widths, so nothing shifts as dials appear or values grow a digit: where selects
  // share the table, the dial columns get a set width and the selects the rest.
  const mixed = keys.some((k) => k && param(k).widget === 'choice')
  return (
      <table className="param-table">
        <colgroup>
          <col className="param-table__row-head" />
          {keys.map((k, i) => (
            <col
              key={i}
              className={
                mixed && k && param(k).widget !== 'choice'
                  ? // A dial that can be a modulation destination gets room for its badges too.
                    `param-table__dial${destinationOf(k) !== undefined ? ' param-table__dial--badged' : ''}`
                  : undefined
              }
            />
          ))}
        </colgroup>
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
                if (key === null || (unassigned(row, patch) && param(key).widget !== 'choice')) return <td key={i} />
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

/**
 * A mod matrix route or macro slot that doesn't modulate anything yet: a route without a source
 * or a destination, a macro slot without a destination. Its dials do nothing, so they're left
 * out; its selects stay, to assign it.
 */
function unassigned(row: Page, patch: Patch): boolean {
  const keys = row.slots.filter((s): s is string => typeof s === 'string')
  const off = (re: RegExp) => keys.some((k) => re.test(k) && !patch.get(k))
  return off(/^modmatrix\d+mod(source|target)$/) || off(/^macro\d+target\d+$/)
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
