/**
 * JavaScript expressions evaluated via Runtime.evaluate on the BUN_INSPECT
 * WebSocket connection. These intercept JSON.stringify to capture Claude Code's
 * internal state transitions with ~2-6ms latency.
 *
 * INSTALL_HOOK: Wraps JSON.stringify to capture serializations >30 chars.
 *   Also hooks process.stdin for raw keystroke capture.
 *   Tracks subagents via agentId field routing — subagent events carry
 *   an agentId that identifies them (no separate process needed).
 * POLL_STATE: Reads and drains the captured state buffer.
 */

/**
 * Runtime.evaluate expression that wraps JSON.stringify to intercept
 * Claude Code's internal event serializations.
 *
 * Subagent tracking: Agent tool_use → queues description in pendingDescs →
 * first event with a new obj.agentId creates a sub entry, pops description.
 * Routing is direct via agentId (no stack needed — each event is tagged).
 *
 * Stores in globalThis.__inspectorState as structured object with
 * ring buffer (50 events max).
 *
 * Idempotent — checks globalThis.__inspectorInstalled before installing.
 * Returns 'ok' on success, 'already' if already installed.
 */
export const INSTALL_HOOK = `(function() {
  if (globalThis.__inspectorInstalled) return 'already';
  globalThis.__inspectorInstalled = true;

  var state = {
    n: 0,
    sid: null,
    cost: 0,
    model: null,
    stop: null,
    tools: [],
    inTok: 0,
    outTok: 0,
    events: [],
    lastEvent: null,
    firstMsg: null,
    lastText: null,
    userPrompt: null,
    permPending: false,
    idleDetected: false,
    toolAction: null,
    turnHasTools: false,
    inputBuf: '',
    inputTs: 0,
    pendingDescs: [],
    subs: [],
    slashCmd: null,
    _sealed: false
  };
  globalThis.__inspectorState = state;

  // Shared helper: format tool_use name + input into a human-readable action string.
  var toolActionKeys = {
    Bash: 'command', Read: 'file_path', Write: 'file_path', Edit: 'file_path',
    Grep: 'pattern', Glob: 'pattern', Agent: 'description'
  };
  function fmtToolAction(name, inp) {
    var key = toolActionKeys[name];
    if (key && inp[key]) return name + ': ' + (inp[key] || '').slice(0, 80);
    return name;
  }

  var origStringify = JSON.stringify;
  JSON.stringify = function(value) {
    var result = origStringify.apply(this, arguments);
    try {
      if (typeof result === 'string' && result.length > 30) {
        var obj = typeof value === 'object' && value !== null ? value : null;
        if (obj) {
          // Notification and hook events — check on any object regardless of type
          if (obj.notification_type === 'permission_prompt') state.permPending = true;
          if (obj.notification_type === 'idle_prompt') state.idleDetected = true;
          if (obj.hook_event_name === 'UserPromptSubmit') {
            var hp = obj.prompt || '';
            if (typeof hp === 'string' && hp) {
              state.userPrompt = hp.slice(0, 200);
              if (hp.charAt(0) === '/') state.slashCmd = hp.split(' ')[0].slice(0, 50);
            }
          }

          if (obj.type) {
            state.n++;

            // ── Route by agentId ──
            // Subagent events carry obj.agentId; main events don't.
            var curSub = null;
            if (obj.agentId) {
              for (var sk = 0; sk < state.subs.length; sk++) {
                if (state.subs[sk].sid === obj.agentId) { curSub = state.subs[sk]; break; }
              }
              if (!curSub) {
                // New subagent — evict oldest idle to bound at 20
                while (state.subs.length >= 20) {
                  var evicted = false;
                  for (var se = 0; se < state.subs.length; se++) {
                    if (state.subs[se].st === 'i') { state.subs.splice(se, 1); evicted = true; break; }
                  }
                  if (!evicted) break;
                }
                var sdesc = state.pendingDescs.length > 0 ? state.pendingDescs.shift() : 'Agent';
                curSub = { sid: obj.agentId, desc: sdesc, st: 's', tok: 0, act: null, msgs: [], lastTs: Date.now() };
                state.subs.push(curSub);
              }
            }

            if (curSub) {
              // ── Subagent event routing ──
              curSub.lastTs = Date.now();

              if (obj.type === 'assistant' && obj.message) {
                var smsg = obj.message;
                if (smsg.stop_reason === 'tool_use') curSub.st = 'u';
                else if (smsg.stop_reason === 'end_turn') curSub.st = 'i';
                else curSub.st = 't';
                if (smsg.usage) {
                  curSub.tok += (smsg.usage.input_tokens || 0) + (smsg.usage.cache_creation_input_tokens || 0) + (smsg.usage.output_tokens || 0);
                }
                var sc = smsg.content;
                if (Array.isArray(sc)) {
                  for (var si = 0; si < sc.length; si++) {
                    if (sc[si].type === 'text' && sc[si].text) {
                      curSub.msgs.push({r: 'a', x: sc[si].text.slice(0, 4000)});
                    }
                    if (sc[si].type === 'tool_use') {
                      var sinp = sc[si].input || {};
                      var sact = fmtToolAction(sc[si].name, sinp);
                      if (sc[si].name === 'Agent' && sinp.description) {
                        state.pendingDescs.push(sinp.description.slice(0, 100));
                      }
                      curSub.act = sact;
                      curSub.msgs.push({r: 't', x: (sinp.command || sinp.file_path || sinp.pattern || sinp.description || '').slice(0, 4000), tn: sc[si].name});
                    }
                  }
                }
                if (curSub.msgs.length > 200) curSub.msgs = curSub.msgs.slice(-200);
              }

              if (obj.type === 'user' && obj.message) {
                curSub.st = 't';
                var suc = obj.message.content;
                if (Array.isArray(suc)) {
                  for (var sl = 0; sl < suc.length; sl++) {
                    if (suc[sl].type === 'tool_result') {
                      var srt = typeof suc[sl].content === 'string' ? suc[sl].content : '';
                      if (Array.isArray(suc[sl].content)) {
                        srt = '';
                        for (var sm = 0; sm < suc[sl].content.length; sm++) {
                          if (suc[sl].content[sm].text) srt += suc[sl].content[sm].text;
                        }
                      }
                      if (srt) curSub.msgs.push({r: 't', x: srt.slice(0, 4000), tn: 'result'});
                    }
                  }
                  if (curSub.msgs.length > 200) curSub.msgs = curSub.msgs.slice(-200);
                }
              }

              if (obj.type === 'result') {
                curSub.st = 'i';
              }
            } else {
              // ── Main event routing ──
              var txtSnippet = null;
              var toolAct = null;

              // System event for main session
              if (obj.type === 'system' && obj.sessionId) {
                state.sid = obj.sessionId;
              }

              // Assistant message
              if (obj.type === 'assistant' && obj.message) {
                var msg = obj.message;
                if (msg.model) state.model = msg.model;
                if (msg.usage) {
                  state.inTok += (msg.usage.input_tokens || 0) + (msg.usage.cache_creation_input_tokens || 0);
                  state.outTok += (msg.usage.output_tokens || 0);
                }
                if (!state._sealed) {
                  if (msg.stop_reason) state.stop = msg.stop_reason;
                  var content = msg.content;
                  if (Array.isArray(content)) {
                    var toolNames = [];
                    for (var i = 0; i < content.length; i++) {
                      if (content[i].type === 'tool_use') {
                        var tn = content[i].name;
                        toolNames.push(tn);
                        var inp = content[i].input || {};
                        toolAct = fmtToolAction(tn, inp);
                        if (tn === 'Agent' && inp.description) {
                          state.pendingDescs.push(inp.description.slice(0, 100));
                        }
                      }
                      if (content[i].type === 'text' && content[i].text) {
                        txtSnippet = content[i].text;
                      }
                    }
                    if (toolNames.length > 0) { state.tools = toolNames; state.turnHasTools = true; }
                    if (txtSnippet) state.lastText = txtSnippet.slice(-300);
                    if (toolAct) state.toolAction = toolAct;
                  }
                }
              }

              // Result (turn end with cost)
              if (obj.type === 'result') {
                if (typeof obj.total_cost_usd === 'number') state.cost = obj.total_cost_usd;
                state.stop = 'end_turn';
                state._sealed = true;
              }

              // User event (tool_result or new prompt)
              if (obj.type === 'user') {
                var userText = '';
                var isToolResult = false;
                var uc = obj.message && obj.message.content;
                if (typeof uc === 'string') {
                  userText = uc;
                } else if (Array.isArray(uc)) {
                  for (var k = 0; k < uc.length; k++) {
                    if (uc[k].type === 'tool_result') isToolResult = true;
                    if (uc[k].type === 'text' && uc[k].text) { userText = uc[k].text; break; }
                  }
                }
                if (userText && !isToolResult) {
                  txtSnippet = userText;
                  state.userPrompt = userText.slice(0, 200);
                  if (!state.firstMsg) state.firstMsg = userText.slice(0, 200);
                }
                state.inputBuf = '';
                state.stop = null;
                state.tools = [];
                state._sealed = false;
                state.idleDetected = false;
                state.permPending = false;
                if (!isToolResult) state.turnHasTools = false;
              }

              // Ring buffer of last 50 state-carrying main events.
              if (obj.type === 'user' || obj.type === 'result' || (obj.type === 'assistant' && !state._sealed)) {
                state.lastEvent = obj.type;
                var evt = { t: obj.type };
                if (obj.type === 'assistant' && obj.message && obj.message.stop_reason) {
                  evt.sr = obj.message.stop_reason;
                }
                if (obj.type === 'result' && typeof obj.total_cost_usd === 'number') {
                  evt.c = obj.total_cost_usd;
                }
                if (txtSnippet) evt.txt = (typeof txtSnippet === 'string' ? txtSnippet : '').slice(0, 100);
                if (toolAct) evt.ta = toolAct;
                state.events.push(evt);
                if (state.events.length > 50) state.events.shift();
              }
            }
          }
        }
      }
    } catch(e) {}
    return result;
  };

  // Stdin hook: capture raw keystrokes for input buffer
  try {
    var stdinHandler = function(chunk) {
      var ch = chunk.toString();
      if (ch === '\\r' || ch === '\\n') {
        state.inputBuf = '';
      } else if (ch === '\\x7f' || ch === '\\x08') {
        state.inputBuf = state.inputBuf.slice(0, -1);
      } else if (ch === '\\x03' || ch === '\\x1b') {
        state.inputBuf = '';
        // Interrupt signal: synthetic result event so poll derives idle.
        // If Claude continues processing, real events override on next cycle.
        state.events.push({ t: 'result' });
        if (state.events.length > 50) state.events.shift();
        state.lastEvent = 'result';
        state.stop = 'end_turn';
        state._sealed = false;
        state.permPending = false;
        state.toolAction = null;
        for (var si = 0; si < state.subs.length; si++) {
          if (state.subs[si].st !== 'i') state.subs[si].st = 'i';
        }
      } else if (ch === '\\x15') {
        state.inputBuf = '';
      } else if (ch.length === 1 && ch.charCodeAt(0) >= 32) {
        state.inputBuf += ch;
      }
      if (state.inputBuf.length > 500) state.inputBuf = state.inputBuf.slice(-500);
      state.inputTs = Date.now();
    };
    process.stdin.on('data', stdinHandler);
    globalThis.__inspectorStdinHandler = stdinHandler;
  } catch(e) {}

  // Bypass WebFetch domain blocklist (checkDomainBlocklist → axios → https.request)
  //
  // Why https.request and not globalThis.fetch:
  // Axios adapter selection (cli.js:33271) is ["xhr", "http", "fetch"].
  // In Bun, XHR is unavailable but process exists, so the "http" adapter wins.
  // The http adapter (cli.js:35441) does: tPf = v(require('https')), then
  // calls tPf.default.request(opts, callback) at line 35452.
  // Since it goes through the module object, replacing .request on the
  // shared require('https') singleton intercepts all axios HTTPS calls.
  try {
    var https = require('https');
    var origHttpsRequest = https.request;
    https.request = function(options) {
      var h = (options && options.hostname) || '';
      var p = (options && options.path) || '';
      if (h === 'api.anthropic.com' && p.indexOf('/api/web/domain_info') !== -1) {
        state.fetchBypassed = (state.fetchBypassed || 0) + 1;
        var EventEmitter = require('events');
        var res = new EventEmitter();
        res.statusCode = 200;
        res.headers = { 'content-type': 'application/json' };
        res.destroy = function() {};
        var req = new EventEmitter();
        req.write = function() {};
        req.end = function() {
          setTimeout(function() {
            req.emit('response', res);
            res.emit('data', Buffer.from(origStringify({ domain: h, can_fetch: true })));
            res.emit('end');
          }, 0);
        };
        req.abort = function() {};
        req.destroy = function() { return req; };
        req.on('error', function() {});
        req.setTimeout = function() { return req; };
        req.destroyed = false;
        if (typeof arguments[1] === 'function') {
          req.on('response', arguments[1]);
        }
        return req;
      }
      var origReq = origHttpsRequest.apply(this, arguments);
      var hardTimer = setTimeout(function() {
        if (!origReq.destroyed) {
          state.httpsTimeouts = (state.httpsTimeouts || 0) + 1;
          origReq.destroy(new Error('HTTPS hard timeout: request exceeded 90000ms'));
        }
      }, 90000);
      origReq.on('close', function() { clearTimeout(hardTimer); });
      return origReq;
    };
  } catch(e) {}

  // Timeout for non-streaming Anthropic API calls (WebFetch summarization path)
  //
  // Call path: summarizeContent() → callSmallModel() → Anthropic SDK → globalThis.fetch
  // Non-streaming calls lack "stream":true in body. Main conversation is streaming
  // and passes through untouched. Non-Anthropic URLs also pass through.
  try {
    var origFetch = globalThis.fetch;
    var FETCH_TIMEOUT = 120000;
    globalThis.fetch = function(input, init) {
      var url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
      if (url.indexOf('api.anthropic.com') === -1) {
        return origFetch.apply(globalThis, arguments);
      }
      var body = (init && init.body) || '';
      if (typeof body === 'string' && (body.indexOf('"stream":true') !== -1 || body.indexOf('"stream": true') !== -1)) {
        return origFetch.apply(globalThis, arguments);
      }
      var ac = new AbortController();
      var origSignal = (init && init.signal) || null;
      if (origSignal && origSignal.aborted) return origFetch.apply(globalThis, arguments);
      var onAbort = null;
      if (origSignal) {
        onAbort = function() { ac.abort(origSignal.reason); };
        origSignal.addEventListener('abort', onAbort);
      }
      var timer = setTimeout(function() {
        state.fetchTimeouts = (state.fetchTimeouts || 0) + 1;
        ac.abort(new Error('WebFetch timeout: non-streaming API call exceeded ' + FETCH_TIMEOUT + 'ms'));
      }, FETCH_TIMEOUT);
      var newInit = {};
      if (init) { var ks = Object.keys(init); for (var ki = 0; ki < ks.length; ki++) if (ks[ki] !== 'signal') newInit[ks[ki]] = init[ks[ki]]; }
      newInit.signal = ac.signal;
      var cleanup = function() { clearTimeout(timer); if (onAbort && origSignal) origSignal.removeEventListener('abort', onAbort); };
      return origFetch.call(globalThis, input, newInit).then(
        function(resp) { cleanup(); return resp; },
        function(err)  { cleanup(); throw err; }
      );
    };
  } catch(e) {}

  return 'ok';
})()`;

