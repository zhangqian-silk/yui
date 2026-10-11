# Run through browser-use (its helpers are pre-imported), not plain Python.
# Start smoke-web-runtime.mjs --serve first. No network interception or fake UI.
import base64
import hashlib
import json
import os
import time
import traceback
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
        results.append({"name": name, "status": "failed", "error": traceback.format_exc()})
        capture("failure-" + str(len(results)))
        print("FAIL", name, error)
        js("document.querySelectorAll('dialog[open]').forEach(d=>d.close())")
        cdp("Emulation.clearDeviceMetricsOverride")
    finally:
        (evidence / "browser-results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))

cdp("Emulation.clearDeviceMetricsOverride")
new_tab(base + "/settings")
owned_tab = current_tab()["targetId"]
wait_for_load()
print(page_info())
# Select the supported structured-only model path before opening a native TUI.
# A live TUI retains its configuration even after the browser viewer detaches.
wait("document.querySelector('#access-mode') !== null")
js("""(()=>{const s=document.querySelector('#access-mode');
  if(![...s.options].some(o=>o.value==='structured'))throw Error('Missing structured preference');
  s.value='structured';s.dispatchEvent(new Event('change',{bubbles:true}));})()""")
cdp("Page.navigate", url=base + "/?task=task-1")
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

def model():
    endpoint = "/api/conversation?scope=task&task=task-1&role=leader"
    before = read_api(endpoint)["body"]
    defaults = read_api("/api/settings/group?id=role%2Fleader")["body"]
    messages = read_api("/api/tasks/task-1/list?store=task-message")["body"]
    type_label("Message to the selected Session", "/model")
    click_named("Send")
    wait("document.querySelector('select[aria-label=\"Session model\"]').options.length === 2")
    js("""(()=>{const s=document.querySelector('select[aria-label="Session model"]');
      if(![...s.options].some(o=>o.value==='fast'))throw Error('Missing rendered model');
      s.value='fast';s.dispatchEvent(new Event('change',{bubbles:true}));})()""")
    click_named("Apply while idle")
    wait("document.body.innerText.includes('Native model adoption confirmed')")
    after = read_api(endpoint)["body"]
    assert after["currentSessionId"] == before["currentSessionId"]
    assert after["turn"] == before["turn"]
    page = read_api(endpoint + "&session=" + after["currentSessionId"])["body"]
    assert any(a["key"] == "model" and a["current"]["value"] == "fast" for a in page["runConfiguration"]["axes"])
    assert read_api("/api/settings/group?id=role%2Fleader")["body"] == defaults
    assert read_api("/api/tasks/task-1/list?store=task-message")["body"] == messages
    (evidence / "browser-model.json").write_text(json.dumps({"before": before, "after": after, "page": page, "defaults": defaults}, indent=2))
check("103: rendered /model adopts current model without a new Thread, Turn, Message or default change", model)

def public_answer():
    before = read_api("/api/conversation?scope=task&task=task-1&role=leader")["body"]
    wait("document.body.innerText.includes('Confirm disposable browser fixture')")
    js("""(()=>{window.__inputAnswer=[];const original=window.fetch.bind(window);
      window.fetch=async function(url,options){const r=await original(url,options);
      if(String(url).includes('/inputs/')&&String(url).endsWith('/answer')&&options?.method==='POST')
        window.__inputAnswer.push({url:String(url),body:JSON.parse(options.body),status:r.status,result:await r.clone().json()});
      return r;};})()""")
    click_named("Continue fixture")
    wait("window.__inputAnswer.length === 1")
    receipt = js("window.__inputAnswer[0]")
    assert receipt["status"] == 200
    request = receipt["result"]["request"]
    assert request["status"] == "answered"
    assert request["resolution"]["answeredBy"] == "user"
    assert request["resolution"]["answer"]["choiceKey"] == "continue"
    assert request["requester"]["nativeSessionId"] == before["currentSessionId"]
    # Ordinary input answers use the existing 60-second Leader aggregation,
    # unlike urgent user-message wakes. Observe it; do not manufacture a wake.
    end = time.monotonic() + 90
    after = before
    while time.monotonic() < end:
        after = read_api("/api/conversation?scope=task&task=task-1&role=leader")["body"]
        if after["turn"] != before["turn"] and after["turn"]["status"] == "completed":
            break
        time.sleep(.1)
    (evidence / "browser-input-answer.json").write_text(json.dumps({"receipt": receipt, "before": before, "after": after}, indent=2))
    assert after["currentSessionId"] == before["currentSessionId"]
    assert after["turn"] != before["turn"] and after["turn"]["status"] == "completed"
    wait("!document.querySelector('textarea[aria-label=\"Message to the selected Session\"]').disabled")
check("96: managed Leader question receives one browser answer and resumes the same Session", public_answer)

def material():
    before = read_api("/api/tasks/task-1/list?store=task-message")["body"]
    type_label("Message to the selected Session", "Keep upload draft")
    upload = evidence / "material.txt"
    upload.write_bytes("Material 😀\r\n<script>window.uploadInjected=true</script>\n".encode())
    # Inspect the actual file input, then use the browser's file chooser path.
    js("""[...document.querySelectorAll('summary')].find(e=>e.textContent==='Attach text material').click()""")
    root = cdp("DOM.getDocument")["root"]["nodeId"]
    node = cdp("DOM.querySelector", nodeId=root, selector='input[type="file"][aria-label="Attach text material"]')["nodeId"]
    assert node
    wait("!document.querySelector('input[type=\"file\"][aria-label=\"Attach text material\"]').disabled")
    cdp("DOM.setFileInputFiles", nodeId=node, files=[str(upload)])
    wait("document.body.innerText.includes('Material saved.')")
    assert js("document.querySelector('textarea[aria-label=\"Message to the selected Session\"]').value") == "Keep upload draft"
    assert js("window.uploadInjected === true") is False
    refs = js("""Object.keys(sessionStorage).filter(k=>k.endsWith('.materials'))
      .flatMap(k=>JSON.parse(sessionStorage.getItem(k)||'[]')).filter(r=>r.relativePath?.endsWith('/material.txt'))""")
    assert len(refs) == 1, refs
    ref = refs[0]
    assert ref["digest"] == hashlib.sha256(upload.read_bytes()).hexdigest()
    cdp("Page.reload")
    wait_for_load()
    wait("document.body.innerText.includes('material.txt')")
    assert read_api("/api/tasks/task-1/list?store=task-message")["body"] == before
    assert js("document.querySelector('textarea[aria-label=\"Message to the selected Session\"]').value") == "Keep upload draft"
    (evidence / "browser-material.json").write_text(json.dumps(ref, indent=2))
    click_named("Remove reference")
    wait("!document.body.innerText.includes('material.txt')")
check("98: real file upload pins exact bytes, preserves unsent draft on reload and never executes contents", material)

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
    wait("document.querySelector('textarea[aria-label=\"Message to the selected Session\"]').value === 'Keep my draft'")
    assert js("document.querySelector('textarea[aria-label=\"Message to the selected Session\"]').value") == "Keep my draft"
    assert read_api("/api/tasks/task-1/list?store=task-message")["body"] == before
    capture("pinned-markdown")
check("98/104: pinned Markdown renders safely; feedback stages reference without sending or replacing draft", artifact)

def image():
    click_named("pixel.png", prefix=True)
    wait("document.querySelector('img.artifact-image')?.naturalWidth === 1")
    js("""(()=>{const s=document.querySelector('select[aria-label="Image zoom"]');
      if(![...s.options].some(o=>o.value==='200'))throw Error('Missing zoom option');
      s.value='200';s.dispatchEvent(new Event('change',{bubbles:true}));})()""")
    assert js("document.querySelector('img.artifact-image').width") == 2
    downloads = evidence / "downloads"
    downloads.mkdir(exist_ok=True)
    cdp("Page.setDownloadBehavior", behavior="allow", downloadPath=str(downloads))
    try:
        click_named("Download original file")
        end = time.monotonic() + 10
        while not (downloads / "pixel.png").exists() and time.monotonic() < end:
            time.sleep(.1)
        data = (downloads / "pixel.png").read_bytes()
        expected = json.loads((evidence / "report.json").read_text())["native"]["image"]["digest"]
        assert hashlib.sha256(data).hexdigest() == expected
        assert len(data) == 68
        capture("image-zoom-download")
    finally:
        cdp("Page.setDownloadBehavior", behavior="default")
check("104: image zoom changes rendered dimensions; downloaded original matches pinned digest", image)

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
    wait("document.querySelector('textarea[aria-label=\"Message to the selected Session\"]').value.startsWith('Keep my draft\\n')")
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

def long_search():
    click_named("Search task contents")
    click_named("Text to find", "searchbox")
    js("document.activeElement.select()")
    cdp("Input.insertText", text="PAGE-MARKER")
    click_named("Search")
    wait("document.querySelectorAll('dialog[open] article').length === 20")
    first = js("[...document.querySelectorAll('dialog[open] h3')].map(e=>e.textContent)")
    click_named("Next")
    wait("document.querySelectorAll('dialog[open] article').length === 1")
    assert js("document.querySelector('dialog[open] h3').textContent") not in first
    click_named("Text to find", "searchbox")
    js("document.activeElement.select()")
    cdp("Input.insertText", text="LONG-REFERENCE")
    click_named("Search")
    wait("document.body.innerText.includes('Read exact original')")
    click_named("Read exact original")
    wait("document.querySelector('textarea.search-source') !== null")
    first_page = js("document.querySelector('textarea.search-source').value")
    # The source's own Next button, not the disabled search-results pager.
    js("""[...document.querySelectorAll('dialog[open] button')]
      .find(e=>e.textContent==='Next'&&!e.disabled).click()""")
    wait("document.querySelector('textarea.search-source')?.value && !document.querySelector('textarea.search-source').value.startsWith('LONG-REFERENCE')")
    assert len(first_page) > 2000
    capture("long-source-page")
    click_named("Close")
check("99/107: browser result pagination replaces bounded rows and exact source opens a later page", long_search)

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

def target_drafts():
    type_label("Message to the selected Session", "Task one private draft")
    click_named("Active Next Skill snapshot", prefix=True)
    wait("location.search.includes('task-2')")
    wait("document.querySelector('textarea[aria-label=\"Message to the selected Session\"]') !== null")
    assert js("document.querySelector('textarea[aria-label=\"Message to the selected Session\"]').value") == ""
    type_label("Message to the selected Session", "Task two private draft")
    click_named("Active Batch regression fixture", prefix=True)
    wait("location.search.includes('task-1')")
    wait("document.querySelector('textarea[aria-label=\"Message to the selected Session\"]').value === 'Task one private draft'")
    capture("target-draft-isolation")
check("94/103: switching Task targets restores separate unsent drafts", target_drafts)

def terminal_writers():
    before = read_api("/api/conversation?scope=task&task=task-1&role=leader")["body"]
    first = current_tab()["targetId"]
    second = None
    native_log = Path(json.loads((evidence / "report.json").read_text())["home"]) / "native-tui.jsonl"
    try:
        click_named("Terminal", "tab")
        wait("document.body.innerText.includes('Interactive')")
        click_named("Terminal input", "textbox")
        cdp("Input.insertText", text="WRITER-ALLOWED")
        end = time.monotonic() + 5
        while "WRITER-ALLOWED" not in native_log.read_text() and time.monotonic() < end:
            time.sleep(.1)
        assert "WRITER-ALLOWED" in native_log.read_text()
        new_tab(base + "/?task=task-1")
        second = current_tab()["targetId"]
        wait_for_load()
        print(page_info())
        click_named("Terminal", "tab")
        wait("document.body.innerText.includes('Read only')")
        click_named("Terminal input", "textbox")
        cdp("Input.insertText", text="WRITER-DENIED")
        # Exercise the server fence too, independently of xterm's read-only UI.
        readonly = js("""new Promise((resolve,reject)=>{
          const q=new URLSearchParams({scope:'task',task:'task-1',role:'leader',
            session:__SESSION__,cols:'80',rows:'24',
            token:document.querySelector('meta[name=yui-web-token]').content});
          const ws=new WebSocket('ws://'+location.host+'/api/terminal?'+q);
          const timer=setTimeout(()=>{ws.close();reject(Error('terminal timeout'));},5000);
          ws.onerror=()=>{clearTimeout(timer);reject(Error('terminal connection failed'));};
          ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.type==='ready'){
            ws.send(JSON.stringify({type:'input',data:'SERVER-WRITER-DENIED'}));
            setTimeout(()=>{clearTimeout(timer);ws.close();resolve(m.readOnly);},200);
          }};
        })""".replace("__SESSION__", json.dumps(before["currentSessionId"])))
        assert readonly is True
        capture("second-terminal-readonly")
        time.sleep(.2)
        assert "WRITER-DENIED" not in native_log.read_text()
        after = read_api("/api/conversation?scope=task&task=task-1&role=leader")["body"]
        assert after["currentSessionId"] == before["currentSessionId"]
        assert after["turn"] == before["turn"], "Opening native view must not create a model Turn"
        assert after["terminalWriter"] is True
    finally:
        if second:
            cdp("Target.closeTarget", targetId=second)
        switch_tab(first)
        click_named("Conversation", "tab")
    wait("document.querySelector('textarea[aria-label=\"Message to the selected Session\"]') !== null")
    assert js("document.querySelector('textarea[aria-label=\"Message to the selected Session\"]').value") == "Task one private draft"
    end = time.monotonic() + 5
    while read_api("/api/conversation?scope=task&task=task-1&role=leader")["body"]["terminalWriter"] and time.monotonic() < end:
        time.sleep(.1)
    assert read_api("/api/conversation?scope=task&task=task-1&role=leader")["body"]["terminalWriter"] is False
    endpoint = "/api/conversation?scope=task&task=task-1&role=leader"
    before_model = read_api(endpoint + "&session=" + before["currentSessionId"])["body"]["runConfiguration"]
    type_label("Message to the selected Session", "/model")
    click_named("Send")
    wait("document.querySelector('select[aria-label=\"Session model\"]').options.length === 2")
    js("""(()=>{const s=document.querySelector('select[aria-label="Session model"]');
      s.value='deep';s.dispatchEvent(new Event('change',{bubbles:true}));})()""")
    click_named("Apply while idle")
    wait("document.body.innerText.includes('Exit the native TUI before changing')")
    after_model = read_api(endpoint + "&session=" + before["currentSessionId"])["body"]["runConfiguration"]
    assert after_model == before_model, "Rejected model adoption must not change native configuration"
    assert read_api(endpoint)["body"]["turn"] == before["turn"]
    (evidence / "browser-native-model-fence.json").write_text(json.dumps({
        "before": before_model, "after": after_model, "body": js("document.body.innerText")}, indent=2))
    type_label("Message to the selected Session", "Task one private draft")
check("95: real Host relay/tmux/PTY keeps one Thread and one writer across two browser windows (fake native UI)", terminal_writers)

def skill_bindings():
    first = current_tab()["targetId"]
    second = None
    endpoint = "/api/skills/role?scope=task&task=task-1&role=leader"
    before = read_api(endpoint)["body"]
    try:
        new_tab(base + "/settings")
        second = current_tab()["targetId"]
        wait_for_load()
        print(page_info())
        wait("document.body.innerText.includes('Skills · browse & bind')")
        # Select only options read from the rendered labels/options.
        js("""(()=>{const l=[...document.querySelectorAll('#skill-browser label')]
          .find(e=>e.querySelector('span')?.textContent==='Scope');
          const s=l.querySelector('select'); if(![...s.options].some(o=>o.value==='task'))throw Error('Task scope missing');
          s.value='task';s.dispatchEvent(new Event('change',{bubbles:true}));})()""")
        type_label("Task ID", "task-1")
        click_named("Load / reload Role")
        wait("document.querySelector('#skill-browser').innerText.includes('No additional bindings')")
        click_named("Find an existing Skill by name or purpose", "searchbox")
        cdp("Input.insertText", text="regression")
        click_named("Search")
        wait("document.querySelectorAll('#skill-browser article').length === 1")
        click_named("Read current source")
        wait("document.body.innerText.includes('Read a resource (never executed)')")
        click_named("Add to selected Role")
        click_named("Save bindings")
        wait("document.body.innerText.includes('Bindings saved.')")
        bound = read_api(endpoint)["body"]
        assert bound["skills"] == ["regression"]
        assert bound["session"] == before["session"], "Binding must not rewrite the running Session"
        click_named("Remove binding")
        click_named("Save bindings")
        wait("document.querySelector('#skill-browser').innerText.includes('No additional bindings')")
        end = time.monotonic() + 5
        after = read_api(endpoint)["body"]
        while after["skills"] and time.monotonic() < end:
            time.sleep(.1)
            after = read_api(endpoint)["body"]
        assert after["skills"] == [] and after["session"] == before["session"]
        source = read_api("/api/skills/file?id=regression&resource=references%2Fguide.md")
        assert source["body"]["content"] == "attachment v2\n"
        (evidence / "browser-skills.json").write_text(json.dumps({"before": before, "bound": bound, "after": after}, indent=2))
        capture("skills-bind-unbind")
    finally:
        if second:
            close_tab(second)
        switch_tab(first)
check("108: rendered Skill browse/bind/unbind preserves source and running frozen Session", skill_bindings)

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
close_tab(owned_tab)
if any(r["status"] == "failed" for r in results):
    raise AssertionError("Browser checks failed; see browser-results.json")
