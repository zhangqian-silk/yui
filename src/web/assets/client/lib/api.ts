export const API_SCRIPT = String.raw`
// Loopback API client. Every request carries the page token; a write is keyed
// so an unresolved submission can never be silently replayed from this page.
const token = document.querySelector('meta[name="yui-web-token"]').content;
const unresolved = new Set();

export function pageToken() { return token; }

export async function requestJson(path, options) {
  const response = await fetch(path, {
    ...options,
    headers: {
      accept: "application/json",
      "x-yui-web-token": token,
      ...(options && options.headers ? options.headers : {})
    }
  });
  if (!response.ok) {
    let message = "HTTP " + response.status;
    let disposition = "unknown";
    try {
      const body = await response.json();
      if (body && body.error) message = body.error;
      if (body && body.disposition === "not-submitted") disposition = "not-submitted";
    } catch {}
    throw Object.assign(new Error(message), { disposition, status: response.status });
  }
  return response.json();
}

function postJson(path, body, signal) {
  return requestJson(path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    ...(signal ? { signal } : {})
  });
}

// A key stays blocked until the server either answers or proves the request
// was not submitted; an unknown outcome must be inspected, not resent.
export async function submitMutation(key, path, body) {
  if (unresolved.has(key)) {
    throw Object.assign(new Error("An earlier submission is unresolved; read current facts first."), { disposition: "blocked" });
  }
  unresolved.add(key);
  try {
    const receipt = await postJson(path, body);
    unresolved.delete(key);
    return receipt;
  } catch (error) {
    if (error.disposition === "not-submitted") unresolved.delete(key);
    throw error;
  }
}

export function releaseMutation(key) { unresolved.delete(key); }

const task = function (taskId) { return "/api/tasks/" + encodeURIComponent(taskId); };

export const api = {
  searchBodies: function (query) { return requestJson("/api/search?" + query); },
  dashboard: function (query) { return requestJson("/api/dashboard?" + query); },
  pageSessions: function (query) {
    return requestJson("/api/dashboard/sessions?" + query, { signal: AbortSignal.timeout(5000) });
  },
  context: function (taskId) { return requestJson(task(taskId) + "/context"); },
  workbench: function (taskId) { return requestJson(task(taskId) + "/workbench"); },
  observation: function (taskId) { return requestJson(task(taskId) + "?compact=true", { signal: AbortSignal.timeout(1500) }); },
  projects: function (after) { return requestJson("/api/projects" + (after ? "?after=" + encodeURIComponent(after) : "")); },
  createTask: function (input) { return submitMutation("task/create", "/api/tasks", input); },
  taskAction: function (taskId, action, requestId) {
    return submitMutation(taskId + "/" + action, task(taskId) + "/" + action, { requestId });
  },
  inspect: async function (taskId, ref) {
    const query = new URLSearchParams({ store: ref.store, ref: ref.refId });
    if (ref.digest) query.set("digest", ref.digest);
    let result = await requestJson(task(taskId) + "/inspect?" + query);
    if (!result.contentPage) return result;
    const source = result.contentPage.source;
    const digest = result.contentPage.digest;
    let text = "";
    while (true) {
      const page = result.contentPage;
      if (!page || page.source !== source || page.digest !== digest || page.encoding !== "json"
        || page.offset !== text.length || typeof page.text !== "string" || !page.text.length) {
        throw new Error("Original read changed or returned an invalid page; refresh its Context reference.");
      }
      text += page.text;
      if (page.complete) return JSON.parse(text);
      if (!page.nextCursor) throw new Error("Original read is incomplete; refresh its Context reference.");
      query.set("cursor", page.nextCursor);
      result = await requestJson(task(taskId) + "/inspect?" + query);
    }
  },
  // One page of a Context family: summaries and exact references, no bodies.
  list: function (taskId, store, options) {
    const query = new URLSearchParams({ store: store });
    ["status", "cursor", "limit"].forEach(function (key) {
      if (options && options[key] !== undefined && options[key] !== null) query.set(key, String(options[key]));
    });
    return requestJson(task(taskId) + "/list?" + query);
  },
  artifacts: function (taskId) { return requestJson(task(taskId) + "/artifacts"); },
  artifact: function (taskId, path, commit) {
    return requestJson(task(taskId) + "/artifacts?" + new URLSearchParams({ path, commit }));
  },
  evidence: function (taskId) { return requestJson(task(taskId) + "/evidence"); },
  panels: function (taskId) { return requestJson(task(taskId) + "/panels", { signal: AbortSignal.timeout(3000) }); },
  readPanel: function (taskId, ref, input) {
    return postJson(task(taskId) + "/panels", { ref, input }, AbortSignal.timeout(3000));
  },
  sendMessage: function (taskId, body, requestId, intent) {
    return submitMutation(taskId + "/messages", task(taskId) + "/messages",
      { body, requestId, ...(intent === undefined ? {} : { intent }) });
  },
  control: function (taskId, payload) {
    return submitMutation(taskId + "/control/" + payload.requestId, task(taskId) + "/control", payload);
  },
  updateTask: function (taskId, patch, requestId) {
    return submitMutation(taskId + "/metadata", task(taskId) + "/metadata", { patch, requestId });
  },
  answerInput: function (taskId, inputId, answer) {
    return submitMutation(taskId + "/input/" + inputId,
      task(taskId) + "/inputs/" + encodeURIComponent(inputId) + "/answer", answer);
  },
  globalState: function (role) { return requestJson("/api/roles/" + encodeURIComponent(role) + "/control"); },
  globalControl: function (role, input) {
    return submitMutation("global/" + role, "/api/roles/" + encodeURIComponent(role) + "/control", input);
  }
};
`;
