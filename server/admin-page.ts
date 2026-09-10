/**
 * The management console served on the admin port.
 *
 * Deliberately plain. It is a handful of checkboxes an owner touches rarely,
 * on a LAN-only port, and every minute spent on it is a minute not spent on the
 * store — which is the thing anyone actually looks at.
 */

const BLUE = '#1a49c2';
const CREAM = '#f2e8c9';
const INK = '#0d1018';

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

const CSS = `
  @font-face { font-family:'Archivo Black'; src:url('/signin/archivo-black.ttf') format('truetype');
    font-weight:400; font-display:swap; }
  *,*::before,*::after{box-sizing:border-box}
  body{margin:0;background:${INK};color:${CREAM};padding:28px 20px 60px;
    font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    -webkit-font-smoothing:antialiased}
  .wrap{max-width:44rem;margin:0 auto}
  .sign{background:${BLUE};border:3px solid ${CREAM};border-radius:5px;padding:12px 16px 10px;
    text-align:center;margin:0 0 6px}
  .sign b{display:block;font-family:'Archivo Black','Arial Black',sans-serif;
    font-size:clamp(20px,6vw,28px);line-height:.95;color:${CREAM}}
  .sign span{display:block;margin-top:4px;font-size:10px;letter-spacing:.34em;
    text-transform:uppercase;color:rgba(242,232,201,.8)}
  .role{text-align:center;font-size:12px;color:rgba(242,232,201,.5);margin:0 0 26px}
  h2{font-family:'Archivo Black','Arial Black',sans-serif;font-size:17px;margin:30px 0 6px}
  p{color:rgba(242,232,201,.72);font-size:14.5px;margin:0 0 16px}
  p.note{font-size:13px;color:rgba(242,232,201,.5)}
  .card{background:#12161f;border:1px solid rgba(242,232,201,.13);border-radius:6px;
    padding:6px 18px;margin:0 0 8px}
  .row{display:flex;align-items:center;gap:14px;padding:14px 0;
    border-bottom:1px solid rgba(242,232,201,.08)}
  .row:last-child{border-bottom:0}
  .row .grow{flex:1;min-width:0}
  .row b{display:block;font-weight:600;font-size:15px}
  .row small{color:rgba(242,232,201,.45);font-size:12.5px}
  input[type=checkbox]{width:20px;height:20px;accent-color:${BLUE};flex:none;cursor:pointer}
  .btn{font:inherit;font-weight:600;padding:12px 22px;border-radius:4px;border:0;cursor:pointer;
    background:${CREAM};color:${INK}}
  .btn:hover{filter:brightness(1.08)}
  .btn:disabled{opacity:.5;pointer-events:none}
  .btn.ghost{background:transparent;color:${CREAM};border:1px solid rgba(242,232,201,.3)}
  .bar{position:sticky;bottom:0;background:linear-gradient(transparent,${INK} 40%);
    padding:22px 0 6px;display:flex;gap:12px;align-items:center}
  .ok{color:#9fd9b6;font-size:14px}
  .err{background:rgba(190,60,46,.16);border:1px solid rgba(230,120,105,.42);color:#ffcfc6;
    border-radius:4px;padding:12px 14px;font-size:14px;margin:0 0 16px}
  code{background:#0a0d14;border:1px solid rgba(242,232,201,.2);border-radius:3px;
    padding:.1em .35em;font-size:.87em}
  [hidden]{display:none!important}
`;

export interface AdminLibrary { id: string; title: string; type: string }

