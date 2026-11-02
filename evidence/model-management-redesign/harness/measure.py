import time, json
from PIL import Image
out = []
pages = ["roles", "agents", "providers"]
widths = [(360, 800), (390, 844), (768, 1024), (1024, 768), (1365, 800), (1920, 1080)]
for (w, hgt) in widths:
    cdp("Emulation.setDeviceMetricsOverride", width=w, height=hgt, deviceScaleFactor=1, mobile=w < 700)
    for p in pages:
        goto_url("http://127.0.0.1:4301/models/" + p); wait_for_load(); time.sleep(1.8)
        path = f"/tmp/yui-t150-wi6/shots/m-{w}-{p}.png"
        capture_screenshot(path)
        px = Image.open(path).size
        m = js("""(() => {
          const sc = document.querySelector('#manage-scroll');
          const over = [...document.querySelectorAll('#manage-main *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && (r.right > innerWidth + 1); }).slice(0, 5).map(e => e.className || e.tagName);
          const vis = [...document.querySelectorAll('.access-row, .services-route')].filter(e => e.offsetParent); const rows = vis.map(e => Math.round(e.getBoundingClientRect().height));
          const firstRow = vis[0];
          return { vw: innerWidth, vh: innerHeight, docW: document.documentElement.scrollWidth, scrollW: sc.scrollWidth, scrollH: sc.scrollHeight,
            overflowing: over, minRowH: rows.length ? Math.min(...rows) : null,
            firstRowTop: firstRow ? Math.round(firstRow.getBoundingClientRect().top) : null };
        })()""")
        m.update({"page": p, "png": px})
        out.append(m)
print(json.dumps(out))
