# Run with browser-use; real Yui plus a loopback response-dropping proxy.
import subprocess
from pathlib import Path

exec(Path("scripts/smoke-web-browser.py").read_text().split('cdp("Emulation.clearDeviceMetricsOverride")\nnew_tab')[0])
fixture = json.loads((evidence / "report.json").read_text())
base = fixture["proxyUrl"].rstrip("/")
env = {
    "HOME": fixture["sandbox"], "CODEX_HOME": fixture["sandbox"] + "/codex",
    "YUI_HOME": fixture["home"], "TMPDIR": fixture["sandbox"] + "/tmp",
    "PATH": fixture["sandbox"] + "/bin:" + os.environ["PATH"],
}
backend = []
def cli(*args):
    result = subprocess.run([fixture["cli"], "--json", *args], env=env, cwd=fixture["sandbox"],
                            text=True, capture_output=True, timeout=40)
    backend.append({"args": args, "code": result.returncode, "stdout": result.stdout, "stderr": result.stderr})
    (evidence / "recovery-cli.json").write_text(json.dumps(backend, ensure_ascii=False, indent=2))
    assert result.returncode == 0, result.stderr + result.stdout
    return json.loads(result.stdout).get("data")

def post(path, body):
    return js("fetch(" + json.dumps(path) + ",{method:'POST',headers:{'content-type':'application/json',"
              "'x-yui-web-token':document.querySelector('meta[name=yui-web-token]').content},body:"
              + json.dumps(json.dumps(body)) + "}).then(async r=>({status:r.status,body:await r.json()}))")

def textarea():
    return js("document.querySelector('textarea[aria-label=\"Message to the selected Session\"]').value")

def disabled(name):
    return js("([...document.querySelectorAll('button')].find(b=>b.textContent===" + json.dumps(name) + ")||{}).disabled")

def select_session(identity):
    js("(()=>{const s=document.querySelector('select[aria-label=\"Current and previous Sessions\"]');"
       "s.value=" + json.dumps(identity) + ";s.dispatchEvent(new Event('change',{bubbles:true}));})()")

def pending():
    return js("Object.entries({...sessionStorage,...localStorage}).filter(([k])=>k.endsWith('.pending')).map(([k,v])=>({key:k,...JSON.parse(v)}))")

def reopen_tab():
    old_tab = current_tab()["targetId"]
    fresh = cdp("Target.createTarget", url="about:blank")["targetId"]
    switch_tab(fresh)
    close_tab(old_tab)
    goto_url(base + "/?task=task-1"); wait_for_load()
    click_named("Conversation", "tab")
    wait("document.body.innerText.includes('Conversation input')")

def count_turns():
    path = Path(fixture["home"]) / "native-turns.jsonl"
    return len(path.read_text().splitlines())

endpoint = "/api/conversation?scope=task&task=task-1&role=leader"
new_tab(base + "/?task=task-1")
wait_for_load()
print(page_info())
click_named("Conversation", "tab")
wait("!!document.querySelector('textarea')")
js("(()=>{const s=document.querySelector('select[aria-label=\"Default view\"]');s.value='structured';s.dispatchEvent(new Event('change',{bubbles:true}));})()")

