import './styles.css';
import { loadFonts } from './fonts';
import { nextPaint, paintChrome, startLoading, webglAvailable } from './loading';

const TOUCH_OK = 'bredbord.touchOk';

/** A phone or tablet: a touch screen with no mouse. Touch works, but it's new and not everything does yet. */
function onTouch(): boolean {
  return matchMedia('(pointer: coarse)').matches;
}

function start(): void {
  const loading = startLoading();
  // Canvas text (part labels, the scope and meter faces) is drawn during boot, so the fonts must be in first.
  if (!webglAvailable()) loading.fail('3d');
  else
    void loadFonts()
      // Let the loader's animations reach the screen before building the desk keeps the page busy.
      .then(nextPaint)
      .then(() => import('./boot'))
      // Opening a circuit from its page: the loader stays until it's in, so the last one doesn't flash first.
      .then((boot) => boot.ready)
      .then(
        () => loading.done(),
        (error: unknown) => {
          console.error(error);
          loading.fail('load');
        },
      );
}

// Play runs on the circuit's own page now; an old /app/?play=<code> link goes there.
const played = new URLSearchParams(location.search).get('play');
if (played && /^[A-Za-z0-9_-]{4,64}$/.test(played)) location.replace(`/c/${played}`);
else begin();

function begin(): void {
  paintChrome();

  let touchOk = false;
  try {
    touchOk = localStorage.getItem(TOUCH_OK) === '1';
  } catch {
    // Storage blocked: ask each time.
  }
  // On an Android phone or tablet, once: point to the app. Anywhere else, straight in.
  if (!onTouch() || !/Android/i.test(navigator.userAgent) || touchOk) start();
  else {
    const ask = document.getElementById('phone')!;
    ask.classList.add('open');
    const go = (): void => {
      try {
        localStorage.setItem(TOUCH_OK, '1');
      } catch {
        // Not remembered, then.
      }
      ask.classList.remove('open');
      start();
    };
    // Getting the app opens its page in a new tab; the website carries on loading here behind it.
    ask.querySelectorAll('[data-phone]').forEach((b) => b.addEventListener('click', go));
  }
}
