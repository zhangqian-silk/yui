import time, json
E="/tmp/yui-t150-wi6/ev/"
out={}
def go(port, page, w, h):
    cdp("Emulation.setDeviceMetricsOverride", width=w, height=h, deviceScaleFactor=1, mobile=w < 700)
    goto_url(f"http://127.0.0.1:{port}/models/{page}"); wait_for_load(); time.sleep(1.8)
M = """(() => { const g=document.querySelector('.agent-inspector .agent-field-grid-compact'); if(!g) return 'none'; const rows=[...g.children].map(r=>{const b=r.getBoundingClientRect(); return [Math.round(b.top),Math.round(b.height)]}); return JSON.stringify({rows, h: Math.round(g.getBoundingClientRect().height), docW: document.documentElement.scrollWidth}); })()"""
go(4302,"roles",1365,800); js("document.querySelectorAll('#role-access-host .access-row')[0].click()"); time.sleep(1.2)
out["1365"]=js(M); capture_screenshot(E+"g-1365.png")
go(4302,"roles",1920,1080); js("document.querySelectorAll('#role-access-host .access-row')[0].click()"); time.sleep(1.2)
out["1920"]=js(M); capture_screenshot(E+"g-1920.png")
go(4302,"roles",390,844); js("document.querySelectorAll('#role-access-host .access-row')[0].click()"); time.sleep(1.2)
out["390"]=js(M); capture_screenshot(E+"g-390.png")
go(4301,"roles",1365,1300); 
out["dirty"]=js("""(async () => { document.querySelectorAll('#role-access-host .access-row')[3].click(); await new Promise(r=>setTimeout(r,1200));
 const ack=document.querySelector('.agent-inspector .agent-live-ack'); const before=getComputedStyle(ack).display;
 const inp=[...document.querySelectorAll('.agent-inspector .agent-field-grid-compact input')].find(e=>!e.disabled&&e.type!=='checkbox'); inp.value='m2'; inp.dispatchEvent(new Event('input',{bubbles:true})); await new Promise(r=>setTimeout(r,200));
 document.querySelectorAll('.agent-inspector details').forEach(d=>d.open=false);
 return JSON.stringify({before, after:getComputedStyle(ack).display}); })()""")
capture_screenshot(E+"g-1365-dirty.png")
go(4301,"agents",1365,900); js("document.querySelectorAll('#agent-access-host .access-row')[1].click()"); time.sleep(1.2)
out["agent"]=js(M); capture_screenshot(E+"g-1365-agent.png")
cdp("Emulation.clearDeviceMetricsOverride")
print(json.dumps(out, indent=1))
