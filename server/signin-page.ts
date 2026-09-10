/**
 * The two pages the front door serves itself: the sign-in gate, and the
 * signed-in holding page.
 *
 * These are NOT part of the Vite app. They are served by the front door before
 * a session exists, which is exactly when the app is unreachable, so they are
 * self-contained: inline CSS, inline JS, no imports, no build step.
 *
 * FONTS ARE SELF-HOSTED, and that is a project rule rather than a preference.
 * src/styles.css records why: a previous version pulled its faces from Google
 * Fonts over an @import, which handed Google an IP, a user-agent and a referer
 * on every boot of a kiosk that runs 24/7 and on every visit to the public
 * demo. This page reaches the internet for exactly one thing — plex.tv, to sign
 * in — and nothing else.
 *
 * Written portrait-first. A phone is a first-class viewer in this fork, and
 * this is the first screen anyone sees on one.
 *
 * THE PIN CODE IS DELIBERATELY NOT SHOWN. `createPin` asks for a strong code,
 * which is ~25 characters — and strong codes cannot be typed into plex.tv/link,
 * which is the only reason a person would ever want to read one. Displaying it
 * gave a wrapped wall of characters that looked like something to act on and
 * was not. The link is the whole mechanism; the code is an implementation
 * detail of it.
 */

const BLUE = '#1a49c2';   // HALCYON_BLUE  — src/logo-spec.ts
const CREAM = '#f2e8c9';  // HALCYON_CREAM — wordmark ink / print stock
const INK = '#0d1018';

/** Escape anything interpolated into the document. */
function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

const SHARED_CSS = `
  @font-face {
    font-family: 'Archivo Black';
    src: url('/signin/archivo-black.ttf') format('truetype');
    font-weight: 400; font-style: normal; font-display: swap;
  }
  *, *::before, *::after { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: ${INK};
    color: ${CREAM};
    font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    display: flex; align-items: center; justify-content: center;
    padding: 24px;
    /* The store's own light: a warm pool from above, brick-dark at the edges. */
    background-image:
      radial-gradient(120% 90% at 50% -10%, rgba(26,73,194,.22), transparent 60%),
      radial-gradient(80% 60% at 50% 110%, rgba(242,232,201,.06), transparent 70%);
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: 100%; max-width: 26rem;
    background: #12161f;
    border: 1px solid rgba(242,232,201,.14);
    border-radius: 6px;
    padding: 30px 26px 26px;
    box-shadow: 0 24px 60px rgba(0,0,0,.55);
  }
  /* The board over the door. */
  .sign {
    background: ${BLUE};
    border: 3px solid ${CREAM};
    border-radius: 5px;
    padding: 14px 16px 12px;
    text-align: center;
    margin: 0 0 22px;
  }
  .sign b {
    display: block;
    font-family: 'Archivo Black', 'Arial Black', sans-serif;
    font-size: clamp(26px, 9vw, 36px);
    line-height: .94; letter-spacing: .012em; color: ${CREAM};
  }
  .sign span {
    display: block; margin-top: 5px;
    font-size: 11px; letter-spacing: .34em; text-transform: uppercase;
    color: rgba(242,232,201,.82);
  }
  h1 {
    font-family: 'Archivo Black', 'Arial Black', sans-serif;
    font-size: 19px; line-height: 1.25; margin: 0 0 8px; text-wrap: balance;
  }
  p { margin: 0 0 14px; color: rgba(242,232,201,.74); font-size: 14.5px; }
  p.tight { margin-bottom: 8px; }
  a.btn, button.btn {
    display: block; width: 100%;
    font: inherit; font-weight: 600; text-align: center; text-decoration: none;
    padding: 13px 16px; border-radius: 4px; cursor: pointer;
    background: ${CREAM}; color: ${INK}; border: 0;
    transition: transform .06s ease, filter .12s ease;
  }
  a.btn:hover, button.btn:hover { filter: brightness(1.08); }
  a.btn:active, button.btn:active { transform: translateY(1px); }
  a.btn:focus-visible, button.btn:focus-visible { outline: 3px solid ${BLUE}; outline-offset: 2px; }
  .btn[aria-disabled="true"], .btn:disabled { opacity: .5; pointer-events: none; }
  .muted { font-size: 12.5px; color: rgba(242,232,201,.5); margin: 14px 0 0; }
  .err {
    background: rgba(190,60,46,.16); border: 1px solid rgba(230,120,105,.42);
    color: #ffcfc6; border-radius: 4px; padding: 12px 14px;
    font-size: 14px; margin: 0 0 14px;
  }
  .ok { color: #9fd9b6; }
  [hidden] { display: none !important; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

/**
 * The link preview.
 *
 * THIS PAGE IS THE ONLY THING A CRAWLER EVER SEES. When the owner pastes the
 * tunnel URL into a chat, Discord/Slack/iMessage/WhatsApp fetch it with no
 * cookie and no Plex account — so they land here, on the gate, not in the
 * store. Cards therefore belong on this page and nowhere else; og:image tags
 * inside the app would be behind the very gate the crawler cannot pass.
 *
 * `origin` is built from the request's own Host header (server/index.ts),
 * because this process has no idea what public name it is reached by — the
 * tunnel terminates elsewhere. Absolute URLs are not optional here: Twitter
 * and iMessage both ignore a relative og:image outright.
 *
 * `noindex` stays. A card in a chat window is a person being invited; a search
 * result is a stranger finding a login page for someone's private library.
 * They are not the same thing, and og tags do not imply the second.
 */
function shareTags(origin: string): string {
  if (!origin) return '';
  const img = `${origin}/signin/share.png`;
  const desc = 'Browse a Plex library the way you browsed a video shop in 1996 — '
    + 'aisles, shelves, clamshell cases. Members only: sign in with Plex.';
  return `
