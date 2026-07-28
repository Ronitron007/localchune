// src/components/AnalysisFailedRow.tsx
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { Show } from 'solid-js'

/**
 * A file that will not become a track, with the reason the server recorded
 * and an honest statement of whether trying again can help.
 *
 * There is no Retry BUTTON here, and that is deliberate. M2's journal rule
 * is that a discarded row is terminal and a retry needs a fresh `file_id`,
 * which needs the actual File handle — and this component, sitting outside
 * UploadDropzone, does not have one. A button that silently did nothing
 * would be worse than a sentence that says what to do.
 */
const RETRYABLE = new Set(['failed', 'abandoned'])

const EXPLAIN: Record<string, string> = {
  failed: 'The upload did not finish.',
  abandoned: 'This upload sat unfinished for a day and was cleaned up.',
  rejected_duration: 'Longer than the 15-minute limit.',
  rejected_redundant: 'The pool already has this recording at equal or better quality.',
  quarantined: 'Held back: the file is not what its container claims to be.',
}

export default function AnalysisFailedRow(props: {
  name: string
  state: string
  reason: string | null
}) {
  return (
    <li class={`filerow failed ${props.state}`}>
      <span class="name">{props.name}</span>
      <span class="state">{EXPLAIN[props.state] ?? 'This file did not make it.'}</span>
      <Show when={props.reason}>
        <span class="reason" title={props.reason ?? ''}>{props.reason}</span>
      </Show>
      <Show
        when={RETRYABLE.has(props.state)}
        fallback={<span class="advice">Trying again will not change this.</span>}
      >
        <span class="advice">Drop the file again to retry — it uploads as a new file.</span>
      </Show>
    </li>
  )
}
