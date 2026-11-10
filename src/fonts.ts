// The families the app draws with. They are defined once, as CSS variables on :root (styles.css for
// the workbench, the landing page's own style block for it), and canvas text reads the same variables.
//
// `ui` and `code` are the workbench's own type (Atkinson Hyperlegible Next and Mono); `label` and
// `mono` are what's printed on the 3D parts.

export type FontRole = 'ui' | 'code' | 'label' | 'mono';

const VARIABLES: Record<FontRole, string> = {
  ui: '--font',
  code: '--mono',
  label: '--font-label',
  mono: '--font-mono',
};

/** The faces the workbench loads (see fonts.css). Canvas text needs them loaded before it is drawn. */
const FACES = [
  '400 16px "Atkinson Hyperlegible Next"',
  '500 16px "Atkinson Hyperlegible Next"',
  '400 16px "Atkinson Hyperlegible Mono"',
  '500 16px "Atkinson Hyperlegible Mono"',
  '400 16px "Barlow Semi Condensed"',
  '500 16px "Barlow Semi Condensed"',
  '600 16px "Barlow Semi Condensed"',
  '400 16px "Sometype Mono"',
  '500 16px "Sometype Mono"',
];

/**
 * Resolves when the faces are ready. Canvas draws text with whatever face is loaded at that moment and
 * never swaps it later, so anything painted on a canvas must wait for this. If the fonts cannot be
 * fetched, the stacks in the CSS variables still apply.
 */
export async function loadFonts(faces: readonly string[] = FACES): Promise<void> {
  try {
    await Promise.all(faces.map((face) => document.fonts.load(face)));
  } catch {
    // Offline or blocked: carry on with the fallback stacks.
  }
  await document.fonts.ready;
}

const families = new Map<FontRole, string>();

/** The font-family list for a role, as written in the CSS variable. */
export function fontFamily(role: FontRole): string {
  let family = families.get(role);
  if (family === undefined) {
    family = getComputedStyle(document.documentElement).getPropertyValue(VARIABLES[role]).trim() || 'sans-serif';
    families.set(role, family);
  }
  return family;
}

/**
 * A canvas `font` value. Only some weights are loaded, so heavier requests are capped; asking for more
 * would make the browser fake a bold face.
 */
export function canvasFont(role: FontRole, weight: number, px: number): string {
  const cap = role === 'mono' || role === 'ui' || role === 'code' ? 500 : 600;
  return `${Math.min(weight, cap)} ${px}px ${fontFamily(role)}`;
}
