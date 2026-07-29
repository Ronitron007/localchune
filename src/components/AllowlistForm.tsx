// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { createSignal } from 'solid-js'
import StatusRegion from './StatusRegion'

export default function AllowlistForm() {
  const [email, setEmail] = createSignal('')
  const [status, setStatus] = createSignal('')

  const submit = async (e: Event) => {
    e.preventDefault()
    setStatus('adding…')
    const res = await fetch('/api/admin/allowlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: email() }),
    })
    if (res.ok) {
      const j = (await res.json()) as { email: string }
      setStatus(`invited ${j.email}`)
      setEmail('')
      location.reload()
    } else {
      const j = (await res.json().catch(() => ({}))) as { error?: string }
      setStatus(j.error ?? `failed (${res.status})`)
    }
  }

  return (
    <form onSubmit={submit}>
      <input type="email" required placeholder="dj@gmail.com"
             value={email()} onInput={(e) => setEmail(e.currentTarget.value)} />
      <button type="submit" class="btn">Invite</button>
      <StatusRegion message={status()} />
    </form>
  )
}