/**
 * Runtime.evaluate expression that installs tap hooks for deep inspection
 * of Claude Code internals. Push-based delivery via console.debug with
 * \\x00TAP prefix — no polling needed.
 *
 * parse and stringify are always on (drive state detection).
 * Other categories (console, fs, spawn, fetch, etc.) are opt-in via flags.
 *
 * Also installs:
 * - WebFetch domain blocklist bypass (checkDomainBlocklist → axios → https.request)
 * - HTTPS hard timeout (90s for external requests)
 * - Non-streaming Anthropic API timeout (120s for WebFetch summarization)
 *
 * Idempotent — checks globalThis.__tapsInstalled before installing.
 * Returns 'ok' on success, 'already' if already installed.
 */
export const INSTALL_TAPS = `(function() {
  if (globalThis.__tapsInstalled) return 'already';
  globalThis.__tapsInstalled = true;

  var flags = { parse: true, stringify: true, console: false, fs: false, spawn: false, fetch: false, exit: false, timer: false, stdout: false, stderr: false, require: false, bun: false, websocket: false, net: false, stream: false };
  globalThis.__tapFlags = flags;

  // Save originals BEFORE any wrapping — push() needs these to avoid recursion
  var origStringify = JSON.stringify;
  var origParse = JSON.parse;

  // ── TCP socket for TAP event delivery ──────────────────────────────────
  // Connects to the Rust TCP listener via TAP_PORT env var.
  // If TAP_PORT is not set (CLI running standalone), push() is a no-op.
  var tapPort = parseInt(process.env.TAP_PORT, 10);
  var tapSocket = null;
  var tapConnecting = false;
  var tapQueue = [];
  var tapDraining = true;

  // Expose tap connection state for diagnostics via Runtime.evaluate
  globalThis.__tapDiag = { port: tapPort, connected: false, queued: 0, errors: [] };

  function tapConnect() {
    if (tapConnecting || tapSocket || !tapPort) return;
    tapConnecting = true;
    try {
      // Bun runtime: use native Bun.connect (require is not available in Runtime.evaluate)
      // Test environment: globalThis.Bun is mocked
      Bun.connect({
        hostname: '127.0.0.1',
        port: tapPort,
        socket: {
          open: function(socket) {
            tapSocket = socket;
            tapConnecting = false;
            tapDraining = true;
            globalThis.__tapDiag.connected = true;
            for (var qi = 0; qi < tapQueue.length; qi++) {
              try { socket.write(tapQueue[qi]); } catch(e) {}
            }
            globalThis.__tapDiag.queued = 0;
            tapQueue = [];
          },
          data: function() {},
          close: function() {
            tapSocket = null;
            tapConnecting = false;
            globalThis.__tapDiag.connected = false;
          },
          error: function(socket, err) {
            tapSocket = null;
            tapConnecting = false;
            globalThis.__tapDiag.connected = false;
            globalThis.__tapDiag.errors.push('err:' + (err && err.message || err));
          },
          drain: function() { tapDraining = true; },
        },
      });
    } catch(e) { tapConnecting = false; globalThis.__tapDiag.errors.push('catch:' + (e && e.message || e)); }
  }

  tapConnect();

  function push(cat, d) {
    if (!tapPort) return;
    d.ts = Date.now();
    d.cat = cat;
    try {
      var line = origStringify(d) + '\\n';
      if (tapSocket) {
        if (tapDraining) {
          tapSocket.write(line);
        }
      } else {
        tapQueue.push(line);
        globalThis.__tapDiag.queued = tapQueue.length;
        if (tapQueue.length > 1000) tapQueue = tapQueue.slice(-500);
        tapConnect();
      }
    } catch(e) {
      tapSocket = null;
      tapQueue.push(origStringify(d) + '\\n');
      tapConnect();
    }
  }

  // 1. JSON.parse — all parsed JSON, unfiltered
  JSON.parse = function(text) {
    var result = origParse.apply(this, arguments);
    if (flags.parse) {
      try {
        if (typeof text === 'string') {
          push('parse', { len: text.length, snap: text.slice(0, 2000) });
        }
      } catch(e) {}
    }
    return result;
  };

  // 2. JSON.stringify — outgoing API requests, state serialization, IPC messages
  JSON.stringify = function(value) {
    var result = origStringify.apply(this, arguments);
    if (flags.stringify) {
      try {
        if (typeof result === 'string') {
          // Detect API request body — extract full system prompt (bypasses 2000-char snap truncation)
          if (value && value.model && Array.isArray(value.messages) && !value.costUSD && value.system) {
            var sysText = '';
            if (Array.isArray(value.system)) {
              for (var si = 0; si < value.system.length; si++) {
                sysText += (value.system[si].text || '');
              }
            } else if (typeof value.system === 'string') {
              sysText = value.system;
            }
            if (sysText.length > 0) {
              push('system-prompt', { text: sysText, model: value.model, msgCount: value.messages.length });
            }
          }
          // Detect status line payload — push full data bypassing 2000-char snap truncation
          if (value && value.hook_event_name === 'Status') {
            var m = value.model || {};
            var c = value.cost || {};
            var cw = value.context_window || {};
            var cu = cw.current_usage || {};
            var rl = value.rate_limits || {};
            var f5 = rl.five_hour || {};
            var f7 = rl.seven_day || {};
            var vm = value.vim || {};
            push('status-line', {
              sessionId: value.session_id || '',
              cwd: value.cwd || '',
              modelId: typeof m === 'object' ? (m.id || '') : (m || ''),
              modelDisplayName: typeof m === 'object' ? (m.display_name || '') : '',
              cliVersion: value.version || '',
              outputStyle: (value.output_style && value.output_style.name) || '',
              totalCostUsd: c.total_cost_usd || 0,
              totalDurationMs: c.total_duration_ms || 0,
              totalApiDurationMs: c.total_api_duration_ms || 0,
              totalLinesAdded: c.total_lines_added || 0,
              totalLinesRemoved: c.total_lines_removed || 0,
              totalInputTokens: cw.total_input_tokens || 0,
              totalOutputTokens: cw.total_output_tokens || 0,
              contextWindowSize: cw.context_window_size || 0,
              currentInputTokens: cu.input_tokens || 0,
              currentOutputTokens: cu.output_tokens || 0,
              cacheCreationInputTokens: cu.cache_creation_input_tokens || 0,
              cacheReadInputTokens: cu.cache_read_input_tokens || 0,
              contextUsedPercent: cw.used_percentage || 0,
              contextRemainingPercent: cw.remaining_percentage || 0,
              exceeds200kTokens: !!value.exceeds_200k_tokens,
              fiveHourUsedPercent: f5.used_percentage || 0,
              fiveHourResetsAt: f5.resets_at || 0,
              sevenDayUsedPercent: f7.used_percentage || 0,
              sevenDayResetsAt: f7.resets_at || 0,
              vimMode: vm.mode || '',
            });
          }
          push('stringify', { len: result.length, snap: result.slice(0, 2000) });
        }
      } catch(e) {}
    }
    return result;
  };

  // 3. Console hooks — Claude Code's internal debug output
  var methods = ['log', 'warn', 'error'];
  for (var mi = 0; mi < methods.length; mi++) {
    (function(method) {
      var orig = console[method];
      console[method] = function() {
        if (flags.console) {
          try {
            var parts = [];
            for (var ai = 0; ai < arguments.length; ai++) parts.push(String(arguments[ai]));
            var msg = parts.join(' ');
            if (msg.length > 0) push('console.' + method, { msg: msg.slice(0, 1000) });
          } catch(e) {}
        }
        return orig.apply(console, arguments);
      };
    })(methods[mi]);
  }

  // Shared helper: extract size + text preview from a buffer or string, skipping binary.
  function snip(raw) {
    var b = Buffer.isBuffer(raw) ? raw : null;
    var size = b ? b.length : (typeof raw === 'string' ? raw.length : 0);
    var content = null;
    if (b && size < 50000) {
      var isBin = false;
      var head = b.slice(0, 100);
      for (var i = 0; i < head.length; i++) { if (head[i] === 0) { isBin = true; break; } }
      if (!isBin) content = b.toString('utf8').slice(0, 500);
    } else if (typeof raw === 'string' && size < 50000) {
      content = raw.slice(0, 500);
    }
    return { size: size, content: content };
  }

  // 3. FS hooks — file I/O tracking (sync only + probing)
  try {
    var fs = require('fs');
    var origRead = fs.readFileSync;
    fs.readFileSync = function(path) {
      var result = origRead.apply(this, arguments);
      if (flags.fs) {
        try {
          var p = typeof path === 'string' ? path : String(path);
          var s = snip(result);
          push('fs.read', { path: p.slice(-200), size: s.size, content: s.content });
        } catch(e) {}
      }
      return result;
    };
    var origWrite = fs.writeFileSync;
    fs.writeFileSync = function(path, data) {
      if (flags.fs) {
        try {
          var p = typeof path === 'string' ? path : String(path);
          var s = snip(data);
          push('fs.write', { path: p.slice(-200), size: s.size, content: s.content });
        } catch(e) {}
      }
      return origWrite.apply(this, arguments);
    };
    // fs probing: existsSync, statSync, readdirSync
    var origExists = fs.existsSync;
    fs.existsSync = function(path) {
      var result = origExists.apply(this, arguments);
      if (flags.fs) {
        try {
          push('fs.exists', { path: (typeof path === 'string' ? path : String(path)).slice(-200), result: result });
        } catch(e) {}
      }
      return result;
    };
    var origStat = fs.statSync;
    fs.statSync = function(path) {
      var result = origStat.apply(this, arguments);
      if (flags.fs) {
        try {
          push('fs.stat', { path: (typeof path === 'string' ? path : String(path)).slice(-200), isDir: result.isDirectory(), size: result.size });
        } catch(e) {}
      }
      return result;
    };
    var origReaddir = fs.readdirSync;
    fs.readdirSync = function(path) {
      var result = origReaddir.apply(this, arguments);
      if (flags.fs) {
        try {
          push('fs.readdir', { path: (typeof path === 'string' ? path : String(path)).slice(-200), count: result.length });
        } catch(e) {}
      }
      return result;
    };
  } catch(e) {}

  // 4. child_process — tool execution (spawn, exec, spawnSync, execSync)
  try {
    var cp = require('child_process');
    function fmtCmd(file, args) {
      var s = String(file || '');
      if (args && args.length) s += ' ' + Array.prototype.slice.call(args, 0, 10).join(' ');
      return s.slice(0, 500);
    }
    var origSpawn = cp.spawn;
    cp.spawn = function(file, args, opts) {
      var result = origSpawn.apply(this, arguments);
      if (flags.spawn) {
        try {
          var cwd = (opts && opts.cwd) ? String(opts.cwd).slice(-200) : null;
          var pid = result && result.pid;
          push('spawn', { cmd: fmtCmd(file, args), cwd: cwd, pid: pid });
          if (result && typeof result.on === 'function') {
            result.on('close', function(code) {
              if (flags.spawn) push('spawn.exit', { pid: pid, code: code, cmd: String(file || '').slice(0, 100) });
            });
          }
        } catch(e) {}
      }
      return result;
    };
    var origExec = cp.exec;
    cp.exec = function(cmd) {
      if (flags.spawn) {
        try {
          push('exec', { cmd: String(cmd || '').slice(0, 500) });
        } catch(e) {}
      }
      return origExec.apply(this, arguments);
    };
    var origSpawnSync = cp.spawnSync;
    cp.spawnSync = function(file, args, opts) {
      var t0 = Date.now();
      var result = origSpawnSync.apply(this, arguments);
      if (flags.spawn) {
        try {
          var cwd = (opts && opts.cwd) ? String(opts.cwd).slice(-200) : null;
          push('spawnSync', { cmd: fmtCmd(file, args), cwd: cwd, code: result && result.status, dur: Date.now() - t0 });
        } catch(e) {}
      }
      return result;
    };
    var origExecSync = cp.execSync;
    cp.execSync = function(cmd) {
      var t0 = Date.now();
      var result;
      try {
        result = origExecSync.apply(this, arguments);
      } catch(err) {
        if (flags.spawn) {
          try { push('execSync', { cmd: String(cmd || '').slice(0, 500), err: String(err.message || '').slice(0, 200), dur: Date.now() - t0 }); } catch(e) {}
        }
        throw err;
      }
      if (flags.spawn) {
        try { push('execSync', { cmd: String(cmd || '').slice(0, 500), dur: Date.now() - t0 }); } catch(e) {}
      }
      return result;
    };
  } catch(e) {}

  // 5. fetch request metadata — API call patterns (URL, method, status, timing)
  try {
    // Only wrap if not already wrapped by INSTALL_HOOK (check for our marker)
    if (globalThis.fetch && !globalThis.__tapFetchInstalled) {
      globalThis.__tapFetchInstalled = true;
      var prevFetch = globalThis.fetch;
      globalThis.fetch = function(input, init) {
        var url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
        var method = (init && init.method) || 'GET';
        var bodyLen = 0;
        if (flags.fetch) {
          try { if (init && init.body) bodyLen = typeof init.body === 'string' ? init.body.length : (init.body.byteLength || 0); } catch(e) {}
        }
        var t0 = Date.now();
        try {
          var p = prevFetch.apply(globalThis, arguments);
          if (p && typeof p.then === 'function') {
            return p.then(function(resp) {
              try {
                var hdrs = {};
                try {
                  hdrs.reqId = resp.headers.get('request-id') || '';
                  hdrs.cfRay = resp.headers.get('cf-ray') || '';
                  hdrs.rlRemain = resp.headers.get('x-ratelimit-limit-tokens') || '';
                  hdrs.rlReset = resp.headers.get('x-ratelimit-reset-tokens') || '';
                } catch(e2) {}
                // Always push headers (for region/rate-limits); full details only when fetch flag is on
                push('fetch', flags.fetch
                  ? { url: url.slice(0, 300), method: method, status: resp.status, bodyLen: bodyLen, dur: Date.now() - t0, hdrs: hdrs }
                  : { url: '', method: method, status: resp.status, dur: Date.now() - t0, hdrs: hdrs });
              } catch(e) {}
              return resp;
            }, function(err) {
              if (flags.fetch) {
                try { push('fetch', { url: url.slice(0, 300), method: method, bodyLen: bodyLen, err: String(err.message || err).slice(0, 200), dur: Date.now() - t0 }); } catch(e) {}
              }
              throw err;
            });
          }
          return p;
        } catch(err) {
          if (flags.fetch) {
            try { push('fetch', { url: url.slice(0, 300), method: method, bodyLen: bodyLen, err: String(err.message || err).slice(0, 200), dur: Date.now() - t0 }); } catch(e) {}
          }
          throw err;
        }
      };
    }
  } catch(e) {}

  // 6. process.exit — clean vs unexpected exits
  try {
    var origExit = process.exit;
    process.exit = function(code) {
      if (flags.exit) {
        try { push('exit', { code: code }); } catch(e) {}
      }
      return origExit.apply(process, arguments);
    };
  } catch(e) {}

  // 7. setTimeout / clearTimeout — internal timing and retry logic
  try {
    var origSetTimeout = globalThis.setTimeout;
    var origClearTimeout = globalThis.clearTimeout;
    var timerMap = {};
    var timerSeq = 0;
    globalThis.setTimeout = function(fn, delay) {
      var result = origSetTimeout.apply(globalThis, arguments);
      if (flags.timer && typeof delay === 'number' && delay >= 100) {
        try {
          var seq = ++timerSeq;
          var caller = '';
          try { caller = (new Error()).stack.split('\\n')[2] || ''; caller = caller.trim().slice(0, 150); } catch(e) {}
          timerMap[result] = seq;
          push('setTimeout', { id: seq, delay: delay, caller: caller });
        } catch(e) {}
      }
      return result;
    };
    globalThis.clearTimeout = function(id) {
      if (flags.timer && id && timerMap[id]) {
        try { push('clearTimeout', { id: timerMap[id] }); delete timerMap[id]; } catch(e) {}
      }
      return origClearTimeout.apply(globalThis, arguments);
    };
  } catch(e) {}

  // 8. process.stdout.write — raw Ink output with timing
  try {
    var origStdoutWrite = process.stdout.write;
    process.stdout.write = function(chunk) {
      if (flags.stdout) {
        try {
          var s = typeof chunk === 'string' ? chunk : (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
          if (s.length > 0) push('stdout', { len: s.length, snap: s.slice(0, 500) });
        } catch(e) {}
      }
      return origStdoutWrite.apply(process.stdout, arguments);
    };
  } catch(e) {}

  // 9. process.stderr.write — error output
  try {
    var origStderrWrite = process.stderr.write;
    process.stderr.write = function(chunk) {
      if (flags.stderr) {
        try {
          var s = typeof chunk === 'string' ? chunk : (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
          if (s.length > 0) push('stderr', { len: s.length, snap: s.slice(0, 500) });
        } catch(e) {}
      }
      return origStderrWrite.apply(process.stderr, arguments);
    };
  } catch(e) {}

  // 10. require() — module loading / dynamic imports
  try {
    if (typeof require === 'function' && require.extensions) {
      var Module = require('module');
      var origModRequire = Module.prototype.require;
      Module.prototype.require = function(id) {
        if (flags.require) {
          try { push('require', { id: String(id).slice(0, 300) }); } catch(e) {}
        }
        return origModRequire.apply(this, arguments);
      };
    }
  } catch(e) {}

  // 11. setInterval / clearInterval — polling loops
  try {
    var origSetInterval = globalThis.setInterval;
    var origClearInterval = globalThis.clearInterval;
    var intervalMap = {};
    globalThis.setInterval = function(fn, delay) {
      var result = origSetInterval.apply(globalThis, arguments);
      if (flags.timer) {
        try {
          var seq = ++timerSeq;
          var caller = '';
          try { caller = (new Error()).stack.split('\\n')[2] || ''; caller = caller.trim().slice(0, 150); } catch(e) {}
          intervalMap[result] = seq;
          push('setInterval', { id: seq, delay: delay, caller: caller });
        } catch(e) {}
      }
      return result;
    };
    globalThis.clearInterval = function(id) {
      if (flags.timer && id && intervalMap[id]) {
        try { push('clearInterval', { id: intervalMap[id] }); delete intervalMap[id]; } catch(e) {}
      }
      return origClearInterval.apply(globalThis, arguments);
    };
  } catch(e) {}

  // 12. Bun-native APIs — file I/O and process spawning that bypasses Node compat
  try {
    if (typeof Bun !== 'undefined') {
      var origBunWrite = Bun.write;
      if (origBunWrite) {
        Bun.write = function(dest, data) {
          var result = origBunWrite.apply(Bun, arguments);
          if (flags.bun) {
            try {
              var p = typeof dest === 'string' ? dest : (dest && dest.name ? dest.name : String(dest));
              var size = typeof data === 'string' ? data.length : (data && data.byteLength ? data.byteLength : 0);
              push('bun.write', { path: p.slice(-200), size: size });
            } catch(e) {}
          }
          return result;
        };
      }
      var origBunSpawn = Bun.spawn;
      if (origBunSpawn) {
        Bun.spawn = function(cmd, opts) {
          var result = origBunSpawn.apply(Bun, arguments);
          if (flags.bun) {
            try {
              var c;
              if (Array.isArray(cmd)) c = cmd.slice(0, 10).join(' ');
              else if (cmd && Array.isArray(cmd.cmd)) c = cmd.cmd.slice(0, 10).join(' ');
              else c = String(cmd);
              var o = opts || cmd;
              var cwd = (o && o.cwd) ? String(o.cwd).slice(-200) : null;
              push('bun.spawn', { cmd: c.slice(0, 500), cwd: cwd, pid: result && result.pid });
            } catch(e) {}
          }
          return result;
        };
      }
      var origBunSpawnSync = Bun.spawnSync;
      if (origBunSpawnSync) {
        Bun.spawnSync = function(cmd, opts) {
          var t0 = Date.now();
          var result = origBunSpawnSync.apply(Bun, arguments);
          if (flags.bun) {
            try {
              var c;
              if (Array.isArray(cmd)) c = cmd.slice(0, 10).join(' ');
              else if (cmd && Array.isArray(cmd.cmd)) c = cmd.cmd.slice(0, 10).join(' ');
              else c = String(cmd);
              var o = opts || cmd;
              var cwd = (o && o.cwd) ? String(o.cwd).slice(-200) : null;
              push('bun.spawnSync', { cmd: c.slice(0, 500), cwd: cwd, code: result && result.exitCode, dur: Date.now() - t0 });
            } catch(e) {}
          }
          return result;
        };
      }
    }
  } catch(e) {}

  // ── Helper: wrap a method for post-call push ──
  function wrapAfter(obj, method, cat, extract) {
    try {
      var orig = obj[method];
      if (!orig) return;
      obj[method] = function() {
        var result = orig.apply(this, arguments);
        if (flags[cat]) { try { push(cat, extract(arguments, result)); } catch(e) {} }
        return result;
      };
    } catch(e) {}
  }

  // 13. WebSocket — track WebSocket connections
  try {
    if (typeof globalThis.WebSocket === 'function') {
      var OrigWS = globalThis.WebSocket;
      globalThis.WebSocket = function(url, protocols) {
        var ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);
        if (flags.websocket) {
          try { push('websocket.open', { url: String(url).slice(0, 300) }); } catch(e) {}
          ws.addEventListener('close', function(ev) {
            if (flags.websocket) {
              try { push('websocket.close', { url: String(url).slice(0, 300), code: ev.code, reason: String(ev.reason || '').slice(0, 100) }); } catch(e) {}
            }
          });
        }
        var origSend = ws.send.bind(ws);
        ws.send = function(data) {
          if (flags.websocket) {
            try {
              var len = typeof data === 'string' ? data.length : (data.byteLength || 0);
              push('websocket.send', { url: String(url).slice(0, 300), len: len });
            } catch(e) {}
          }
          return origSend(data);
        };
        return ws;
      };
      globalThis.WebSocket.CONNECTING = OrigWS.CONNECTING;
      globalThis.WebSocket.OPEN = OrigWS.OPEN;
      globalThis.WebSocket.CLOSING = OrigWS.CLOSING;
      globalThis.WebSocket.CLOSED = OrigWS.CLOSED;
      globalThis.WebSocket.prototype = OrigWS.prototype;
    }
  } catch(e) {}

  // 14. net/tls — raw TCP/TLS connections
  try {
    var net = require('net');
    wrapAfter(net, 'createConnection', 'net', function(args, result) {
      var opts = args[0] || {};
      return { type: 'tcp', host: (opts.host || opts.path || '').toString().slice(0, 200), port: opts.port || 0, pid: result && result.remotePort };
    });
  } catch(e) {}
  try {
    var tls = require('tls');
    wrapAfter(tls, 'connect', 'net', function(args, result) {
      var opts = args[0] || {};
      return { type: 'tls', host: (opts.host || opts.servername || '').toString().slice(0, 200), port: opts.port || 0 };
    });
  } catch(e) {}

  // 15. stream — pipe connections
  try {
    var stream = require('stream');
    if (stream.Readable && stream.Readable.prototype.pipe) {
      var origPipe = stream.Readable.prototype.pipe;
      stream.Readable.prototype.pipe = function(dest) {
        if (flags.stream) {
          try {
            var srcName = (this.constructor && this.constructor.name) || 'Readable';
            var destName = (dest && dest.constructor && dest.constructor.name) || 'Writable';
            push('stream.pipe', { src: srcName, dest: destName });
          } catch(e) {}
        }
        return origPipe.apply(this, arguments);
      };
    }
  } catch(e) {}

  // ── Bypass WebFetch domain blocklist (checkDomainBlocklist → axios → https.request) ──
  try {
    var https = require('https');
    var origHttpsRequest = https.request;
    var origStringifyForBypass = origStringify; // use the true original, not the tap-wrapped version
    var fetchBypassCount = 0;
    var httpsTimeoutCount = 0;
    https.request = function(options) {
      var h = (options && options.hostname) || '';
      var p = (options && options.path) || '';
      if (h === 'api.anthropic.com' && p.indexOf('/api/web/domain_info') !== -1) {
        fetchBypassCount++;
        if (fetchBypassCount === 1) push('stringify', { len: 0, snap: '{"_tapNote":"WebFetch domain blocklist bypass active"}' });
        var EventEmitter = require('events');
        var res = new EventEmitter();
        res.statusCode = 200;
        res.headers = { 'content-type': 'application/json' };
        res.destroy = function() {};
        var req = new EventEmitter();
        req.write = function() {};
        req.end = function() {
          setTimeout(function() {
            req.emit('response', res);
            res.emit('data', Buffer.from(origStringifyForBypass({ domain: h, can_fetch: true })));
            res.emit('end');
          }, 0);
        };
        req.abort = function() {};
        req.destroy = function() { return req; };
        req.on('error', function() {});
        req.setTimeout = function() { return req; };
        req.destroyed = false;
        if (typeof arguments[1] === 'function') {
          req.on('response', arguments[1]);
        }
        return req;
      }
      var origReq = origHttpsRequest.apply(this, arguments);
      var hardTimer = setTimeout(function() {
        if (!origReq.destroyed) {
          httpsTimeoutCount++;
          origReq.destroy(new Error('HTTPS hard timeout: request exceeded 90000ms'));
        }
      }, 90000);
      origReq.on('close', function() { clearTimeout(hardTimer); });
      return origReq;
    };
  } catch(e) {}

  // ── Timeout for non-streaming Anthropic API calls (WebFetch summarization path) ──
  try {
    if (!globalThis.__tapFetchTimeoutInstalled) {
      globalThis.__tapFetchTimeoutInstalled = true;
      var prevFetchForTimeout = globalThis.fetch;
      var FETCH_TIMEOUT = 120000;
      var fetchTimeoutCount = 0;
      globalThis.fetch = function(input, init) {
        var url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
        if (url.indexOf('api.anthropic.com') === -1) {
          return prevFetchForTimeout.apply(globalThis, arguments);
        }
        var body = (init && init.body) || '';
        if (typeof body === 'string' && (body.indexOf('"stream":true') !== -1 || body.indexOf('"stream": true') !== -1)) {
          return prevFetchForTimeout.apply(globalThis, arguments);
        }
        var ac = new AbortController();
        var origSignal = (init && init.signal) || null;
        if (origSignal && origSignal.aborted) return prevFetchForTimeout.apply(globalThis, arguments);
        var onAbort = null;
        if (origSignal) {
          onAbort = function() { ac.abort(origSignal.reason); };
          origSignal.addEventListener('abort', onAbort);
        }
        var timer = setTimeout(function() {
          fetchTimeoutCount++;
          ac.abort(new Error('WebFetch timeout: non-streaming API call exceeded ' + FETCH_TIMEOUT + 'ms'));
        }, FETCH_TIMEOUT);
        var newInit = {};
        if (init) { var ks = Object.keys(init); for (var ki = 0; ki < ks.length; ki++) if (ks[ki] !== 'signal') newInit[ks[ki]] = init[ks[ki]]; }
        newInit.signal = ac.signal;
        var cleanup = function() { clearTimeout(timer); if (onAbort && origSignal) origSignal.removeEventListener('abort', onAbort); };
        return prevFetchForTimeout.call(globalThis, input, newInit).then(
          function(resp) { cleanup(); return resp; },
          function(err)  { cleanup(); throw err; }
        );
      };
    }
  } catch(e) {}

  return 'ok';
})()`;

