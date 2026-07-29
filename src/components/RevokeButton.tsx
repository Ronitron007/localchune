// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { createSignal } from 'solid-js'
import StatusRegion from './StatusRegion'

export default function RevokeButton(props: { email: string }) {
  const [status, setStatus] = createSignal('')

  const revoke = async () => {
    if (!confirm(`Revoke access for ${props.email}?`)) return
    setStatus('revoking…')
    const res = await fetch('/api/admin/allowlist', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: props.email }),
    })
    if (res.ok) {
      setStatus('revoked')
      location.reload()
    } else {
      const j = (await res.json().catch(() => ({}))) as { error?: string }
      setStatus(j.error ?? `failed (${res.status})`)
    }
  }

  return (
    <span>
      <button type="button" class="btn-danger" onClick={revoke}>Revoke</button>
      <StatusRegion message={status()} />
    </span>
  )
}
