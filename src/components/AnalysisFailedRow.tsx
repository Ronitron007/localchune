// src/components/AnalysisFailedRow.tsx
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { Show } from 'solid-js'
import { RETRYABLE_STATES as RETRYABLE, FAILURE_EXPLAIN as EXPLAIN } from '../lib/file-state'

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