<meta property="og:type" content="website">
<meta property="og:site_name" content="VolkBuster Video">
<meta property="og:title" content="VolkBuster Video">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(origin)}/">
<meta property="og:image" content="${esc(img)}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="VolkBuster Video — your Plex library, as a video store">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="VolkBuster Video">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(img)}">
<meta name="theme-color" content="${INK}">`;
}

function shell(title: string, body: string, script = '', origin = ''): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>${shareTags(origin)}
<style>${SHARED_CSS}</style>
</head><body>
<main class="card">
  <div class="sign"><b>VOLKBUSTER</b><span>Video</span></div>
  ${body}
</main>
${script ? `<script>${script}</script>` : ''}
</body></html>`;
}

/**
 * The gate.
 *
 * The pin is created by the BROWSER on load rather than baked in server-side,
 * for two reasons. It keeps a crawler hitting this URL from creating a pin at
 * plex.tv, and it means the "Sign in" control is a real anchor the person
 * genuinely clicks — so `target="_blank"` survives popup blockers, which
 * matters most on the phones this fork is meant to serve.
 */
export function signInPage(origin = ''): string {
  const body = `
  <h1>Members only</h1>
  <p>This store is for people with access to its Plex library. Sign in with
     Plex and you're in — nothing to sign up for.</p>

  <div id="err" class="err" hidden></div>

  <div id="start">
    <button class="btn" id="begin" type="button">Sign in with Plex</button>
    <p class="muted">Opens plex.tv in a new tab. Your password never touches this server.</p>
  </div>

  <div id="waiting" hidden>
    <p class="tight">A Plex tab should have opened. Approve it there and this
       page will let you in by itself.</p>
    <a class="btn" id="link" href="#" target="_blank" rel="noopener noreferrer">Open plex.tv to approve</a>
    <p class="muted" id="status">Waiting for you to approve it…</p>
  </div>`;

  const script = `
(function () {
  var begin = document.getElementById('begin');
  var start = document.getElementById('start');
  var waiting = document.getElementById('waiting');
  var linkEl = document.getElementById('link');
  var statusEl = document.getElementById('status');
  var errEl = document.getElementById('err');
  var pinId = null, tries = 0;

  function fail(msg) {
    errEl.textContent = msg;
    errEl.hidden = false;
    waiting.hidden = true;
    start.hidden = false;
    begin.disabled = false;
    begin.textContent = 'Try again';
  }

  function poll() {
    // Give up after ~10 minutes; a pin does not live longer than that anyway,
    // and a tab left open overnight should not hammer the server forever.
    if (++tries > 300) return fail('That sign-in expired. Start again.');
    fetch('/auth/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: pinId, aspect: screen.width + 'x' + screen.height })
    }).then(function (r) {
      return r.json().then(function (b) { return { status: r.status, body: b }; });
    }).then(function (res) {
      if (res.status === 200) {
        statusEl.textContent = 'Signed in. Opening the store…';
        statusEl.className = 'muted ok';
        location.href = '/';
        return;
      }
      if (res.status === 202) { setTimeout(poll, 2000); return; }
      fail((res.body && res.body.error) || 'Sign-in failed.');
    }).catch(function () { setTimeout(poll, 3000); });
  }

  begin.addEventListener('click', function () {
    begin.disabled = true;
    begin.textContent = 'Contacting Plex…';
    errEl.hidden = true;
    fetch('/auth/pin', { method: 'POST' })
      .then(function (r) {
        if (!r.ok) throw new Error('pin');
        return r.json();
      })
      .then(function (pin) {
        pinId = pin.id;
        linkEl.href = pin.authUrl;
        start.hidden = true;
        waiting.hidden = false;
        // The person is already mid-gesture, so this opens without a blocker.
        window.open(pin.authUrl, '_blank', 'noopener');
        poll();
      })
      .catch(function () {
        fail('Could not reach Plex just now. Try again in a moment.');
      });
  });
})();`;

  return shell('Sign in — VolkBuster Video', body, script, origin);
}

/**
 * The holding page a signed-in viewer lands on.
 *
 * Deliberately honest about what is not built yet. The alternative — a spinner,
 * or a page implying the store is loading — would send whoever is testing this
 * hunting for a fault that does not exist.
 */
export function signedInPage(username: string, owner: boolean): string {
  const body = `
  <h1>You're in${owner ? ', boss' : ''}</h1>
  <p>Signed in as <strong>${esc(username)}</strong>${owner ? ' — owner, full admin.' : '.'}</p>
  <p>The gate works. The store itself is not wired up to it yet: rendering
     instances are the next piece of work, and until they land there is nothing
     behind this page to walk into.</p>
  <form method="POST" action="/auth/signout">
    <button class="btn" type="submit">Sign out</button>
  </form>
  <p class="muted">Session held server-side. Signing out revokes it here, not just in this browser.</p>`;
  return shell('Signed in — VolkBuster Video', body);
}
