import time, json
E="/tmp/yui-t150-wi6/ev/"; out={}
for w,h in [(1365,900),(390,844)]:
    cdp("Emulation.setDeviceMetricsOverride", width=w, height=h, deviceScaleFactor=1, mobile=w<700)
    goto_url("http://127.0.0.1:4301/models/roles"); wait_for_load(); time.sleep(1.8)
    js("document.querySelectorAll('#role-access-host .access-row')[0].click()"); time.sleep(1.2)
    js("document.querySelector('.agent-inspector [data-profile-action=open]').click()"); time.sleep(0.5)
    js("document.querySelector('dialog[open] .profile-option[data-profile-id=designer]').click()"); time.sleep(1.0)
    out[f"{w}"]=js("""JSON.stringify({texts: [...document.querySelectorAll('dialog[open] .profile-text')].map(e=>[e.dataset.key, e.dataset.clamped, e.querySelector('.profile-text-tag').innerText, Math.round(e.getBoundingClientRect().height)]), tableRows: [...document.querySelectorAll('dialog[open] .settings-profile-diff tbody th')].map(e=>e.innerText), docW: document.documentElement.scrollWidth})""")
    capture_screenshot(E+f"t-{w}-clamped.png")
    js("document.querySelector('dialog[open] .profile-text-toggle')?.click()"); time.sleep(0.3)
    out[f"{w}-expanded"]=js("""JSON.stringify([...document.querySelectorAll('dialog[open] .profile-text')].map(e=>[e.dataset.key, e.dataset.clamped, Math.round(e.getBoundingClientRect().height)]))""")
    capture_screenshot(E+f"t-{w}-expanded.png")
cdp("Emulation.clearDeviceMetricsOverride")
print(json.dumps(out, indent=1, ensure_ascii=False))
