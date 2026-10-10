# Run through browser-use (its helpers are pre-imported), not plain Python.
# Start smoke-web-runtime.mjs --serve first. No network interception or fake UI.
import base64
import json
import os
import time
from pathlib import Path

evidence = Path(os.environ["YUI_SMOKE_EVIDENCE"])
base = json.loads((evidence / "report.json").read_text())["url"].rstrip("/")
only = os.environ.get("YUI_SMOKE_BROWSER_ONLY")
results = json.loads((evidence / "browser-results.json").read_text()) if only and (evidence / "browser-results.json").exists() else []

def wait(expression, timeout=12):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if js(expression):
            return
        time.sleep(.1)
    raise AssertionError("Timed out: " + expression)

def click_named(name, role="button", prefix=False):
    nodes = cdp("Accessibility.getFullAXTree")["nodes"]
    node = next(n for n in nodes if n.get("role", {}).get("value") == role
                and (n.get("name", {}).get("value", "").startswith(name) if prefix
                     else n.get("name", {}).get("value") == name))
    node_id = node["backendDOMNodeId"]
    cdp("DOM.scrollIntoViewIfNeeded", backendNodeId=node_id)
    q = cdp("DOM.getBoxModel", backendNodeId=node_id)["model"]["content"]
    click_at_xy(sum(q[0::2])/4, sum(q[1::2])/4)

def type_label(label, value):
    click_named(label, "textbox")
    # Focus comes from the actual rendered control; select its editable contents.
    js("document.activeElement.select()")
    cdp("Input.insertText", text=value)

def read_api(path):
    expression = ("fetch(" + json.dumps(path) + ",{headers:{'x-yui-web-token':"
                  "document.querySelector('meta[name=yui-web-token]').content}})"
                  ".then(async r=>({status:r.status,body:await r.json()}))")
    return js(expression)

def capture(name):
    data = cdp("Page.captureScreenshot", format="png")["data"]
    (evidence / (name + ".png")).write_bytes(base64.b64decode(data))

