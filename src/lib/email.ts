// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com'])

/**
 * Fold an email to the address that actually receives mail, so an allowlist
 * cannot be bypassed with dots or plus-tags on Gmail.
 */
export function normalizeEmail(raw: string): string {
  const trimmed = raw.trim().toLowerCase()
  const parts = trimmed.split('@')
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('invalid email')
  let [local, domain] = parts
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.split('+')[0].replaceAll('.', '')
    domain = 'gmail.com'
    if (!local) throw new Error('invalid email')
  }
  return `${local}@${domain}`
}
