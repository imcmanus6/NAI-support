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
  var open = false, mounted = false
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
      var iframe = document.createElement('iframe')
      iframe.title = 'Support'
      css(iframe, { width: '100%', height: '100%', border: 'none' })
      iframe.src = origin + (token ? '#token=' + encodeURIComponent(token) : '')
      panel.appendChild(iframe)
    })
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
    if (d && d.type === 'support:get-diagnostics' && e.source) {
      e.source.postMessage({ type: 'support:diagnostics', id: d.id, data: diagnostics() }, '*')
    }
  })
})();
