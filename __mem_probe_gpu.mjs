import puppeteer from 'puppeteer';

async function tryLaunch(label, args) {
  console.log(`\n=== ${label} ===`);
  let browser;
  try {
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', ...args] });
    const page = await browser.newPage();
    const probe = await page.evaluate(() => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2');
      if (!gl) return { ok: false, why: 'no webgl2' };
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        ok: true,
        renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      };
    });
    console.log(JSON.stringify(probe));
  } catch (e) {
    console.log('launch failed:', e.message);
  } finally {
    if (browser) await browser.close();
  }
}

await tryLaunch('default', []);
await tryLaunch('angle-metal', ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist']);
await tryLaunch('enable-gpu', ['--enable-gpu', '--ignore-gpu-blocklist']);
