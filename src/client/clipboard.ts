/** Sharing copy chain: Clipboard API → legacy copy → exact payload for manual copy. Never reads the clipboard. */
export type CopyFailureKind = 'unavailable' | 'unfocused' | 'denied' | 'security' | 'write-failed'
export interface CopyFailure {
  readonly kind: CopyFailureKind
  /** Exception class only; raw messages may contain user data and are never shown/logged. */
  readonly errorName: string | null
}
export type ShareCopyResult =
  | { readonly ok: true; readonly method: 'clipboard' | 'legacy' }
  | { readonly ok: false; readonly payload: string; readonly failure: CopyFailure; readonly legacyErrorName: string | null }

export interface CopyEnvironment {
  readonly navigator: { readonly clipboard?: { writeText(text: string): Promise<void> } }
  readonly document: Document
}

function errorName(error: unknown): string | null {
  if (error === null || typeof error !== 'object') return null
  const name = (error as { name?: unknown }).name
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(name) ? name : null
}

function copyFailure(error: unknown, doc: Document): CopyFailure {
  const name = errorName(error)
  // Focus is a directly observed condition, not a diagnosis of OS clipboard health.
  if (typeof doc.hasFocus === 'function' && !doc.hasFocus()) return { kind: 'unfocused', errorName: name }
  const kind = name === 'NotAllowedError' ? 'denied' : name === 'SecurityError' ? 'security' : 'write-failed'
  return { kind, errorName: name }
}

/** Preserve the user's draft/caret/selection while trying the legacy browser copy command. */
function legacyCopy(payload: string, doc: Document): { ok: boolean; errorName: string | null } {
  if (typeof doc.execCommand !== 'function' || doc.body === null) return { ok: false, errorName: null }
  const active = doc.activeElement as HTMLElement | null
  const input = active as HTMLInputElement | HTMLTextAreaElement | null
  const start = input?.selectionStart
  const end = input?.selectionEnd
  const direction = input?.selectionDirection
  const selection = doc.getSelection()
  const ranges = selection === null ? [] : Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange())
  const field = doc.createElement('textarea')
  field.value = payload
  field.readOnly = true
  field.tabIndex = -1
  field.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;'
  try {
    doc.body.appendChild(field)
    field.focus({ preventScroll: true })
    field.select()
    field.setSelectionRange(0, payload.length)
    return { ok: doc.execCommand('copy') === true, errorName: null }
  } catch (error) {
    return { ok: false, errorName: errorName(error) }
  } finally {
    field.remove()
    // Restoring a detached input or a browser-managed range can throw. A
    // restoration failure must not turn a successful copy into a reported failure.
    try {
      active?.focus({ preventScroll: true })
      if (typeof start === 'number' && typeof end === 'number' && typeof input?.setSelectionRange === 'function') {
        input.setSelectionRange(start, end, direction ?? undefined)
      } else if (selection !== null) {
        selection.removeAllRanges()
        for (const range of ranges) selection.addRange(range)
      }
    } catch { /* best effort: detached focus target/range */ }
  }
}

/** Only a confirmed write reports success. Both automatic failures retain the exact original JSON. */
export async function copyShareText(
  payload: string,
  environment: CopyEnvironment = { navigator, document },
  isCurrent: () => boolean = () => true,
): Promise<ShareCopyResult> {
  let failure: CopyFailure
  try {
    const clipboard = environment.navigator.clipboard
    if (typeof clipboard?.writeText === 'function') {
      await clipboard.writeText(payload)
      return { ok: true, method: 'clipboard' }
    }
    failure = { kind: 'unavailable', errorName: null }
  } catch (error) {
    failure = copyFailure(error, environment.document)
  }
  // The caller may have changed session/unmounted or begun a newer share
  // while writeText was pending. Never copy/steal focus on its obsolete behalf.
  // A native write already handed to the browser is not cancellable.
  if (!isCurrent()) return { ok: false, payload, failure, legacyErrorName: null }
  let fallback: { ok: boolean; errorName: string | null }
  try { fallback = legacyCopy(payload, environment.document) }
  catch (error) { fallback = { ok: false, errorName: errorName(error) } }
  return fallback.ok ? { ok: true, method: 'legacy' } : { ok: false, payload, failure, legacyErrorName: fallback.errorName }
}
