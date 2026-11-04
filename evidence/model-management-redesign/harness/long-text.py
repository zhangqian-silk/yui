import time, json
E="/tmp/yui-t150-wi6/ev/"; R={}
def vp(w,h): cdp("Emulation.setDeviceMetricsOverride", width=w, height=h, deviceScaleFactor=1, mobile=w<700)
def go(u): goto_url(u); wait_for_load(); time.sleep(2)
def openrow(host, name):
    js("[...document.querySelectorAll('%s .access-row')].find(r=>r.innerText.split('\\n')[0].trim()==='%s').click()" % (host, name)); time.sleep(1.2)
def esc():
    cdp("Input.dispatchKeyEvent", type="keyDown", key="Escape", code="Escape", windowsVirtualKeyCode=27); cdp("Input.dispatchKeyEvent", type="keyUp", key="Escape", code="Escape", windowsVirtualKeyCode=27); time.sleep(0.4)
M="JSON.stringify({vw:innerWidth,vh:innerHeight,sw:document.documentElement.scrollWidth,dlg:(()=>{const d=document.querySelector('dialog[open]');if(!d)return null;const r=d.getBoundingClientRect();return [Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height),d.scrollWidth<=d.clientWidth]})()})"
go("http://127.0.0.1:4301/models/roles"); js("localStorage.setItem('yui.locale','zh-CN')")
for w,h in [(1365,900),(768,1024),(390,844),(360,740)]:
    vp(w,h); go("http://127.0.0.1:4301/models/roles")
    openrow('#role-access-host','operator')
    js("document.querySelectorAll('.agent-inspector details').forEach(d=>d.open=true)"); time.sleep(0.4)
    js("document.querySelector('.agent-inspector .settings-field[data-field=responsibilities]').scrollIntoView({block:'center'})"); time.sleep(0.3)
    R[f"{w}-detail"]=js(M); capture_screenshot(E+f"e-{w}-texts.png")
    js("document.querySelector('[data-text-expand=constraints]').click()"); time.sleep(0.5)
    R[f"{w}-editor"]=js(M); capture_screenshot(E+f"e-{w}-editor.png"); esc()
    js("document.querySelector('.agent-inspector [data-profile-action=open]').click()"); time.sleep(0.6)
    js("document.querySelector('dialog[open] .profile-option[data-profile-id=reviewer]').click()"); time.sleep(1.2)
    R[f"{w}-profile"]=js(M); capture_screenshot(E+f"e-{w}-profile.png")
    js("document.querySelector('dialog[open] [data-compare=systemPrompt]').click()"); time.sleep(0.5)
    R[f"{w}-compare"]=js(M); capture_screenshot(E+f"e-{w}-compare.png"); esc()
    R[f"{w}-afterEsc"]=js("JSON.stringify({open:[...document.querySelectorAll('dialog[open]')].map(d=>d.className), focus: document.activeElement.dataset?.compare})")
    esc()
print(json.dumps(R,ensure_ascii=False,indent=0))
