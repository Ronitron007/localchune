// src/components/StatusRegion.tsx
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/**
 * The shared aria-live status region. AllowlistForm, RevokeButton and
 * UploadDropzone each grew their own; this is the one.
 *
 * The element is ALWAYS in the DOM, empty or not. A live region created at
 * the same moment its text appears is frequently never announced — assistive
 * technology has to be observing the region *before* the change happens.
 * UploadDropzone's `<Show when={notice() !== ''}>` wrapper had exactly that
 * bug, which is the reason this component renders unconditionally.
 */
export default function StatusRegion(props: {
  message: string
  tone?: 'info' | 'error'
}) {
  return (
    <span
      class={`status ${props.tone ?? 'info'}`}
      role={props.tone === 'error' ? 'alert' : 'status'}
      aria-live={props.tone === 'error' ? 'assertive' : 'polite'}
    >
      {props.message}
    </span>
  )
}