def history():
    before = read_api(endpoint)["body"]
    old = before["currentSessionId"]
    type_label("Message to the selected Session", "Original Session draft")
    cli("task", "role", "session", "new", "task-1", "leader", "--reason", "Isolated historical-readonly regression")
    wait("document.querySelector('select[aria-label=\"Current and previous Sessions\"]')?.options.length>=2", 30)
    after = read_api(endpoint)["body"]
    current = after["currentSessionId"]
    assert old != current
    select_session(current)
    wait("!([...document.querySelectorAll('button')].find(b=>b.textContent==='Send')).disabled")
    assert textarea() == ""
    type_label("Message to the selected Session", "Current Session draft")
    select_session(old)
    wait("([...document.querySelectorAll('button')].find(b=>b.textContent==='Send')).disabled")
    assert textarea() == "Original Session draft"
    wait("document.body.innerText.includes('Fixture history')")
    assert disabled("Send") and disabled("Stop this Turn")
    assert js("document.querySelector('input[type=file]').disabled")
    stable_turns = count_turns()
    current_before = read_api(endpoint + "&session=" + current)["body"]
    type_label("Message to the selected Session", "/stop")
    cdp("Input.dispatchKeyEvent", type="keyDown", key="Enter", code="Enter", modifiers=2, windowsVirtualKeyCode=13)
    cdp("Input.dispatchKeyEvent", type="keyUp", key="Enter", code="Enter", modifiers=2, windowsVirtualKeyCode=13)
    initial = cli("task", "message", "list", "task-1")
    artifacts = read_api("/api/tasks/task-1/artifacts")["body"]
    neighbour = read_api("/api/conversation?scope=task&task=task-2&role=leader")["body"]
    old_url = endpoint + "&session=" + old
    receipts = [
        post(old_url, {"action": "queue", "requestId": "historical-send", "body": "DENIED"}),
        post(old_url, {"action": "interrupt", "requestId": "historical-stop", "expectedTarget": "stale"}),
        post(old_url.replace("/api/conversation?", "/api/conversation/model?"), {"model": "fast"}),
        post(old_url.replace("/api/conversation?", "/api/conversation/material?"),
             {"requestId": "historical-material", "name": "denied.txt", "content": "DENIED"})
    ]
    assert all(r["status"] == 409 and "Historical" in r["body"]["error"] for r in receipts), receipts
    assert cli("task", "message", "list", "task-1") == initial
    assert read_api("/api/tasks/task-1/artifacts")["body"] == artifacts
    assert count_turns() == stable_turns
    assert read_api(endpoint + "&session=" + current)["body"].get("runConfiguration", {}).get("axes") == current_before.get("runConfiguration", {}).get("axes")
    assert read_api("/api/conversation?scope=task&task=task-2&role=leader")["body"]["currentSessionId"] == neighbour["currentSessionId"]
    assert not (Path(fixture["home"]) / "artifacts/task-1/materials/historical-material/denied.txt").exists()
    capture("historical-readonly")
    # Feedback is supported as an explicit move to the current conversation,
    # staging references locally, not as a write to the historical Session.
    click_named("Delivery", "tab")
    click_named("Load file list")
    wait("document.body.innerText.includes('report.md')")
    click_named("report.md", prefix=True)
    wait("document.body.innerText.includes('Fixed evidence')")
    click_named("Discuss these versions")
    wait("document.querySelector('select[aria-label=\"Current and previous Sessions\"]').value===" + json.dumps(current))
    assert textarea() == "Current Session draft"
    assert cli("task", "message", "list", "task-1") == initial
    select_session(current)
    wait("!([...document.querySelectorAll('button')].find(b=>b.textContent==='Send')).disabled")
    assert textarea() == "Current Session draft"
    cdp("Page.reload"); wait_for_load()
    wait("!!document.querySelector('textarea')")
    assert textarea() == "Current Session draft"
    (evidence / "history-receipts.json").write_text(json.dumps({"before": before, "after": after, "denied": receipts}, indent=2))
check("A: real Session replacement, historical read-only and draft isolation", history)

def unknown_after():
    click_named("Current Session")
    wait("!([...document.querySelectorAll('button')].find(b=>b.textContent==='Send')).disabled")
    start = count_turns()
    post("/__fault", {"mode": "after", "blockReceipts": True})
    type_label("Message to the selected Session", "RECOVERY-AFTER")
    click_named("Send")
    wait("document.body.innerText.includes('Unknown')")
    saved = pending()
    assert len(saved) == 1, saved
    request_id = saved[0]["requestId"]
    assert disabled("Send")
    capture("lost-confirmation")
    cdp("Page.reload"); wait_for_load()
    wait("!!document.querySelector('textarea')")
    assert disabled("Send") and pending()[0]["requestId"] == request_id
    reopen_tab()
    assert disabled("Send") and pending()[0]["requestId"] == request_id
    post("/__fault", {})
    wait("Object.entries({...sessionStorage,...localStorage}).every(([k])=>!k.endsWith('.pending'))", 25)
    receipt = read_api(endpoint + "&requestId=" + request_id)
    assert receipt["body"]["state"] == "accepted", receipt
    assert count_turns() == start + 1
    assert textarea() == ""
    (evidence / "recovered-receipt.json").write_text(json.dumps({"requestId": request_id, "receipt": receipt, "turnsBefore": start, "turnsAfter": count_turns()}, indent=2))
check("B: actual accepted request loses HTTP response; reload resolves same identity once", unknown_after)

def unknown_before():
    start = count_turns()
    post("/__fault", {"mode": "before"})
    type_label("Message to the selected Session", "RECOVERY-BEFORE")
    click_named("Send")
    wait("document.body.textContent.includes('No saved input found')")
    saved = pending()
    assert len(saved) == 1
    receipt = read_api(endpoint + "&requestId=" + saved[0]["requestId"])
    assert receipt["body"]["state"] == "unknown"
    assert count_turns() == start
    assert disabled("Send"), "absence alone is not definite non-submission"
    capture("not-forwarded-unknown")
    # Simulate closing the document and opening a fresh tab, with no copied
    # sessionStorage. The unresolved identity must not silently disappear.
    reopen_tab()
    time.sleep(.5)
    assert disabled("Send"), "fresh tab lost unresolved send identity and permits duplicate intent"
    assert any(p["requestId"] == saved[0]["requestId"] for p in pending()), "original request identity was lost"
    assert count_turns() == start
check("B: request never forwarded remains unknown, including fresh-tab recovery", unknown_before)

(evidence / "native-turns.jsonl").write_text((Path(fixture["home"]) / "native-turns.jsonl").read_text())
print(json.dumps(results, indent=2))
os.kill(fixture["fixturePid"], 15)
deadline = time.monotonic() + 45
while time.monotonic() < deadline:
    if json.loads((evidence / "report.json").read_text()).get("finishedAt"):
        break
    time.sleep(.2)
else:
    raise AssertionError("Fixture teardown did not finish")
