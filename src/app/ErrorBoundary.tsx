import { Component, type ReactNode } from 'react'
import { backupFileName, encodeBackup } from '../library/backupFile'
import { download, useEditor } from './store'

/**
 * A render error would otherwise leave a blank page. This says so, and offers the open patch as
 * a file first (the Restore dialog reads it back), since a reload loses unwritten edits.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error(error)
  }

  private savePatch = () => {
    const bytes = useEditor.getState().sync?.patch?.bytes
    if (bytes) download(encodeBackup([{ bank: bytes[2], patch: bytes[3], bytes }]), backupFileName().replace('backup', 'patch'))
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const sync = useEditor.getState().sync
    return (
      <div className="write-dialog error-page" role="alert">
        <h2>Something went wrong</h2>
        <p>The editor ran into an error it can&rsquo;t recover from.</p>
        {sync?.patch && (
          <p>
            {sync.dirty ? 'The patch has changes that aren’t written to the synth yet. ' : ''}
            Save it as a file before reloading; Restore puts it back.
          </p>
        )}
        <details>
          <summary>Error details</summary>
          {/* Chrome's stack starts with the message, Firefox's doesn't. */}
          <pre className="about-dialog__text">
            {error.stack?.includes(error.message) ? error.stack : `${error.message}\n${error.stack ?? ''}`}
          </pre>
        </details>
        <div className="write-dialog__actions">
          {sync?.patch && (
            <button type="button" className="function-button" onClick={this.savePatch}>
              Save the patch as a file
            </button>
          )}
          <button type="button" className="function-button function-button--primary" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </div>
    )
  }
}
