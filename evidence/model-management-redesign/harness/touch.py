import time
cdp("Emulation.setDeviceMetricsOverride", width=390, height=844, deviceScaleFactor=1, mobile=True)
cdp("Emulation.setTouchEmulationEnabled", enabled=True, maxTouchPoints=5)
goto_url("http://127.0.0.1:4301/models/roles"); wait_for_load(); time.sleep(2)
print(js("""(async () => { const coarse = matchMedia('(pointer:coarse)').matches; const rows=[...document.querySelectorAll('#role-access-host .access-row')].map(e=>Math.round(e.getBoundingClientRect().height));
 rows.length; document.querySelectorAll('#role-access-host .access-row')[0].click(); await new Promise(r=>setTimeout(r,1000));
 const all=[...document.querySelectorAll('#manage-main button, #manage-main summary')].filter(e=>e.offsetParent); const b=all.map(e=>Math.round(e.getBoundingClientRect().height)); const small=all.filter(e=>e.getBoundingClientRect().height<36).map(e=>[e.tagName,e.className,e.textContent.trim().slice(0,16),Math.round(e.getBoundingClientRect().height)]);
 return JSON.stringify({coarse, minRowH: Math.min(...rows), minButtonH: Math.min(...b), buttons: b.length, small}); })()"""))
capture_screenshot("/tmp/yui-t150-wi6/ev/i8-390-touch-detail.png")
goto_url("http://127.0.0.1:4301/models/providers"); wait_for_load(); time.sleep(2)
print(js("""JSON.stringify([...document.querySelectorAll('#manage-main button, #manage-main summary')].filter(e=>e.offsetParent && e.getBoundingClientRect().height<36).map(e=>[e.className,e.textContent.trim().slice(0,16),Math.round(e.getBoundingClientRect().height)]))"""))
capture_screenshot("/tmp/yui-t150-wi6/ev/i8-390-touch-services.png")
cdp("Emulation.setTouchEmulationEnabled", enabled=False)
