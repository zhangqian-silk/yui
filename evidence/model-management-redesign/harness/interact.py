import time, json
R = {}
def setvp(w, h): cdp("Emulation.setDeviceMetricsOverride", width=w, height=h, deviceScaleFactor=1, mobile=w < 700)
def go(u): goto_url(u); wait_for_load(); time.sleep(2.0)
def key(k, code, vk):
    cdp("Input.dispatchKeyEvent", type="keyDown", key=k, code=code, windowsVirtualKeyCode=vk, text="\r")
    cdp("Input.dispatchKeyEvent", type="keyUp", key=k, code=code, windowsVirtualKeyCode=vk)
S = "/tmp/yui-t150-wi6/ev/"
# 1 draft retention + dirty markers
setvp(1365, 800); go("http://127.0.0.1:4301/models/roles")
R["draft"] = js("""(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rows = [...document.querySelectorAll('#role-access-host .access-row')];
  rows[0].click(); await sleep(900);
  const insp = document.querySelector('.agent-inspector');
  const inp = [...insp.querySelectorAll('input[type=text], input:not([type])')].find(e => !e.disabled && e.offsetParent);
  const before = inp.value; inp.value = 'draft-model-x'; inp.dispatchEvent(new Event('input', {bubbles: true})); await sleep(300);
  const out = { row0: rows[0].textContent.trim().slice(0, 40), field: inp.name || inp.id, before,
    detail: document.querySelector('[data-detail]')?.dataset.detail,
    indicator: insp.querySelector('.agent-dirty-indicator')?.textContent,
    rowBadge: document.querySelector('#role-access-host .access-row .badge.tone-warn')?.textContent || null,
    navDirty: [...document.querySelectorAll('[data-section][data-dirty=true]')].map(e => e.dataset.section) };
  rows[1].click(); await sleep(700);
  document.querySelector('[data-section=agents]').click(); await sleep(900);
  out.onAgentsUrl = location.pathname;
  document.querySelector('[data-section=roles]').click(); await sleep(900);
  [...document.querySelectorAll('#role-access-host .access-row')][0].click(); await sleep(900);
  const inp2 = [...document.querySelector('.agent-inspector').querySelectorAll('input')].find(e => e.value === 'draft-model-x');
  out.retainedAfterSwitch = !!inp2; out.backUrl = location.pathname;
  return JSON.stringify(out); })()""")
capture_screenshot(S + "i1-1365-draft-retained.png")
# 2 keyboard
go("http://127.0.0.1:4301/models/roles")
js("document.querySelectorAll('#role-access-host .access-row')[1].focus()")
key("Enter", "Enter", 13); time.sleep(1.0)
k = json.loads(js("""JSON.stringify({ active: document.activeElement.className, detail: document.querySelector('[data-detail]')?.dataset.detail,
  focusVisible: document.activeElement.matches(':focus-visible') })"""))
capture_screenshot(S + "i2-1365-keyboard-open.png")
js("document.querySelector('.access-back').focus()"); key("Enter", "Enter", 13); time.sleep(0.8)
k.update(json.loads(js("""JSON.stringify({ afterClose: document.activeElement.className, afterCloseIdx: [...document.querySelectorAll('#role-access-host .access-row')].indexOf(document.activeElement), detailAfter: document.querySelector('[data-detail]')?.dataset.detail })""")))
js("document.activeElement.focus()"); time.sleep(0.3); capture_screenshot(S + "i2-1365-focus-restored.png")
R["keyboard"] = k
# 3 expand collapsed
R["expand"] = js("""(async () => { const sleep = ms => new Promise(r => setTimeout(r, ms));
  document.querySelectorAll('#role-access-host .access-row')[0].click(); await sleep(900);
  const d = document.querySelector('.agent-inspector details.agent-config-more'); if (!d) return JSON.stringify({found:false});
  const before = d.open; d.querySelector('summary').click(); await sleep(300);
  d.scrollIntoView({block:'center'}); return JSON.stringify({found:true, title: d.querySelector('summary').textContent, before, after: d.open, fields: d.querySelectorAll('input,select,textarea').length}); })()""")