def check(name, action):
    if only and only not in name:
        return
    results[:] = [r for r in results if r["name"] != name]
    try:
        action()
        results.append({"name": name, "status": "passed"})
        print("PASS", name)
    except Exception as error:
        results.append({"name": name, "status": "failed", "error": repr(error)})
        capture("failure-" + str(len(results)))
        print("FAIL", name, error)
    finally:
        (evidence / "browser-results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))

cdp("Emulation.clearDeviceMetricsOverride")
new_tab(base + "/?task=task-1")
wait_for_load()
# Establish the rendered page and controls before choosing actions.
print(page_info())
print([(n.get("role", {}).get("value"), n.get("name", {}).get("value"))
       for n in cdp("Accessibility.getFullAXTree")["nodes"]
       if n.get("role", {}).get("value") in ("tab", "button", "textbox")])
click_named("Conversation", "tab")
wait("document.body.innerText.includes('Conversation input')")

def draft():
    before = read_api("/api/conversation?scope=task&task=task-1&role=leader")["body"]
    type_label("Message to the selected Session", "Unsent browser draft 😀")
    js("""(()=>{const s=[...document.querySelectorAll('select')].find(e=>e.getAttribute('aria-label')==='Default view');
       if(![...s.options].some(o=>o.value==='structured'))throw Error('Missing rendered option');
       s.value='structured';s.dispatchEvent(new Event('change',{bubbles:true}));})()""")
    cdp("Page.reload")
    wait_for_load()
    wait("document.body.innerText.includes('Conversation input')")
    assert js("document.querySelector('textarea[aria-label=\"Message to the selected Session\"]').value") == "Unsent browser draft 😀"
    after = read_api("/api/conversation?scope=task&task=task-1&role=leader")["body"]
    assert before["currentSessionId"] == after["currentSessionId"]
    assert before["turn"] == after["turn"], "Draft reload must not submit a Turn"
    capture("desktop-draft")
check("94/103: unsent draft survives reload without new Thread or Turn", draft)

def slash():
    before = read_api("/api/tasks/task-1/list?store=task-message")["body"]
    type_label("Message to the selected Session", "/help")
    click_named("Send")
    wait("document.querySelector('textarea[aria-label=\"Message to the selected Session\"]').value === ''")
    after = read_api("/api/tasks/task-1/list?store=task-message")["body"]
    assert before == after, "Local /help must not create a Message"
check("103: /help is a local command, not a Message", slash)

def artifact():
    type_label("Message to the selected Session", "Keep my draft")
    click_named("Delivery", "tab")
    click_named("Load file list")
    wait("document.body.innerText.includes('report.md')")
    click_named("report.md", prefix=True)
    wait("document.body.innerText.includes('Fixed evidence')")
    assert js("window.injected === true") is False
    assert js("[...document.querySelectorAll('pre code,pre')].some(e=>e.textContent.includes('const answer = 42;'))")
    before = read_api("/api/tasks/task-1/list?store=task-message")["body"]
    click_named("Discuss these versions")
    wait("document.body.innerText.includes('sha256:02328826')")
    assert js("document.querySelector('textarea[aria-label=\"Message to the selected Session\"]').value") == "Keep my draft"
    assert read_api("/api/tasks/task-1/list?store=task-message")["body"] == before
    capture("pinned-markdown")
check("98/104: pinned Markdown renders safely; feedback stages reference without sending or replacing draft", artifact)

def search_quote():
    before = read_api("/api/tasks/task-1/list?store=task-message")["body"]
    click_named("Search task contents")
    click_named("Text to find", "searchbox")
    cdp("Input.insertText", text="来源")
    click_named("Search")
    wait("document.body.innerText.includes('Read exact original')")
    click_named("Read exact original")
    wait("document.querySelector('textarea[readonly]') !== null")
    selected = js("""(()=>{const e=document.querySelector('textarea[readonly]');
      e.focus();e.setSelectionRange(3,10);return e.value.slice(e.selectionStart,e.selectionEnd);})()""")
    assert selected == "😀\nKeep"
    click_named("Insert selection (or this page)")
    value = js("""[...document.querySelectorAll('textarea')]
      .find(e=>e.getAttribute('aria-label')==='Message to the selected Session').value""")
    assert value.startswith("Keep my draft\n")
    ref = json.loads(next(line for line in value.splitlines() if line.startswith('{"authority"')))
    assert (ref["offset"], ref["length"], ref["offsetUnit"]) == (3, 7, "unicode-code-points")
    assert ref["ref"]["refId"] == "message-2"
    assert read_api("/api/tasks/task-1/list?store=task-message")["body"] == before
    capture("search-unicode-crlf")
    click_named("Close")
check("99/107: exact Unicode/CRLF selection appends a bounded source reference without sending", search_quote)

def preview():
    click_named("Preview", "tab")
    wait("document.body.innerText.includes('HTTP ready')")
    click_named("View here")
    wait("document.querySelector('iframe[title=Preview]') !== null")
    assert js("document.querySelector('iframe[title=Preview]').sandbox.value") == "allow-scripts"
    end = time.monotonic() + 10
    target = None
    while time.monotonic() < end and target is None:
        target = next((t for t in cdp("Target.getTargets")["targetInfos"]
                       if t["type"] == "iframe" and t["url"].startswith(base + "/preview/")), None)
        if target is None:
            time.sleep(.1)
    assert target
    session = cdp("Target.attachToTarget", targetId=target["targetId"], flatten=True)["sessionId"]
    try:
        text = cdp("Runtime.evaluate", expression="document.body.innerText",
                   returnByValue=True, session_id=session)["result"]["value"]
        assert text == "Relative asset loaded", text
    finally:
        cdp("Target.detachFromTarget", sessionId=session)
    capture("preview-panel")
    click_named("Conversation", "tab")
    assert read_api("/api/tasks/task-1/previews")["body"]["services"][0]["state"] == "ready"
check("105: sandboxed real Runner iframe executes its relative asset; closing the view does not cancel", preview)

def narrow():
    cdp("Emulation.setDeviceMetricsOverride", width=390, height=844, deviceScaleFactor=1, mobile=False)
    wait("innerWidth === 390")
    assert js("document.documentElement.scrollWidth <= innerWidth")
    capture("narrow")
    click_named("Back to tasks")
    click_named("New task")
    type_label("Task title", "Browser-only Draft")
    type_label("Original requirements", "Created by a real narrow-screen browser; do not activate.")
    click_named("Create and plan Planning", "checkbox", prefix=True)
    print([(n.get("role", {}).get("value"), n.get("name", {}).get("value"))
           for n in cdp("Accessibility.getFullAXTree")["nodes"]
           if n.get("role", {}).get("value") == "button"])
    click_named("Create only")
    wait("document.body.innerText.includes('Open saved task')")
    listing = read_api("/api/dashboard")["body"]
    created = [t for t in listing["tasks"] if t["title"] == "Browser-only Draft"]
    assert len(created) == 1 and created[0]["status"] == "draft"
    context = read_api("/api/tasks/" + created[0]["id"] + "/context")["body"]
    assert "nativeSessionId" not in json.dumps(context)
    (evidence / "browser-created-tasks.json").write_text(json.dumps(listing, ensure_ascii=False, indent=2))
    capture("narrow-created-draft")
    click_named("Close")
    cdp("Emulation.clearDeviceMetricsOverride")
check("96/responsive: create-only at 390px, no document overflow, durable Draft receipt", narrow)

print(json.dumps(results, ensure_ascii=False))
if any(r["status"] == "failed" for r in results):
    raise AssertionError("Browser checks failed; see browser-results.json")
