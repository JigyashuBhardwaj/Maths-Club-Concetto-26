/**
 * When a session ends because the participant left fullscreen, the login page says why. The reason travels as a fixed
 * query value (`?notice=fullscreen`) that only selects a fixed sentence; it is never an authority for anything.
 *
 * The flag is set the moment the fullscreen-exit logout begins, so a 401 seen by the background poll between the
 * server revoking the session and the redirect still lands on the same page with the same notice.
 */
export const FULLSCREEN_NOTICE = "fullscreen";
export const PARTICIPANT_LOGIN = "/login/participant";

let fullscreenEnded = false;

export function markFullscreenEnded(): void {
  fullscreenEnded = true;
}

/** Test seam: the flag lives for the page's lifetime in the browser. */
export function resetFullscreenEnded(): void {
  fullscreenEnded = false;
}

export function participantLoginUrl(): string {
  return fullscreenEnded ? `${PARTICIPANT_LOGIN}?notice=${FULLSCREEN_NOTICE}` : PARTICIPANT_LOGIN;
}

/**
 * A per-tab hint that this page had really entered fullscreen for the signed-in member. It exists for one reason: a
 * reload or a typed address leaves fullscreen (the browser drops it with the document) and the new page has no
 * memory of the old one. If the logout request sent while the old page was unloading was lost (a browser may drop it),
 * the new page finds the hint and ends the session then. `sessionStorage` is per tab and dies with it.
 *
 * It carries the member id from the server's own snapshot (not a secret) and nothing else, and it can only ever make
 * the check stricter: deleting it just means the participant meets the gate again. It never grants anything. Storage
 * can be unavailable (private modes, blocked): then there is no hint, and only the unload-time request applies.
 */
const HINT_KEY = "mc26.fullscreen.member";

export function rememberFullscreen(memberId: string): void {
  try {
    window.sessionStorage.setItem(HINT_KEY, memberId);
  } catch {
    // no storage: the unload-time request is then the only mechanism
  }
}

export function forgetFullscreen(): void {
  try {
    window.sessionStorage.removeItem(HINT_KEY);
  } catch {
    // nothing to forget
  }
}

/** True only if the hint names exactly this member (a leftover from someone else's session on this tab means nothing). */
export function fullscreenWasEstablishedFor(memberId: string): boolean {
  try {
    return window.sessionStorage.getItem(HINT_KEY) === memberId;
  } catch {
    return false;
  }
}