capture_screenshot(S + "i3-1365-expanded.png")
# 4 mobile detail/back + touch sizes
setvp(390, 844); go("http://127.0.0.1:4301/models/roles")
R["mobile"] = js("""(async () => { const sleep = ms => new Promise(r => setTimeout(r, ms));
  const row = document.querySelectorAll('#role-access-host .access-row')[0]; row.click(); await sleep(1000);
  const list = document.querySelector('#role-access-host .access-list, .agent-index');
  const out = { detail: document.querySelector('[data-detail]')?.dataset.detail, listVisible: !!(list && list.offsetParent && list.getBoundingClientRect().height > 0),
    active: document.activeElement.className, backTop: Math.round(document.querySelector('.access-back').getBoundingClientRect().top),
    docW: document.documentElement.scrollWidth };
  const btns = [...document.querySelectorAll('#manage-main button, #manage-main summary, #manage-main input, #manage-main select')].filter(e => e.offsetParent).map(e => Math.round(e.getBoundingClientRect().height));
  out.minControlH = Math.min(...btns); out.controls = btns.length;
  out.small = [...document.querySelectorAll('#manage-main button, #manage-main summary, #manage-main input, #manage-main select')].filter(e => e.offsetParent && e.getBoundingClientRect().height < 32).map(e => (e.type || e.tagName) + ':' + Math.round(e.getBoundingClientRect().height)).slice(0, 12); return JSON.stringify(out); })()""")
capture_screenshot(S + "i4-390-detail.png")
js("document.querySelector('.access-back').click()"); time.sleep(0.8)
R["mobileBack"] = js("""JSON.stringify({ detail: document.querySelector('[data-detail]')?.dataset.detail, active: document.activeElement.className })""")
# 5 guide on mobile
R["guide"] = js("""(async () => { const sleep = ms => new Promise(r => setTimeout(r, ms));
  document.querySelectorAll('#role-access-host .access-row')[0].click(); await sleep(1000);
  const g = [...document.querySelectorAll('.agent-inspector button')].find(b => /Operator/.test(b.textContent)); g.click(); await sleep(500);
  const dlg = document.querySelector('dialog.guide-dialog[open]'); const ta = dlg.querySelector('textarea'); const copy = [...dlg.querySelectorAll('.btn-primary')].pop();
  const emptyDisabled = copy.disabled;
  ta.value = '把这个角色的新会话模型改成 gpt-6-sol'; ta.dispatchEvent(new Event('input', {bubbles:true})); await sleep(200);
  const ok = { enabled: !copy.disabled, previewHasIntent: dlg.querySelector('pre').textContent.includes('gpt-6-sol'), previewLen: dlg.querySelector('pre').textContent.length };
  const r = dlg.getBoundingClientRect();
  const out = { emptyDisabled, ...ok, dlgW: Math.round(r.width), vw: innerWidth };
  window.__ta = ta; return JSON.stringify(out); })()""")
capture_screenshot(S + "i5-390-guide.png")
R["guideSecret"] = js("""(async () => { const ta = window.__ta; ta.value = 'use key sk-ABCDEFGHIJKLMNOPQRSTUVWX1234'; ta.dispatchEvent(new Event('input', {bubbles:true})); await new Promise(r => setTimeout(r, 200));
  const dlg = ta.closest('dialog'); const copy = [...dlg.querySelectorAll('.btn-primary')].pop();
  const res = { copyDisabled: copy.disabled, status: dlg.querySelector('.guide-result').textContent, previewLeaks: dlg.querySelector('pre').textContent.includes('sk-ABCDEF') };
  dlg.querySelector('.guide-close').click(); await new Promise(r => setTimeout(r, 200));
  res.afterClose = document.activeElement.textContent.trim().slice(0, 30); return JSON.stringify(res); })()""")
# 6 readonly
setvp(1365, 800); go("http://127.0.0.1:4302/models/roles")
R["readonly"] = js("""(async () => { const sleep = ms => new Promise(r => setTimeout(r, ms));
  document.querySelectorAll('#role-access-host .access-row')[0].click(); await sleep(1000);
  const insp = document.querySelector('.agent-inspector'); const f = [...insp.querySelectorAll('input,select,textarea')];
  const save = [...insp.querySelectorAll('button')].find(b => /保存|Save/.test(b.textContent));
  return JSON.stringify({ fields: f.length, enabledFields: f.filter(e => !e.disabled && !e.readOnly).map(e => e.type + ':' + (e.closest('[data-field]')?.dataset.field || e.className)), saveDisabled: save ? save.disabled : null,
    snapshot: document.querySelector('#role-access-snapshot')?.textContent.trim().slice(0, 80) }); })()""")
capture_screenshot(S + "i6-1365-readonly-detail.png")
# 7 nomodels services
go("http://127.0.0.1:4304/models/providers")
R["nomodels"] = js("""JSON.stringify({ alerts: [...document.querySelectorAll('#manage-main [role=alert], #manage-main .tone-error, #manage-main .alert')].map(e => e.textContent.trim().slice(0, 120)).slice(0, 4) })""")
capture_screenshot(S + "i7-1365-nomodels-services.png")
print(json.dumps(R, ensure_ascii=False, indent=1))
