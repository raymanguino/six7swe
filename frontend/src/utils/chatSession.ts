const STORAGE_KEY = 'six7swe.chatSessionId';

/**
 * A random id for this browser tab's chat session, kept in `sessionStorage`
 * so it lasts until the tab closes. The backend passes it to the knowledge
 * service, which counts distinct sessions asking a question before it joins
 * the chat eval set; it stores only a hash of it.
 *
 * Undefined when storage or `crypto.randomUUID` is unavailable (a private
 * mode that blocks storage, or a non-secure origin): chat works the same, the
 * question is just not counted.
 */
export function getChatSessionId(): string | undefined {
  try {
    const existing = window.sessionStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
    if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') return undefined;
    const id = crypto.randomUUID();
    window.sessionStorage.setItem(STORAGE_KEY, id);
    return id;
  } catch {
    return undefined;
  }
}
