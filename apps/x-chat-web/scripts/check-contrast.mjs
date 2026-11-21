// Static WCAG contrast guard for the colour pairs the UI actually renders.
// Each entry pairs a text colour from public/style.css with the background it
// is drawn on. Large text (>= 24px, or >= 18.66px bold) may use 3:1; everything
// else must reach 4.5:1. Keep this list in sync when adding text styling.

const MIN_NORMAL = 4.5;
const MIN_LARGE = 3;

const pairs = [
  ["body text", "#e8edf5", "#0b1018", MIN_NORMAL],
  ["body text on sidebar", "#e8edf5", "#101822", MIN_NORMAL],
  ["body text on chat panel", "#e8edf5", "#111a27", MIN_NORMAL],
  ["label on panel", "#98a7b9", "#101822", MIN_NORMAL],
  ["label on input", "#98a7b9", "#0c131d", MIN_NORMAL],
  ["hint on sidebar", "#77869a", "#101822", MIN_NORMAL],
  ["hint on chat panel", "#77869a", "#111a27", MIN_NORMAL],
  ["placeholder on input", "#78889c", "#0c131d", MIN_NORMAL],
  ["placeholder on composer", "#78889c", "#0d151f", MIN_NORMAL],
  ["empty list text", "#8493a6", "#101822", MIN_NORMAL],
  ["empty chat text", "#78889c", "#111a27", MIN_NORMAL],
  ["filter chip", "#8593a6", "#101822", MIN_NORMAL],
  ["filter chip pressed", "#a8c8ff", "#192b44", MIN_NORMAL],
  ["primary button", "#ffffff", "#1d4ed8", MIN_NORMAL],
  ["primary button hover", "#ffffff", "#2563eb", MIN_NORMAL],
  ["secondary button", "#c3cedc", "#182332", MIN_NORMAL],
  ["secondary button hover", "#c3cedc", "#202f42", MIN_NORMAL],
  ["danger button", "#f0a8ae", "#2a1b22", MIN_NORMAL],
  ["danger button hover", "#f0a8ae", "#3a202a", MIN_NORMAL],
  ["unlock loading", "#e9bd73", "#101822", MIN_NORMAL],
  ["unlock success", "#75cb9b", "#101822", MIN_NORMAL],
  ["unlock error", "#ee9299", "#101822", MIN_NORMAL],
  ["conversation name", "#edf2f8", "#101822", MIN_NORMAL],
  ["conversation name active", "#edf2f8", "#162943", MIN_NORMAL],
  ["conversation username", "#a4b3c5", "#101822", MIN_NORMAL],
  ["conversation username active", "#a4b3c5", "#162943", MIN_NORMAL],
  ["conversation preview", "#9aa8b9", "#101822", MIN_NORMAL],
  ["conversation preview active", "#9aa8b9", "#162943", MIN_NORMAL],
  ["account avatar", "#c4d9ff", "#1d3556", MIN_NORMAL],
  ["account key status", "#84d3a2", "#142b21", MIN_NORMAL],
  ["settings summary", "#d7e0eb", "#101822", MIN_NORMAL],
  ["settings summary open", "#a9c9ff", "#101822", MIN_NORMAL],
  ["settings paragraph", "#8493a6", "#101822", MIN_NORMAL],
  ["message meta", "#b6c6d9", "#1b2939", MIN_NORMAL],
  ["message meta mine", "#b6c6d9", "#1d4478", MIN_NORMAL],
  ["message unverified meta", "#e0c57f", "#2b261b", MIN_NORMAL],
  ["message content", "#f0f4f9", "#1b2939", MIN_NORMAL],
  ["message content mine", "#f0f4f9", "#1d4478", MIN_NORMAL],
  ["message link", "#9fc7ff", "#1d4478", MIN_NORMAL],
  ["send state", "#95a8c2", "#111a27", MIN_NORMAL],
  ["send state failed", "#f09aa0", "#111a27", MIN_NORMAL],
  ["send state unknown", "#e5bf74", "#111a27", MIN_NORMAL],
  ["send state sent", "#75cb9b", "#111a27", MIN_NORMAL],
  ["encryption note", "#8493a6", "#111a27", MIN_NORMAL],
  ["brand mark (large)", "#ffffff", "#2563eb", MIN_LARGE],
  ["live stream connected", "#75cb9b", "#0b1018", MIN_NORMAL],
  ["live stream pending", "#e5bf74", "#0b1018", MIN_NORMAL],
  ["live stream offline", "#ee9299", "#0b1018", MIN_NORMAL],
];

function channels(hex) {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
}

function luminance(hex) {
  const [r, g, b] = channels(hex).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

let failures = 0;
for (const [name, foreground, background, minimum] of pairs) {
  const value = ratio(foreground, background);
  const ok = value >= minimum;
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${value.toFixed(2).padStart(5)}:1 (min ${minimum}) ${name}`);
}

if (failures > 0) {
  console.error(`\n${failures} contrast pair(s) below the WCAG AA threshold.`);
  process.exit(1);
}
console.log(`\nAll ${pairs.length} contrast pairs pass WCAG AA.`);