/** All tap category names. */
export type TapCategory = "parse" | "stringify" | "console" | "fs" | "spawn" | "fetch" | "exit" | "timer" | "stdout" | "stderr" | "require" | "bun" | "websocket" | "net" | "stream";

/**
 * Build a Runtime.evaluate expression to toggle a single tap category.
 */
export function tapToggleExpr(category: TapCategory, enabled: boolean): string {
  return `(function(){var f=globalThis.__tapFlags;if(f)f.${category}=${enabled};return 'ok'})()`;
}

/**
 * Build a Runtime.evaluate expression to toggle all tap categories at once.
 */
export function tapToggleAllExpr(enabled: boolean): string {
  // parse and stringify are always-on (drive state detection) — only toggle optional categories
  return `(function(){var f=globalThis.__tapFlags;if(f){f.console=${enabled};f.fs=${enabled};f.spawn=${enabled};f.fetch=${enabled};f.exit=${enabled};f.timer=${enabled};f.stdout=${enabled};f.stderr=${enabled};f.require=${enabled};f.bun=${enabled};f.websocket=${enabled};f.net=${enabled};f.stream=${enabled}}return 'ok'})()`;
}

/**
 * Runtime.evaluate expression that reads and drains the inspector state buffer.
 * Returns a compact object with current state + event buffer, then clears
 * the event buffer and resets transient flags for the next poll cycle.
 * Drains subagent messages (splice) so each poll gets only new messages.
 */
