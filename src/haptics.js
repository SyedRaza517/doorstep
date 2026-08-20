/* Haptic feedback, wrapped so the rest of the app can fire-and-forget.

   Why a plugin at all: navigator.vibrate has never worked in iOS WebKit, so
   any web-only approach leaves half our users with a silent phone. The
   Capacitor plugin bridges to the native haptic engines on both platforms —
   Taptic on iOS, Vibrator on Android — and simply isn't there in a plain
   browser tab.

   Why dynamic import + try/catch: the plugin package only exists once
   `npm install @capacitor/haptics` has run, and even then the native bridge
   only answers inside the packaged app. Importing lazily inside a try/catch
   means a missing package, a desktop browser, or a webview without the
   plugin all degrade to a silent no-op instead of an unhandled rejection —
   a button press must never fail because the buzz couldn't happen. */

export async function tap() {
  try {
    const { Haptics, ImpactStyle } = await import("@capacitor/haptics");
    await Haptics.impact({ style: ImpactStyle.Light });
  } catch {
    /* no haptics here — the press still worked, so say nothing */
  }
}

export async function success() {
  try {
    const { Haptics, NotificationType } = await import("@capacitor/haptics");
    await Haptics.notification({ type: NotificationType.Success });
  } catch {
    /* no haptics here — the celebration on screen carries the moment */
  }
}

export async function select() {
  try {
    const { Haptics } = await import("@capacitor/haptics");
    await Haptics.selectionStart();
    await Haptics.selectionChanged();
    await Haptics.selectionEnd();
  } catch {
    /* no haptics here — the message still sends, silently */
  }
}
