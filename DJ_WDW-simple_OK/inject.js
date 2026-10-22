// Runs inside the claude.ai page itself (so it can wrap fetch).
// Job: when Claude finishes a reply, grab the usage report hidden at the end of the
// reply stream (the "message_limit" event) and pass it to content.js.

(() => {
  if (window.__usageMeterWrapped) return; // never wrap twice
  window.__usageMeterWrapped = true;

  // Matches: /api/organizations/<org>/chat_conversations/<chat>/completion
  const COMPLETION_URL = /\/api\/organizations\/([^/]+)\/chat_conversations\/([^/]+)\/(?:retry_)?completion(?:\?|$)/;
  const originalFetch = window.fetch;

  window.fetch = function (input, init) {
    const promise = originalFetch.apply(this, arguments); // the page gets its response untouched
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
      const match = method === "POST" && COMPLETION_URL.exec(url);
      if (match) promise.then((res) => readReply(res, match[1], match[2]), () => {});
    } catch (e) {}
    return promise;
  };

  async function readReply(res, orgId, convId) {
    try {
      const isStream = (res.headers.get("content-type") || "").includes("event-stream");
      if (!res.ok || !isStream || !res.body) return;

      let messageLimit = null;
      const lookAtLine = (line) => {
        if (!line.startsWith("data:") || !line.includes("message_limit")) return;
        try {
          const data = JSON.parse(line.slice(5));
          if (data.type === "message_limit") messageLimit = data.message_limit;
        } catch (e) {}
      };

      // Read a COPY of the stream line by line, so the page's own reading is not affected.
      const reader = res.clone().body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          lookAtLine(buffer.slice(0, newline).trim());
          buffer = buffer.slice(newline + 1);
        }
      }
      lookAtLine(buffer.trim());

      window.postMessage({ source: "usage-meter", orgId, convId, messageLimit }, window.location.origin);
    } catch (e) {
      console.log("[usage-meter] could not read reply", e);
    }
  }
})();