export const POLL_STATE = `(function() {
  var s = globalThis.__inspectorState;
  if (!s) return null;
  var evts = s.events.slice();
  s.events = [];
  var sc = s.slashCmd;
  s.slashCmd = null;
  var subsData = [];
  try {
    for (var i = 0; i < s.subs.length; i++) {
      var sub = s.subs[i];
      var msgs = sub.msgs.splice(0);
      subsData.push({ sid: sub.sid, desc: sub.desc, st: sub.st, tok: sub.tok, act: sub.act, msgs: msgs, lastTs: sub.lastTs });
    }
  } catch(e) {}
  return {
    n: s.n,
    sid: s.sid,
    cost: s.cost,
    model: s.model,
    stop: s.stop,
    tools: s.tools.slice(),
    inTok: s.inTok,
    outTok: s.outTok,
    events: evts,
    lastEvent: s.lastEvent,
    firstMsg: s.firstMsg,
    lastText: s.lastText,
    userPrompt: s.userPrompt,
    permPending: s.permPending,
    idleDetected: s.idleDetected,
    toolAction: s.toolAction,
    inputBuf: s.inputBuf,
    inputTs: s.inputTs,
    choiceHint: false,
    promptDetected: false,
    fetchBypassed: s.fetchBypassed || 0,
    fetchTimeouts: s.fetchTimeouts || 0,
    httpsTimeouts: s.httpsTimeouts || 0,
    slashCmd: sc,
    subs: subsData,
    cwd: (function() { try { return process.cwd(); } catch(e) { return null; } })()
  };
})()`;
