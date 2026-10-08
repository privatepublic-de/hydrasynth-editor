import { param, type Patch } from '../params/patch'
import { MODULES, type ModuleLayout, type Page, type Slot } from '../ui/layout'
import { isShown } from '../ui/visibility'
import { ParamControl } from './controls/ParamControl'
import { ModuleDisplay } from './ModuleDisplay'
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

/** The key a slot shows right now: the alternative whose mode is active. */
function activeKey(slot: Exclude<Slot, null>, isActive: (key: string) => boolean): string {
  if (typeof slot === 'string') return slot
  return slot.find(isActive) ?? slot[0]
}

function PageView({ title, slots }: { title: string; slots: Slot[] }) {
  const patch = useEditor((s) => s.sync?.patch)
  useEditor((s) => s.sync?.revision)
  if (!patch) return null
  const isActive = (key: string) => patch.isActive(param(key))
  const shown = slots.map((slot) => (slot === null ? null : activeKey(slot, isActive))).map((k) => (k && isShown(k, patch) ? k : null))
  if (shown.every((k) => k === null)) return null
  return (
    <section className="page">
      <h3 className="page__title">{title}</h3>
      <div className="page__slots">
        {shown.map((key, i) =>
          key === null ? <div key={i} className="control control--empty" aria-hidden="true" /> : <ParamControl key={i} paramKey={key} label={captionFor(key, patch)} />,
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
  const isActive = (key: string) => patch.isActive(param(key))
  const visibleRows = rows.filter((row) => row.slots.some((slot) => slot !== null && isShown(activeKey(slot, isActive), patch)))
  if (visibleRows.length === 0) return null
  rows = visibleRows
  const columns = rows[0].slots.map((slot) => (slot === null ? '' : columnName(param(activeKey(slot, isActive)).labels[0] ?? '')))
  return (
    <section className="page page--table">
      <h3 className="page__title">
        {title}
        {/^Macro \d$/.test(title) && <MacroName macro={Number(title.slice(6))} />}
      </h3>
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
            <tr key={r}>
              <th scope="row">{row.title}</th>
              {row.slots.map((slot, i) => {
                const key = slot === null ? null : activeKey(slot, isActive)
                if (key === null || !isShown(key, patch)) return <td key={i} />
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
    </section>
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

export function ModuleEditor() {
  const id = useEditor((s) => s.module)
  const hasPatch = useEditor((s) => !!s.sync?.patch)
  const module: ModuleLayout | undefined = MODULES.find((m) => m.id === id)
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
      <div className="module-editor__head">
        <h2 className="module-editor__title">{module.label}</h2>
        <ModuleDisplay module={module.id} />
      </div>
      <div className="module-editor__pages">
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
