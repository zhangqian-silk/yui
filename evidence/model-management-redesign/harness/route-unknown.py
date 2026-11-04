import time, json
E="/tmp/yui-t150-wi6/ev/"; R={}
def vp(w,h): cdp("Emulation.setDeviceMetricsOverride", width=w, height=h, deviceScaleFactor=1, mobile=w<700)
def go(u): goto_url(u); wait_for_load(); time.sleep(2.2)
go("http://127.0.0.1:4304/models/roles"); js("localStorage.setItem('yui.locale','zh-CN')")
for port,tag in [(4304,"unknown"),(4301,"read")]:
  for w,h in [(1365,900),(390,844)]:
    vp(w,h); go(f"http://127.0.0.1:{port}/models/roles")
    R[f"{tag}-{w}-head"]=js("document.querySelector('#role-access-host .access-row-head')?.innerText.replace(/\\n/g,' | ')")
    R[f"{tag}-{w}-row"]=js("[...document.querySelectorAll('#role-access-host .access-row')].find(r=>r.innerText.startsWith('operator')).innerText.replace(/\\n/g,' | ')")
    capture_screenshot(E+f"r-{tag}-{w}-list.png")
    js("[...document.querySelectorAll('#role-access-host .access-row')].find(r=>r.innerText.startsWith('operator')).click()"); time.sleep(1.2)
    R[f"{tag}-{w}-facts"]=js("document.querySelector('.access-detail-facts').innerText.replace(/\\n/g,' | ')")
    R[f"{tag}-{w}-derived"]=js("document.querySelector('.agent-inspector .access-derived')?.innerText||''")
    R[f"{tag}-{w}-sw"]=js("document.documentElement.scrollWidth")
    capture_screenshot(E+f"r-{tag}-{w}-detail.png")
  vp(1365,900); go(f"http://127.0.0.1:{port}/models/agents")
  js("document.querySelector('#agent-access-host .access-row').click()"); time.sleep(1.2)
  js("document.querySelector('.access-detail-guide').click()"); time.sleep(0.5)
  js("(()=>{const a=document.querySelector('dialog[open] textarea');a.value='换个模型';a.dispatchEvent(new Event('input',{bubbles:true}))})()"); time.sleep(0.4)
  R[f"{tag}-agent-prompt"]=js("document.querySelector('dialog[open] .guide-preview')?.innerText")
cdp("Emulation.clearDeviceMetricsOverride")
print(json.dumps(R,ensure_ascii=False,indent=0))
