# Ninth pass: saving the Worker refreshes inheriting Profiles; other drafts survive; a failed re-read is unknown.
# usage: EV=<dir> PORT=<full fixture port>; feed to browser-use.
import time, json, os
E = "/tmp/yui-t150-wi6/ev/"; P = "4301"; R = {}
def vp(w, h): cdp("Emulation.setDeviceMetricsOverride", width=w, height=h, deviceScaleFactor=1, mobile=w < 700)
def go(u): goto_url(u); wait_for_load(); time.sleep(2.2)
def row(id): return js("(document.querySelector('.access-row[data-agent-id=\"%s\"]')||{}).innerText?.replace(/\\n/g,' | ')" % id)
def open_(id): js("document.querySelector('.access-row[data-agent-id=\"%s\"]').click()" % id); time.sleep(1.3)
def back(): js("document.querySelector('.access-back').click()"); time.sleep(0.8)
def setfield(key, value):
    js("""(()=>{const c=document.querySelector('.agent-inspector .settings-field[data-field="%s"] input, .agent-inspector .settings-field[data-field="%s"] textarea, .agent-inspector .settings-field[data-field="%s"] select');
    c.value=%s; c.dispatchEvent(new Event('input',{bubbles:true})); c.dispatchEvent(new Event('change',{bubbles:true}));})()""" % (key, key, key, json.dumps(value))); time.sleep(0.3)
def save():
    js("document.querySelector('.agent-inspector .agent-live-ack input')?.click()")
    js("document.querySelector('.agent-inspector .agent-action-bar button[type=submit]').click()"); time.sleep(2.5)
def shot(path):
    for _ in range(3):
        try: capture_screenshot(path); return
        except Exception: time.sleep(1.5)
def facts(): return js("document.querySelector('.access-detail-facts')?.innerText.replace(/\\n/g,' | ')")
for w, h in [(1365, 900), (390, 844)]:
    k = str(w); vp(w, h); go(f"http://127.0.0.1:{P}/models/roles"); js("localStorage.setItem('yui.locale','zh-CN')"); go(f"http://127.0.0.1:{P}/models/roles")
    R[k + "-reader-before"] = row("profile/reader")
    open_("profile/designer"); setfield("description", "Design and frontend work（未保存草稿）")
    R[k + "-designer-dirty"] = row("profile/designer")
    if w < 700: back()
    open_("role/worker"); old = js("document.querySelector('.agent-inspector .settings-field[data-field=effort] input').value")
    setfield("effort", "high" if old != "high" else "medium"); save()
    R[k + "-worker-receipt"] = js("document.querySelector('.agent-inspector .agent-receipt')?.innerText")
    R[k + "-reader-after"] = row("profile/reader")
    if w < 700: back()
    open_("profile/reader"); R[k + "-reader-facts"] = facts()
    shot(E + f"w-{w}-reader-after-worker-save.png")
    if w < 700: back()
    open_("profile/designer")
    R[k + "-designer-draft"] = js("document.querySelector('.agent-inspector .settings-field[data-field=description] textarea').value")
    R[k + "-designer-dirty-after"] = js("document.querySelector('.agent-inspector .agent-dirty-indicator')?.innerText")
    # Failed re-read: Profile reads fail, Worker save succeeds.
    js("""(()=>{window.__fetch=window.fetch; window.fetch=(u,o)=>String(u).includes('id=profile')?Promise.reject(new TypeError('fixture offline')):window.__fetch(u,o);})()""")
    if w < 700: back()
    open_("role/worker"); cur = js("document.querySelector('.agent-inspector .settings-field[data-field=effort] input').value")
    setfield("effort", "max" if cur != "max" else "high"); save()
    R[k + "-reader-failed"] = row("profile/reader")
    if w < 700: back()
    open_("profile/reader"); R[k + "-reader-failed-facts"] = facts()
    R[k + "-reader-failed-derived"] = js("document.querySelector('.agent-inspector .access-derived')?.innerText")
    R[k + "-sw"] = js("JSON.stringify({vw: innerWidth, sw: document.documentElement.scrollWidth})")
    shot(E + f"w-{w}-reader-reread-failed.png")
    js("window.fetch=window.__fetch")
    back() if w < 700 else None
    open_("profile/reader"); R[k + "-reader-retry-facts"] = facts(); R[k + "-reader-retry-row"] = row("profile/reader")
    # Restore effort to medium for the next width, keep fixture comparable.
    if w < 700: back()
    open_("role/worker"); setfield("effort", "medium"); save()
cdp("Emulation.clearDeviceMetricsOverride")
print(json.dumps(R, ensure_ascii=False, indent=1))
