import time, json
E="/tmp/yui-t150-wi6/ev/"
cdp("Emulation.setDeviceMetricsOverride", width=1365, height=800, deviceScaleFactor=1, mobile=False)
goto_url("http://127.0.0.1:4302/models/roles"); wait_for_load(); time.sleep(1.8)
js("document.querySelectorAll('#role-access-host .access-row')[0].click()"); time.sleep(1.2)
capture_screenshot(E+"c-1365-role.png")
# slow motion frames of opening another time
goto_url("http://127.0.0.1:4301/models/roles"); wait_for_load(); time.sleep(1.8)
cdp("Animation.enable"); cdp("Animation.setPlaybackRate", playbackRate=0.08)
js("window.__vt=[]; const o=document.startViewTransition.bind(document); document.startViewTransition=(f)=>{const t=o(f); window.__vt.push('start'); t.finished.then(()=>window.__vt.push('done')); return t;}; document.querySelectorAll('#role-access-host .access-row')[1].click()")
time.sleep(0.9); capture_screenshot(E+"c-open-frame1.png")
time.sleep(1.2); capture_screenshot(E+"c-open-frame2.png")
cdp("Animation.setPlaybackRate", playbackRate=1); time.sleep(1)
r = {"open": js("JSON.stringify({vt: window.__vt, root: document.documentElement.className, detail: document.querySelector('[data-detail]').dataset.detail})")}
# switch row: rise animation present
r["switch"] = js("""(async () => { document.querySelectorAll('#role-access-host .access-row')[2].click(); const a = document.getAnimations().map(a => a.effect?.target?.className).filter(Boolean); await new Promise(r=>setTimeout(r,400)); return JSON.stringify({anims: a.slice(0,4), vt: window.__vt}); })()""")
# focus help visible on focus
r["help"] = js("""(async () => { const f=[...document.querySelectorAll('.agent-inspector .settings-field')].find(e=>e.querySelector('input:not([type=checkbox])')); const help=f.querySelector('.agent-field-help'); const before=getComputedStyle(help).display; f.querySelector('input:not([type=checkbox])').focus(); await new Promise(r=>setTimeout(r,50)); return JSON.stringify({before, after:getComputedStyle(help).display, title: !!f.title, described: f.querySelector('input').getAttribute('aria-describedby')}); })()""")
capture_screenshot(E+"c-1365-focus-help.png")
# close
js("document.querySelector('.access-back').click()"); time.sleep(1)
r["close"] = js("JSON.stringify({vt: window.__vt, detail: document.querySelector('[data-detail]').dataset.detail, active: document.activeElement.className})")
# narrow
cdp("Emulation.setDeviceMetricsOverride", width=390, height=844, deviceScaleFactor=1, mobile=True)
goto_url("http://127.0.0.1:4302/models/roles"); wait_for_load(); time.sleep(1.8)
r["narrow"] = js("""(async () => { document.querySelectorAll('#role-access-host .access-row')[0].click(); const a=document.getAnimations().map(x=>x.effect?.target?.className); await new Promise(r=>setTimeout(r,1000)); return JSON.stringify({anims:a, docW: document.documentElement.scrollWidth}); })()""")
capture_screenshot(E+"c-390-role.png")
# reduced motion
cdp("Emulation.setEmulatedMedia", features=[{"name":"prefers-reduced-motion","value":"reduce"}])
cdp("Emulation.setDeviceMetricsOverride", width=1365, height=800, deviceScaleFactor=1, mobile=False)
goto_url("http://127.0.0.1:4301/models/roles"); wait_for_load(); time.sleep(1.8)
r["reduced"] = js("""(() => { let n=0; const o=document.startViewTransition.bind(document); document.startViewTransition=(f)=>{n++; return o(f);}; document.querySelectorAll('#role-access-host .access-row')[0].click(); return JSON.stringify({vtCalls:n, detail: document.querySelector('[data-detail]').dataset.detail, anims: document.getAnimations().length}); })()""")
cdp("Emulation.setEmulatedMedia", features=[])
cdp("Emulation.clearDeviceMetricsOverride")
print(json.dumps(r, indent=1))
