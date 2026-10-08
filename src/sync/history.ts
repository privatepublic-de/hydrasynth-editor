// Undo/redo for a patch as snapshots of its bytes (2790 B each, so 200 steps are ~0.5 MB).

export interface Snapshot {
  bytes: Uint8Array
  /** PatchSync's values of the modes not selected (they live outside the bytes). */
  inactive: [string, number][]
}

interface Step {
  snapshot: Snapshot
  label: string
}

/** Changes to the same param this close together are one step (a dial drag, a dragged handle). */
export const COALESCE_MS = 1000

export class History {
  private undoStack: Step[] = []
  private redoStack: Step[] = []
  private last: { key: string; at: number } | null = null
  /** An open group: everything recorded until it ends is one step (label: the group's, or the first change's). */
  private openGroup: { label: string | null; recorded: boolean } | null = null

  constructor(
    private readonly limit = 200,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Forget everything (a newly opened patch). */
  reset() {
    this.undoStack = []
    this.redoStack = []
    this.last = null
  }

  /**
   * Call before changing `key`, with the state as it is before the change. Starts a new step
   * unless it continues the current one: the same key within COALESCE_MS, or inside `grouped`.
   */
  record(before: () => Snapshot, key: string, label: string) {
    const t = this.now()
    if (this.openGroup) {
      if (!this.openGroup.recorded) {
        this.push({ snapshot: before(), label: this.openGroup.label ?? label })
        this.openGroup.recorded = true
      }
      return
    }
    if (!(this.last && this.last.key === key && t - this.last.at < COALESCE_MS)) this.push({ snapshot: before(), label })
    this.last = { key, at: t }
  }

  /** Every change made inside `body` becomes one step called `label`. */
  grouped<T>(label: string, body: () => T): T {
    if (this.openGroup) return body()
    this.openGroup = { label, recorded: false }
    try {
      return body()
    } finally {
      this.openGroup = null
      this.last = null
    }
  }

  /**
   * A pointer gesture (a drag from press to release) is one step however many params it
   * moves, named after the first. Calls while one is open are ignored.
   */
  beginGesture() {
    this.openGroup ??= { label: null, recorded: false }
  }

  endGesture() {
    this.openGroup = null
    this.last = null
  }

  /** The state to go back to, given the current one; null if there is nothing to undo. */
  undo(current: Snapshot): Snapshot | null {
    const step = this.undoStack.pop()
    if (!step) return null
    this.redoStack.push({ snapshot: current, label: step.label })
    this.last = null
    return step.snapshot
  }

  redo(current: Snapshot): Snapshot | null {
    const step = this.redoStack.pop()
    if (!step) return null
    this.undoStack.push({ snapshot: current, label: step.label })
    this.last = null
    return step.snapshot
  }

  get undoLabel(): string | null {
    return this.undoStack.at(-1)?.label ?? null
  }

  get redoLabel(): string | null {
    return this.redoStack.at(-1)?.label ?? null
  }

  private push(step: Step) {
    this.undoStack.push(step)
    if (this.undoStack.length > this.limit) this.undoStack.shift()
    this.redoStack = []
  }
}
