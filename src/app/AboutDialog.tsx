import { useEffect, useRef } from 'react'
import licenseText from '../../LICENSE?raw'
import noticeText from '../../NOTICE?raw'
import { version } from '../../package.json'

/** The third-party license texts NOTICE refers to, by file name (Apache-2.0.txt, MIT.txt, ...). */
const LICENSE_TEXTS = Object.entries(
  import.meta.glob<string>('../../LICENSES/*.txt', { query: '?raw', import: 'default', eager: true }),
).map(([path, text]) => [path.slice(path.lastIndexOf('/') + 1), text] as const)

/** Who made what the editor is built from, and under which license (NOTICE in full below). */
const CREDITS: { what: string; who: string; license: string; href: string }[] = [
  {
    what: 'SysEx protocol, patch format and parameter tables',
    who: 'reverse engineered by Sean Luke and contributors for Edisyn',
    license: 'Apache License 2.0',
    href: 'https://github.com/eclab/edisyn',
  },
  {
    what: 'Wave pictures and their colours',
    who: 'Thierry Rochebois Zic, cut and inverted by Sean Luke for Edisyn',
    license: 'CC BY 4.0',
    href: 'https://creativecommons.org/licenses/by/4.0/',
  },
  {
    what: 'Pronunciations of the speech patch',
    who: 'CMU Pronouncing Dictionary, Carnegie Mellon University',
    license: 'BSD-style',
    href: 'https://github.com/cmusphinx/cmudict',
  },
  {
    what: 'Speech sound lengths',
    who: 'measured from eSpeak NG’s output (eSpeak NG itself is not included)',
    license: '',
    href: 'https://github.com/espeak-ng/espeak-ng',
  },
  { what: 'Icons', who: 'Lucide Contributors, Cole Bemis (Feather)', license: 'ISC', href: 'https://lucide.dev' },
  { what: 'Fonts Barlow and Barlow Condensed', who: 'The Barlow Project Authors', license: 'SIL OFL 1.1', href: 'https://github.com/jpt/barlow' },
  { what: 'React, React DOM', who: 'Facebook, Inc. (Meta) and its affiliates', license: 'MIT', href: 'https://react.dev' },
  { what: 'Zustand', who: 'Paul Henschel', license: 'MIT', href: 'https://github.com/pmndrs/zustand' },
]

export function AboutDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => ref.current?.showModal(), [])
  return (
    <dialog ref={ref} className="write-dialog about-dialog" onClose={onClose}>
      <h2>Hydrasynth Editor</h2>
      <p className="about-dialog__meta">
        Version {version} · © 2026 Peter Witzel · MIT License
      </p>
      <p>A patch editor for the ASM Hydrasynth over USB MIDI.</p>
      <p>
        Vibe-coded with{' '}
        <a href="https://claude.com/claude-code" target="_blank" rel="noreferrer">
          Claude
        </a>{' '}
        by Anthropic: Peter Witzel designed it and tested it on the synth, Claude wrote the code.
      </p>
      <h3>Built on</h3>
      <ul className="about-dialog__credits">
        {CREDITS.map((c) => (
          <li key={c.what}>
            <a href={c.href} target="_blank" rel="noreferrer">
              {c.what}
            </a>
            : {c.who}
            {c.license && <span className="about-dialog__license"> · {c.license}</span>}
          </li>
        ))}
      </ul>
      <p className="about-dialog__trademark">
        Hydrasynth is a trademark of Ashun Sound Machines (ASM). This editor is not affiliated with or endorsed by ASM.
      </p>
      <details>
        <summary>License</summary>
        <pre className="about-dialog__text">{licenseText}</pre>
      </details>
      <details>
        <summary>Notices in full</summary>
        <pre className="about-dialog__text">{noticeText}</pre>
      </details>
      <details>
        <summary>Third-party license texts</summary>
        {LICENSE_TEXTS.map(([name, text]) => (
          <pre key={name} className="about-dialog__text">
            {`${name}\n\n${text}`}
          </pre>
        ))}
      </details>
      <div className="write-dialog__actions">
        <button type="button" className="function-button function-button--primary" onClick={() => ref.current?.close()} autoFocus>
          Close
        </button>
      </div>
    </dialog>
  )
}
