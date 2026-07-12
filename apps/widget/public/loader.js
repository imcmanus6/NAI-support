/**
 * NAI widget loader — drop-in embed for any host page.
 *
 *   <script>window.NAI = { getToken: () => yourTokenPromise }</script>   // JWT hosts
 *   <script src="https://cdn.nai.dev/loader.js"></script>
 *
 * or, for cookie-session hosts:
 *   <script src="https://cdn.nai.dev/loader.js" data-token-url="/api/support/token"></script>
 *
 * It (1) creates the launcher, (2) mounts the chat iframe with the identity token
 * in the URL hash, and (3) records the HOST page's console/network/errors and hands
 * a snapshot to the widget when a ticket is raised. No framework required.
 */
(function () {
  if (window.__NAI_LOADED__) return
  window.__NAI_LOADED__ = true

  var script = document.currentScript || (function () {
    var s = document.getElementsByTagName('script'); return s[s.length - 1]
  })()
  var origin = new URL(script.src).origin
  var tokenUrl = script.getAttribute('data-token-url')
  var accent = script.getAttribute('data-accent') || '#4f46e5'

  // ── Recorder: capture the host page's console / network / errors ────────────
  var consoleBuf = [], netBuf = [], errBuf = []
  function push(buf, item, cap) { buf.push(item); if (buf.length > cap) buf.shift() }
  function clip(s, n) { n = n || 300; return s.length > n ? s.slice(0, n) + '…' : s }
  function stripQ(u) { var i = u.indexOf('?'); return i >= 0 ? u.slice(0, i) : u }
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now() }

  ;['error', 'warn'].forEach(function (level) {
    var orig = console[level].bind(console)
    console[level] = function () {
      try { push(consoleBuf, { level: level, message: clip(Array.prototype.map.call(arguments, String).join(' ')) }, 30) } catch (e) {}
      orig.apply(console, arguments)
    }
  })
  window.addEventListener('error', function (e) { push(errBuf, { message: clip(e.message || String(e.error)) }, 20) })
  window.addEventListener('unhandledrejection', function (e) { push(errBuf, { message: clip('Unhandled rejection: ' + String(e.reason)) }, 20) })

  if (window.fetch) {
    var origFetch = window.fetch.bind(window)
    window.fetch = function () {
      var args = arguments, start = now(), input = args[0]
      var method = ((args[1] && args[1].method) || (input && input.method) || 'GET').toUpperCase()
      var raw = typeof input === 'string' ? input : (input && input.url) || String(input)
      var url = stripQ(raw)
      return origFetch.apply(window, args).then(function (res) {
        push(netBuf, { method: method, url: url, status: res.status, ms: Math.round(now() - start) }, 30); return res
      }, function (err) {
        push(netBuf, { method: method, url: url, status: 0, ms: Math.round(now() - start) }, 30); throw err
      })
    }
  }
  function diagnostics() { return { console: consoleBuf.slice(), network: netBuf.slice(), errors: errBuf.slice() } }

  // ── Identity token: host-provided hook, or a cookie-session endpoint ────────
  function getToken() {
    if (window.NAI && typeof window.NAI.getToken === 'function') {
      return Promise.resolve().then(function () { return window.NAI.getToken() })
    }
    if (tokenUrl) {
      return fetch(tokenUrl, { method: 'POST', credentials: 'include' })
        .then(function (r) { return r.ok ? r.json() : null })
        .then(function (d) { return d && d.token })
    }
    return Promise.resolve(null)  // no token → widget runs anonymously
  }

  // ── UI: launcher button + iframe panel ──────────────────────────────────────
  // data-launcher="none" hides the auto bubble; the host triggers via window.NAI.open().
  // data-position: "bottom-right" (default), "bottom-left", or a bottom offset in px
  // (e.g. "96" to stack above another bubble like Briefly's Blink).
  function css(el, s) { for (var k in s) el.style[k] = s[k] }
  var open = false, mounted = false, iframe = null
  var recStop = null, recEvents = [], recBar = null, recStart = 0
  var showLauncher = script.getAttribute('data-launcher') !== 'none'
  var position = script.getAttribute('data-position') || 'bottom-right'
  var side = position === 'bottom-left' ? { left: '20px' } : { right: '20px' }
  var btnBottom = /^\d+$/.test(position) ? position + 'px' : '20px'
  var panelBottom = /^\d+$/.test(position) ? (parseInt(position, 10) + 68) + 'px' : '88px'

  var panel = document.createElement('div')
  css(panel, {
    position: 'fixed', bottom: panelBottom, zIndex: 2147483000,
    width: '400px', maxWidth: 'calc(100vw - 40px)', height: '640px', maxHeight: 'calc(100vh - 120px)',
    borderRadius: '18px', overflow: 'hidden', boxShadow: '0 24px 60px rgba(0,0,0,.24)', display: 'none'
  })
  css(panel, side)

  function mount() {
    if (mounted) return
    mounted = true
    getToken().catch(function () { return null }).then(function (token) {
      iframe = document.createElement('iframe')
      iframe.title = 'Support'
      css(iframe, { width: '100%', height: '100%', border: 'none' })
      iframe.src = origin + (token ? '#token=' + encodeURIComponent(token) : '')
      panel.appendChild(iframe)
    })
  }

  // ── Session recording (rrweb) — captures the HOST page so a ticket is reproducible ──
  function loadRrweb(cb) {
    if (window.rrweb && window.rrweb.record) return cb()
    var s = document.createElement('script')
    s.src = 'https://cdn.jsdelivr.net/npm/rrweb@2.0.0-alpha.4/dist/rrweb.min.js'
    s.onload = function () { cb() }
    s.onerror = function () { cb(new Error('rrweb failed to load')) }
    document.head.appendChild(s)
  }
  function startRecording() {
    closeWidget()   // get out of the way so the user can reproduce the issue
    loadRrweb(function (err) {
      if (err || !window.rrweb) { openWidget(); return }
      recEvents = []; recStart = Date.now()
      recStop = window.rrweb.record({ emit: function (e) { recEvents.push(e) } })
      showRecBar()
    })
  }
  function finishRecording() {
    if (recStop) { try { recStop() } catch (e) {} recStop = null }
    if (recBar) { recBar.remove(); recBar = null }
    var payload = { events: recEvents, meta: { url: location.href, duration_ms: Date.now() - recStart, events: recEvents.length } }
    openWidget()
    if (iframe && iframe.contentWindow) iframe.contentWindow.postMessage({ type: 'nai:record-events', data: payload }, '*')
  }
  function showRecBar() {
    recBar = document.createElement('div')
    css(recBar, {
      position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)', zIndex: 2147483002,
      background: '#171a21', color: '#fff', border: '1px solid ' + accent, borderRadius: '999px',
      padding: '8px 14px', display: 'flex', alignItems: 'center', gap: '10px',
      font: '13px ui-monospace, monospace', boxShadow: '0 8px 24px rgba(0,0,0,.3)'
    })
    var dot = document.createElement('span')
    css(dot, { width: '9px', height: '9px', borderRadius: '50%', background: '#ef4444' })
    var label = document.createElement('span'); label.textContent = 'Recording — reproduce the issue'
    var stop = document.createElement('button'); stop.textContent = 'Stop & attach'
    css(stop, { background: accent, color: '#fff', border: 'none', borderRadius: '999px', padding: '5px 12px', cursor: 'pointer', font: 'inherit' })
    stop.addEventListener('click', finishRecording)
    recBar.appendChild(dot); recBar.appendChild(label); recBar.appendChild(stop)
    document.body.appendChild(recBar)
  }
  function openWidget() { open = true; panel.style.display = 'block'; if (btn) btn.textContent = '×'; mount() }
  function closeWidget() { open = false; panel.style.display = 'none'; if (btn) btn.textContent = '💬' }
  function toggle() { open ? closeWidget() : openWidget() }

  var btn = null
  if (showLauncher) {
    btn = document.createElement('button')
    btn.setAttribute('aria-label', 'Support')
    btn.textContent = '💬'
    css(btn, {
      position: 'fixed', bottom: btnBottom, zIndex: 2147483001,
      width: '56px', height: '56px', borderRadius: '50%', border: 'none', cursor: 'pointer',
      background: accent, color: '#fff', fontSize: '22px', boxShadow: '0 8px 24px rgba(0,0,0,.24)'
    })
    css(btn, side)
    btn.addEventListener('click', toggle)
  }

  // Expose a programmatic API so the host can trigger support from its own UI
  // (a Help menu, a "?" icon, etc.) — preserving any getToken hook the host set.
  var NAI = window.NAI = window.NAI || {}
  NAI.open = openWidget
  NAI.close = closeWidget
  NAI.toggle = toggle

  function attach() {
    document.body.appendChild(panel)
    if (btn) document.body.appendChild(btn)
  }
  if (document.body) attach()
  else document.addEventListener('DOMContentLoaded', attach)

  // ── Answer the widget's request for the host recording ──────────────────────
  window.addEventListener('message', function (e) {
    var d = e.data
    if (!d) return
    if (d.type === 'support:get-diagnostics' && e.source) {
      e.source.postMessage({ type: 'support:diagnostics', id: d.id, data: diagnostics() }, '*')
    } else if (d.type === 'nai:record-start') {
      startRecording()
    }
  })
})();