export function adminPage(opts: {
  username: string;
  libraries: AdminLibrary[];
  hidden: string[];
  gamesEnabled: boolean;
  publicPort: number;
}): string {
  const rows = opts.libraries.map((l) => `
    <label class="row">
      <input type="checkbox" data-lib="${esc(l.id)}" ${opts.hidden.includes(l.id) ? '' : 'checked'}>
      <span class="grow"><b>${esc(l.title)}</b><small>${esc(l.type)} · ${esc(l.id)}</small></span>
    </label>`).join('');

  const body = `
  <div class="sign"><b>VOLKBUSTER</b><span>Management</span></div>
  <p class="role">Signed in as ${esc(opts.username)} · owner</p>

  <div id="err" class="err" hidden></div>

  <h2>Libraries on the shelves</h2>
  <p>Which of your Plex libraries this store stocks. Unticked ones are not
     fetched and never appear.</p>
  <div class="card">${rows || '<div class="row"><span class="grow"><b>No libraries found</b><small>The Plex server returned none — check it is reachable.</small></span></div>'}</div>
  <p class="note"><strong>This is merchandising, not access control.</strong>
     Hiding a library stops the store stocking it; it does not stop someone
     asking Plex for it directly with their own token. If a person must not see
     a library, unshare it in Plex.</p>

  <h2>Departments</h2>
  <div class="card">
    <label class="row">
      <input type="checkbox" id="games" ${opts.gamesEnabled ? 'checked' : ''}>
      <span class="grow"><b>Games department</b>
        <small>Per-platform bays and jewel cases. Needs a RomM server; with none configured the aisle is empty.</small></span>
    </label>
  </div>

  <div class="bar">
    <button class="btn" id="save" type="button">Save</button>
    <span id="saved" class="ok" hidden>Saved. Viewers pick it up on their next load.</span>
  </div>

  <h2>Sessions</h2>
  <p>Sign every viewer out of the public store on port ${opts.publicPort}. They
     stay allowed in — they just have to sign in with Plex again. Use it if you
     have unshared a library and want it to take effect now rather than at the
     next re-check.</p>
  <div class="bar">
    <button class="btn ghost" id="revoke" type="button">Sign everyone out</button>
    <span id="revoked" class="ok" hidden></span>
  </div>`;

  const script = `
(function(){
  var err=document.getElementById('err');
  function fail(m){ err.textContent=m; err.hidden=false; }

  document.getElementById('save').addEventListener('click',function(){
    var btn=this; btn.disabled=true; err.hidden=true;
    var hidden=[];
    document.querySelectorAll('input[data-lib]').forEach(function(el){
      if(!el.checked) hidden.push(el.getAttribute('data-lib'));
    });
    fetch('/api/policy',{method:'PUT',headers:{'content-type':'application/json'},
      body:JSON.stringify({hiddenLibraries:hidden,gamesEnabled:document.getElementById('games').checked})})
      .then(function(r){ if(!r.ok) throw new Error('save'); return r.json(); })
      .then(function(){
        btn.disabled=false;
        var s=document.getElementById('saved'); s.hidden=false;
        setTimeout(function(){ s.hidden=true; },4000);
      })
      .catch(function(){ btn.disabled=false; fail('Could not save. Is the front door still running?'); });
  });

  document.getElementById('revoke').addEventListener('click',function(){
    var btn=this; btn.disabled=true; err.hidden=true;
    fetch('/api/sessions',{method:'DELETE'})
      .then(function(r){ return r.json(); })
      .then(function(b){
        btn.disabled=false;
        var s=document.getElementById('revoked');
        s.textContent=(b.revoked||0)+' session(s) signed out.'; s.hidden=false;
        setTimeout(function(){ s.hidden=true; },5000);
      })
      .catch(function(){ btn.disabled=false; fail('Could not reach the server.'); });
  });
})();`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex, nofollow">
<title>Management — VolkBuster Video</title><style>${CSS}</style>
</head><body><div class="wrap">${body}</div><script>${script}</script></body></html>`;
}

/** Shown when someone who is not the owner reaches the admin port. */
export function adminDeniedPage(username: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="robots" content="noindex">
<title>Not the owner — VolkBuster Video</title><style>${CSS}</style></head>
<body><div class="wrap">
  <div class="sign"><b>VOLKBUSTER</b><span>Management</span></div>
  <p class="role">Signed in as ${esc(username)}</p>
  <div class="err">This console is for the account that owns the Plex server
    this store gates on. Yours does not.</div>
  <p class="note">Ownership is taken from Plex rather than a setting here, so
    there is nothing to grant — it follows whoever owns the server.</p>
</div></body></html>`;
}
