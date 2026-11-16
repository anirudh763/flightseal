export function isStandaloneMode(windowObject = globalThis.window) {
  return !!(windowObject?.navigator?.standalone || windowObject?.matchMedia?.('(display-mode: standalone)')?.matches);
}

export function detectInstallKind(navigatorObject = globalThis.navigator, windowObject = globalThis.window) {
  if (!navigatorObject || !windowObject || isStandaloneMode(windowObject)) return 'none';
  const userAgent = navigatorObject.userAgent || '';
  const ios = /iPhone|iPad|iPod/i.test(userAgent) || (navigatorObject.platform === 'MacIntel' && navigatorObject.maxTouchPoints > 1);
  const safari = /Safari/i.test(userAgent) && !/(CriOS|FxiOS|EdgiOS|OPiOS|Chrome|Chromium|Edg)/i.test(userAgent);
  return ios && safari ? 'ios' : 'none';
}

export async function invokeInstallPrompt(promptEvent) {
  if (!promptEvent || typeof promptEvent.prompt !== 'function') return 'unavailable';
  await promptEvent.prompt();
  const choice = await promptEvent.userChoice;
  return choice?.outcome === 'accepted' ? 'accepted' : 'dismissed';
}

export async function invokeNativeShare(data, navigatorObject = globalThis.navigator) {
  if (!navigatorObject?.share) return false;
  if (navigatorObject.canShare && !navigatorObject.canShare(data)) return false;
  await navigatorObject.share(data);
  return true;
}
