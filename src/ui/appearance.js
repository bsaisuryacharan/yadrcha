// Appearance sheet: theme cards (each a live miniature of the app in that
// palette) and accent swatches.

import { ACCENTS, AUTO, THEMES, accentFor, onTheme, prefs, resolvedTheme, setAccent, setTheme, themeById } from '../theme.js';
import { h, haptic, icon } from '../util.js';
import { openSheet } from './overlay.js';

/** A miniature of the Home screen painted with one theme's colours. */
function miniApp(theme, accent) {
  const v = {
    '--p-bg': theme.bg, '--p-s': theme.surface, '--p-s2': theme.surface2,
    '--p-fg': theme.fg, '--p-fg3': theme.fg3, '--p-ac': accent,
  };
  return h('div.tp', { style: v, 'aria-hidden': 'true' },
    h('div.tp-hero', h('i.tp-dot')),
    h('div.tp-line.w60'),
    h('div.tp-row', h('i.tp-thumb'), h('div.tp-text', h('i.w80'), h('i.w50'))),
    h('div.tp-row', h('i.tp-thumb.b'), h('div.tp-text', h('i.w70'), h('i.w40'))),
    h('div.tp-tab', h('i'), h('i'), h('b'), h('i'), h('i')));
}

function themeCard(id) {
  const current = prefs();
  const on = current.theme === id;
  let preview, name, blurb;
  if (id === 'auto') {
    const day = themeById(AUTO.light), night = themeById(AUTO.dark);
    preview = h('div.tp-split',
      miniApp(night, accentFor(night).color),
      h('div.tp-half', miniApp(day, accentFor(day).color)));
    name = 'Auto';
    blurb = 'Follows your phone: Cool White by day, Midnight at night';
  } else {
    const t = themeById(id);
    preview = miniApp(t, accentFor(t).color);
    name = t.name;
    blurb = t.blurb;
  }
  return h('button.theme-card' + (on ? '.on' : ''), {
    type: 'button', 'aria-pressed': on ? 'true' : 'false', 'aria-label': `${name} theme`,
    onclick: (e) => {
      haptic(12);
      setTheme(id, { x: e.clientX || innerWidth / 2, y: e.clientY || innerHeight / 2 });
    },
  },
  h('div.tc-frame', preview, on ? h('span.tc-check', icon('check')) : null),
  h('div.tc-name', name, id === 'cloud' ? h('span.tc-tag', '2026') : null),
  h('div.tc-blurb', blurb));
}

function accentSwatch(a) {
  const current = prefs();
  const on = current.accent === a.id;
  const sw = h('span.sw');
  if (a.id === 'album') {
    sw.classList.add('album');
    sw.append(icon('album'));
  } else {
    sw.style.background = a.id === 'theme' ? 'var(--theme-accent)' : a.hex;
  }
  return h('button.accent' + (on ? '.on' : ''), {
    type: 'button', 'aria-pressed': on ? 'true' : 'false',
    onclick: () => { haptic(10); setAccent(a.id); },
  }, sw, h('small', a.name));
}

export function openAppearance() {
  openSheet((body) => {
    const render = () => {
      const { accent } = prefs();
      body.replaceChildren(
        h('div.sheet-title', 'Theme'),
        h('div.theme-grid', ['auto', ...THEMES.map((t) => t.id)].map(themeCard)),
        h('div.sheet-title', 'Accent'),
        h('div.accents', ACCENTS.map(accentSwatch)),
        h('p.appearance-note', accent === 'album'
          ? 'The app takes its colour from each song’s cover art and morphs as the music changes.'
          : 'Accents are re-tuned for every theme so text and buttons stay readable (WCAG AA contrast).'),
      );
      // "Signature" swatch shows the current theme's own accent.
      body.style.setProperty('--theme-accent', accentFor(resolvedTheme(), 'theme').color);
    };
    render();
    // Redraw on every theme/accent change (also when the system flips under
    // "Auto"); during a theme switch this lands in the transition's new frame.
    const off = onTheme(render);
    const obs = new MutationObserver(() => { if (!body.isConnected) { off(); obs.disconnect(); } });
    obs.observe(document.getElementById('sheets'), { childList: true });
    return h('div.sheet-head',
      h('span.appearance-icon', icon('palette')),
      h('div', h('h3', 'Appearance'), h('div.row-sub', 'Themes & accent colours')));
  }, { name: 'appearance' });
}
