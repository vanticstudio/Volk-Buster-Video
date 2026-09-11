/**
 * First-run setup: claim the store, then choose which Plex server it gates on.
 *
 * WHY A TOKEN. Until a server is chosen there is nothing to check a visitor
 * against, so this page is briefly the one unauthenticated surface that can
 * change what the store is. Whoever completes it becomes the owner. Without
 * proof-of-host, the first stranger to find the URL claims your store — the
 * classic first-run land-grab.
 *
 * The token is printed to the container log. Reading it proves control of the
 * host, which is exactly the claim being made, and it works identically over a
 * LAN, an SSH session or a Cloudflare Tunnel — unlike an IP allowlist, which
 * sees only the tunnel's address and would let everyone or no-one through.
 *
 * It is cleared the moment setup completes, so this whole surface exists once
 * and then stops existing.
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
    font-weight:400; font-style:normal; font-display:swap; }
  *,*::before,*::after{box-sizing:border-box}
  html,body{height:100%}
  body{margin:0;background:${INK};color:${CREAM};padding:24px;
    font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    display:flex;align-items:center;justify-content:center;
    background-image:radial-gradient(120% 90% at 50% -10%,rgba(26,73,194,.22),transparent 60%);
    -webkit-font-smoothing:antialiased}
  .card{width:100%;max-width:31rem;background:#12161f;border:1px solid rgba(242,232,201,.14);
    border-radius:6px;padding:30px 26px 26px;box-shadow:0 24px 60px rgba(0,0,0,.55)}
  .sign{background:${BLUE};border:3px solid ${CREAM};border-radius:5px;padding:14px 16px 12px;
    text-align:center;margin:0 0 20px}
  .sign b{display:block;font-family:'Archivo Black','Arial Black',sans-serif;
    font-size:clamp(24px,8vw,32px);line-height:.94;color:${CREAM}}
  .sign span{display:block;margin-top:5px;font-size:11px;letter-spacing:.34em;
    text-transform:uppercase;color:rgba(242,232,201,.82)}
  h1{font-family:'Archivo Black','Arial Black',sans-serif;font-size:19px;margin:0 0 8px;line-height:1.25}
  p{margin:0 0 14px;color:rgba(242,232,201,.74);font-size:14.5px}
  label{display:block;font-size:12px;letter-spacing:.1em;text-transform:uppercase;
    color:rgba(242,232,201,.55);margin:0 0 6px}
  input{width:100%;font:inherit;padding:12px 14px;border-radius:4px;background:#0a0d14;
    color:${CREAM};border:1px solid rgba(242,232,201,.28);margin:0 0 14px}
  input:focus{outline:2px solid ${BLUE};outline-offset:1px}
  .btn{display:block;width:100%;font:inherit;font-weight:600;text-align:center;text-decoration:none;
    padding:13px 16px;border-radius:4px;cursor:pointer;background:${CREAM};color:${INK};border:0}
  .btn:hover{filter:brightness(1.08)}
  .btn:disabled{opacity:.5;pointer-events:none}
  .srv{display:block;width:100%;text-align:left;background:#0a0d14;color:${CREAM};
    border:1px solid rgba(242,232,201,.28);border-radius:4px;padding:13px 15px;margin:0 0 10px;
    font:inherit;cursor:pointer}
  .srv:hover{border-color:${BLUE};background:#0d1220}
  .srv b{display:block;font-weight:600}
  .srv span{font-size:12.5px;color:rgba(242,232,201,.5)}
  .cmd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;background:#0a0d14;
    border:1px dashed rgba(242,232,201,.28);border-radius:4px;padding:11px 13px;margin:0 0 14px;
    color:${CREAM};overflow-x:auto;white-space:nowrap}
  .err{background:rgba(190,60,46,.16);border:1px solid rgba(230,120,105,.42);color:#ffcfc6;
    border-radius:4px;padding:12px 14px;font-size:14px;margin:0 0 14px}
  .muted{font-size:12.5px;color:rgba(242,232,201,.5);margin:14px 0 0}
  [hidden]{display:none!important}
`;

function shell(title: string, body: string, script = ''): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title><style>${CSS}</style>
</head><body><main class="card">
  <div class="sign"><b>VOLKBUSTER</b><span>Video</span></div>
  ${body}
</main>${script ? `<script>${script}</script>` : ''}</body></html>`;
}

/** Step 1 and 2 in one page: prove you own the host, then pick a server. */
export function setupPage(): string {
  const body = `
  <div id="err" class="err" hidden></div>

  <section id="step-token">
    <h1>Set up your store</h1>
    <p>Nobody can use this store until you tell it which Plex server it belongs
       to. First, prove you run this machine — the setup code was printed to the
       container log when it started:</p>
    <div class="cmd">docker logs volkbusters | grep -i "setup code"</div>
    <label for="tok">Setup code</label>
    <input id="tok" type="text" autocomplete="off" spellcheck="false" placeholder="12 hex characters">
    <button class="btn" id="claim" type="button">Continue</button>
    <p class="muted">Asked for once. It stops the first stranger who finds this
       address from claiming your store.</p>
  </section>

  <section id="step-plex" hidden>
    <h1>Sign in with Plex</h1>
    <p>So the store knows which servers are yours. You will be the owner.</p>
    <button class="btn" id="begin" type="button">Sign in with Plex</button>
    <p class="muted" id="plexstatus">Opens plex.tv in a new tab.</p>
  </section>

  <section id="step-server" hidden>
    <h1>Which server?</h1>
    <p>Everyone you have shared a library on this server with will be able to
       sign in. Nobody else can.</p>
    <div id="servers"></div>
  </section>`;

  const script = `
(function(){
  var errEl=document.getElementById('err');
  var stepToken=document.getElementById('step-token');
  var stepPlex=document.getElementById('step-plex');
  var stepServer=document.getElementById('step-server');
  var claim=document.getElementById('claim');
  var begin=document.getElementById('begin');
  var status=document.getElementById('plexstatus');
  var pinId=null, tries=0;

  function fail(m){ errEl.textContent=m; errEl.hidden=false; }
  function show(el){ [stepToken,stepPlex,stepServer].forEach(function(s){ s.hidden = s!==el; }); }

  claim.addEventListener('click',function(){
    var tok=document.getElementById('tok').value.trim();
    if(!tok) return fail('Enter the setup code from the log.');
    errEl.hidden=true; claim.disabled=true;
    fetch('/setup/claim',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({token:tok})})
      .then(function(r){ return r.json().then(function(b){return {s:r.status,b:b};}); })
      .then(function(res){
        claim.disabled=false;
        if(res.s!==200) return fail(res.b.error||'That code was not accepted.');
        show(stepPlex);
      }).catch(function(){ claim.disabled=false; fail('Could not reach the server.'); });
  });

  function poll(){
    if(++tries>300) return fail('That sign-in expired. Reload and try again.');
    fetch('/setup/claim-pin',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({id:pinId})})
      .then(function(r){ return r.json().then(function(b){return {s:r.status,b:b};}); })
      .then(function(res){
        if(res.s===202){ setTimeout(poll,2000); return; }
        if(res.s!==200) return fail(res.b.error||'Sign-in failed.');
        renderServers(res.b.servers||[]);
      }).catch(function(){ setTimeout(poll,3000); });
  }

  function renderServers(list){
    if(!list.length){
      return fail('That Plex account does not own any servers. Sign in as the account that owns the library you want to share.');
    }
    var box=document.getElementById('servers');
    box.innerHTML='';
    list.forEach(function(s){
      var b=document.createElement('button');
      b.className='srv'; b.type='button';
      b.innerHTML='<b>'+s.name.replace(/[<>&]/g,'')+'</b><span>'+s.id.slice(0,12)+'…</span>';
      b.addEventListener('click',function(){
        b.disabled=true;
        fetch('/setup/finish',{method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({machineId:s.id})})
          .then(function(r){ return r.json().then(function(x){return {s:r.status,b:x};}); })
          .then(function(res){
            if(res.s!==200){ b.disabled=false; return fail(res.b.error||'Could not save.'); }
            location.href='/';
          }).catch(function(){ b.disabled=false; fail('Could not reach the server.'); });
      });
      box.appendChild(b);
    });
    show(stepServer);
  }

  begin.addEventListener('click',function(){
    begin.disabled=true; begin.textContent='Contacting Plex…'; errEl.hidden=true;
    fetch('/auth/pin',{method:'POST'})
      .then(function(r){ if(!r.ok) throw new Error('pin'); return r.json(); })
      .then(function(pin){
        pinId=pin.id;
        status.textContent='Approve it in the Plex tab, then come back here.';
        window.open(pin.authUrl,'_blank','noopener');
        poll();
      }).catch(function(){
        begin.disabled=false; begin.textContent='Sign in with Plex';
        fail('Could not reach Plex just now.');
      });
  });
})();`;

  return shell('Set up — VolkBuster Video', body, script);
}
