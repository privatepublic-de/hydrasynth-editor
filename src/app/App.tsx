import { ModuleEditor } from './ModuleEditor'
import { ModuleSelect } from './ModuleSelect'
import { Pads } from './Pads'
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

export function App() {
  return (
    <div className="app">
      <PatchBar />
      <div className="panel">
        <div className="panel__select">
          <ModuleSelect />
          <MasterButtons />
        </div>
        <ModuleEditor />
        <Pads />
      </div>
    </div>
  )
}
