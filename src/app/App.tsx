import { useEffect } from 'react'
import { ModuleEditor } from './ModuleEditor'
import { BackupDialog } from './BackupDialog'
import { RestoreDialog } from './RestoreDialog'
import { ParamMenu } from './Modulation'
import { ModuleSelect } from './ModuleSelect'
import { MidiPort, Pads } from './Pads'
import { PatchHeading } from './PatchHeading'
import { PatchBar } from './PatchBar'
import { useEditor } from './store'

/** The access buttons outside Module Select: Master Control's, the arpeggiator, patch settings. */
const OTHER_MODULES = [
  { id: 'voice', label: 'VOICE' },
  { id: 'macros', label: 'MACRO ASSIGN' },
  { id: 'modmatrix', label: 'MOD MATRIX' },
  { id: 'arp', label: 'ARPEGGIATOR' },
  { id: 'patch', label: 'PATCH' },
]

function MasterButtons() {
  const selected = useEditor((s) => s.module)
  const select = useEditor((s) => s.selectModule)
  return (
    <nav className="master-buttons" aria-label="More modules">
      {OTHER_MODULES.map((m) => (
        <button key={m.id} type="button" className="access-button" aria-pressed={selected === m.id} onClick={() => select(m.id)}>
          {m.label}
        </button>
      ))}
    </nav>
  )
}

/**
 * ⌘Z / Ctrl+Z undoes, ⇧⌘Z / Ctrl+Shift+Z / Ctrl+Y redoes -- except while typing in a text
 * field, where the browser's own text undo applies.
 */
function useUndoKeys() {
  const undo = useEditor((s) => s.undo)
  const redo = useEditor((s) => s.redo)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.isContentEditable || (t.tagName === 'INPUT' && (t as HTMLInputElement).type === 'text') || t.tagName === 'TEXTAREA') return
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      // A modal dialog (backup, restore, write) has the synth or the decision: no edits then.
      if (document.querySelector('dialog[open]')) return
      const k = e.key.toLowerCase()
      if (k === 'z' && !e.shiftKey) undo()
      else if ((k === 'z' && e.shiftKey) || (k === 'y' && e.ctrlKey)) redo()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])
}

export function App() {
  useUndoKeys()
  return (
    <div className="app">
      <PatchBar />
      <div className="panel">
        <PatchHeading />
        <div className="panel__select">
          <ModuleSelect />
          <MasterButtons />
        </div>
        <ModuleEditor />
      </div>
      {/* Pinned to the window's bottom edge, so notes are always at hand while editing. */}
      <footer className="pads-dock">
        <Pads />
        <MidiPort />
      </footer>
      <ParamMenu />
      <BackupDialog />
      <RestoreDialog />
    </div>
  )
}
