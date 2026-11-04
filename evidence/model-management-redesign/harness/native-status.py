# Ninth pass: an unreadable Codex native config is shown as unknown, not as a built-in service without Providers.
# Fixtures: badnative (no endpoint binding), badbound (bound), full (readable). Feed to browser-use.
import time, json
E = "/tmp/yui-t150-wi6/ev/"; R = {}
def vp(w, h): cdp("Emulation.setDeviceMetricsOverride", width=w, height=h, deviceScaleFactor=1, mobile=w < 700)
def go(u): goto_url(u); wait_for_load(); time.sleep(2.2)
def shot(path):
    for _ in range(3):
        try: capture_screenshot(path); return
        except Exception: time.sleep(1.5)
for port, tag in [(4312, "badnative"), (4313, "badbound"), (4311, "read")]:
    for w, h in [(1365, 900), (768, 1024), (390, 844), (360, 740)]:
        k = f"{tag}-{w}"; vp(w, h)
        go(f"http://127.0.0.1:{port}/models/providers"); js("localStorage.setItem('yui.locale','zh-CN')")
        go(f"http://127.0.0.1:{port}/models/providers")
        R[k + "-route"] = js("document.querySelector('[data-route-agent=codex]')?.innerText.replace(/\\n/g,' | ')")
        R[k + "-native"] = js("(()=>{const d=document.querySelector('[data-dimension=codex]'); const hs=[...d.querySelectorAll('h3')].find(x=>x.innerText.includes('原生')); let out=[hs?.innerText.replace(/\\n/g,' ')]; for(let n=hs?.nextElementSibling;n&&n.tagName!=='H3';n=n.nextElementSibling) out.push(n.innerText.replace(/\\n/g,' | ')); return out.join(' // ')})()")
        R[k + "-sw"] = js("JSON.stringify({vw: innerWidth, sw: document.documentElement.scrollWidth})")
        js("document.querySelector('[data-route-agent=codex]').scrollIntoView({block:'center'})"); time.sleep(0.4)
        shot(E + f"n-{tag}-{w}-services.png")
        go(f"http://127.0.0.1:{port}/models/agents")
        R[k + "-agent-row"] = js("document.querySelector('.access-row[data-agent-id=\"agent/codex\"]')?.innerText.replace(/\\n/g,' | ')")
        js("document.querySelector('.access-row[data-agent-id=\"agent/codex\"]').click()"); time.sleep(1.3)
        R[k + "-agent-facts"] = js("document.querySelector('.access-detail-facts')?.innerText.replace(/\\n/g,' | ')")
        R[k + "-agent-native-card"] = js("document.querySelector('.agent-native-card')?.innerText.replace(/\\n/g,' | ')")
        shot(E + f"n-{tag}-{w}-agent.png")
cdp("Emulation.clearDeviceMetricsOverride")
print(json.dumps(R, ensure_ascii=False, indent=1))
