// [SI-01] Sole source: BUN_INSPECT WebSocket inspector via TCP-pushed tap events
// [SI-14] Push-based architecture: INSTALL_TAPS injects the only live inspector path
/**
 * JavaScript expressions evaluated via Runtime.evaluate on the BUN_INSPECT
 * WebSocket connection. INSTALL_TAPS captures Claude Code internals through
 * JSON.parse / JSON.stringify interception plus optional deep hooks, then
 * pushes structured entries to the Rust tap server over TCP.
 */

// [SI-21] INSTALL_TAPS: 22 flag-gated tap categories; multi-op families use shared cat+op payloads via TCP push
// [IN-02] Status-line detection, WebFetch bypass, HTTPS/fetch timeout patches, wrapAfter helper
/**
 * Runtime.evaluate expression that installs tap hooks for deep inspection
 * of Claude Code internals. Push-based delivery via Bun.connect TCP on
 * TAP_PORT — no polling needed.
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

  var flags = { parse: true, stringify: true, console: false, fs: false, spawn: false, fetch: false, exit: false, timer: false, stdout: false, stderr: false, require: false, bun: false, websocket: false, net: false, stream: false, fspromises: false, bunfile: false, abort: false, fswatch: false, textdecoder: false, events: false, envproxy: false };
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
        if (tapQueue.length > 1000) tapQueue = tapQueue.slice(-1000);
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
          push('parse', { len: text.length, snap: text });
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
          // [IN-19] Detect API request body — extract full system prompt (bypasses 2000-char snap truncation)
          if (value && value.model && Array.isArray(value.messages) && !value.costUSD && value.system) {
            var sysText = '';
            var sysBlocks = [];
            if (Array.isArray(value.system)) {
              for (var si = 0; si < value.system.length; si++) {
                var blk = value.system[si];
                var bt = blk.text || '';
                var bo = { text: bt };
                if (blk.cache_control) bo.cc = blk.cache_control;
                sysBlocks.push(bo);
                if (sysText.length > 0 && sysText[sysText.length - 1] !== '\\n') sysText += '\\n';
                sysText += bt;
              }
            } else if (typeof value.system === 'string') {
              sysText = value.system;
              sysBlocks.push({ text: sysText });
            }
            // Capture full conversation messages (images replaced with placeholder)
            var msgs = [];
            for (var mi = 0; mi < value.messages.length; mi++) {
              var msg = value.messages[mi];
              var mc = msg.content;
              var cBlocks = [];
              if (typeof mc === 'string') {
                cBlocks.push({ type: 'text', text: mc });
              } else if (Array.isArray(mc)) {
                for (var ci = 0; ci < mc.length; ci++) {
                  var cb = mc[ci];
                  if (cb.type === 'text') {
                    cBlocks.push({ type: 'text', text: cb.text });
                  } else if (cb.type === 'tool_use') {
                    cBlocks.push({ type: 'tool_use', id: cb.id, name: cb.name, input: cb.input });
                  } else if (cb.type === 'tool_result') {
                    var trText = '';
                    if (typeof cb.content === 'string') { trText = cb.content; }
                    else if (Array.isArray(cb.content)) {
                      for (var ti = 0; ti < cb.content.length; ti++) {
                        if (cb.content[ti].type === 'text') trText += cb.content[ti].text || '';
                      }
                    }
                    cBlocks.push({ type: 'tool_result', toolUseId: cb.tool_use_id, text: trText, isError: !!cb.is_error });
                  } else if (cb.type === 'image') {
                    cBlocks.push({ type: 'image', mediaType: (cb.source && cb.source.media_type) || 'unknown' });
                  } else {
                    cBlocks.push({ type: cb.type || 'unknown' });
                  }
                }
              }
              msgs.push({ role: msg.role, content: cBlocks });
            }
            if (sysText.length > 0) {
              push('system-prompt', { text: sysText, model: value.model, msgCount: value.messages.length, blocks: sysBlocks, messages: msgs });
            }
          }
          // Detect status line payload — push full data bypassing 2000-char snap truncation.
          // Match StatusLineCommandInput shape: has cost.total_cost_usd + context_window + session_id.
          if (value && value.session_id && value.cost && typeof value.cost.total_cost_usd === 'number'
              && value.context_window && typeof value.context_window.total_input_tokens === 'number') {
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
          // Detect permission_prompt — checks the VALUE, not the snap.
          // Large objects can truncate notification_type out of the preview.
          // Scoped to permission_prompt only — idle_prompt objects are small and always survive
          // the regular 2000-char snap path. For permission_prompt: if the object is large (>2000 chars),
          // this synthetic push is the only path that works; if small, both this and the regular push
          // below will classify as PermissionPromptShown — harmless (reducer is idempotent at waitingPermission).
          if (value && typeof value === 'object' && value.notification_type === 'permission_prompt') {
            push('stringify', { len: result.length, snap: origStringify({ notification_type: value.notification_type }) });
          }
          push('stringify', { len: result.length, snap: result });
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
            if (msg.length > 0) push('console', { op: method, msg: msg });
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
    if (b) {
      var isBin = false;
      var head = b.slice(0, 100);
      for (var i = 0; i < head.length; i++) { if (head[i] === 0) { isBin = true; break; } }
      if (!isBin) content = b.toString('utf8');
    } else if (typeof raw === 'string') {
      content = raw;
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
          push('fs', { op: 'read', path: p, size: s.size, content: s.content });
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
          push('fs', { op: 'write', path: p, size: s.size, content: s.content });
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
          push('fs', { op: 'exists', path: (typeof path === 'string' ? path : String(path)), result: result });
        } catch(e) {}
      }
      return result;
    };
    var origStat = fs.statSync;
    fs.statSync = function(path) {
      var result = origStat.apply(this, arguments);
      if (flags.fs) {
        try {
          push('fs', { op: 'stat', path: (typeof path === 'string' ? path : String(path)), isDir: result.isDirectory(), size: result.size });
        } catch(e) {}
      }
      return result;
    };
    var origReaddir = fs.readdirSync;
    fs.readdirSync = function(path) {
      var result = origReaddir.apply(this, arguments);
      if (flags.fs) {
        try {
          push('fs', { op: 'readdir', path: (typeof path === 'string' ? path : String(path)), count: result.length });
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
      if (args && args.length) s += ' ' + Array.prototype.slice.call(args).join(' ');
      return s;
    }
    var origSpawn = cp.spawn;
    cp.spawn = function(file, args, opts) {
      var result = origSpawn.apply(this, arguments);
      if (flags.spawn) {
        try {
          var cwd = (opts && opts.cwd) ? String(opts.cwd) : null;
          var pid = result && result.pid;
          push('spawn', { cmd: fmtCmd(file, args), cwd: cwd, pid: pid });
          if (result && typeof result.on === 'function') {
            result.on('close', function(code) {
              if (flags.spawn) push('spawn.exit', { pid: pid, code: code, cmd: String(file || '') });
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
          push('spawn', { op: 'exec', cmd: String(cmd || '') });
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
          var cwd = (opts && opts.cwd) ? String(opts.cwd) : null;
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
          try { push('execSync', { cmd: String(cmd || ''), err: String(err.message || ''), dur: Date.now() - t0 }); } catch(e) {}
        }
        throw err;
      }
      if (flags.spawn) {
        try { push('execSync', { cmd: String(cmd || ''), dur: Date.now() - t0 }); } catch(e) {}
      }
      return result;
    };
  } catch(e) {}

  // 5. fetch request metadata — API call patterns (URL, method, status, timing)
  // Ping latency is now measured by the Rust backend (ping_api command), not from JS.
  try {
    // Wrap once across reconnects / reinjection attempts.
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
                var ct = '';
                var cl = 0;
                try {
                  resp.headers.forEach(function(v, k) { hdrs[k] = v; });
                  ct = hdrs['content-type'] || '';
                  cl = parseInt(hdrs['content-length'] || '0') || 0;
                } catch(e2) {}
                var isStream = ct.indexOf('text/event-stream') !== -1;
                var fetchEntry = flags.fetch
                  ? { url: url, method: method, status: resp.status, bodyLen: bodyLen, dur: Date.now() - t0, hdrs: hdrs, ct: ct, cl: cl }
                  : { url: '', method: method, status: resp.status, dur: Date.now() - t0, hdrs: hdrs, ct: ct, cl: cl };
                if (flags.fetch && isStream) {
                  // SSE: read first chunk via ReadableStream reader for usage data
                  try {
                    var clonedBody = resp.clone().body;
                    if (clonedBody && clonedBody.getReader) {
                      var rdr = clonedBody.getReader();
                      rdr.read().then(function(r) {
                        rdr.cancel();
                        if (r.value) {
                          try { fetchEntry.resp = new TextDecoder().decode(r.value); } catch(e5) {}
                        }
                        push('fetch', fetchEntry);
                      }, function() { push('fetch', fetchEntry); });
                    } else {
                      push('fetch', fetchEntry);
                    }
                  } catch(e4) { push('fetch', fetchEntry); }
                } else if (flags.fetch) {
                  // Non-streaming: clone and read full body
                  try {
                    resp.clone().text().then(function(txt) {
                      fetchEntry.resp = txt;
                      push('fetch', fetchEntry);
                    }, function() { push('fetch', fetchEntry); });
                  } catch(e4) { push('fetch', fetchEntry); }
                } else {
                  push('fetch', fetchEntry);
                }
              } catch(e) {}
              return resp;
            }, function(err) {
              if (flags.fetch) {
                try { push('fetch', { url: url, method: method, bodyLen: bodyLen, err: String(err.message || err), dur: Date.now() - t0 }); } catch(e) {}
              }
              throw err;
            });
          }
          return p;
        } catch(err) {
          if (flags.fetch) {
            try { push('fetch', { url: url, method: method, bodyLen: bodyLen, err: String(err.message || err), dur: Date.now() - t0 }); } catch(e) {}
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
      if (flags.timer) {
        try {
          var seq = ++timerSeq;
          var caller = '';
          try { caller = (new Error()).stack.split('\\n')[2] || ''; caller = caller.trim(); } catch(e) {}
          timerMap[result] = seq;
          push('timer', { op: 'setTimeout', id: seq, delay: delay, caller: caller });
        } catch(e) {}
      }
      return result;
    };
    globalThis.clearTimeout = function(id) {
      if (flags.timer && id && timerMap[id]) {
        try { push('timer', { op: 'clearTimeout', id: timerMap[id] }); delete timerMap[id]; } catch(e) {}
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
          if (s.length > 0) push('stdout', { len: s.length, snap: s });
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
          if (s.length > 0) push('stderr', { len: s.length, snap: s });
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
          try { push('require', { id: String(id) }); } catch(e) {}
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
          try { caller = (new Error()).stack.split('\\n')[2] || ''; caller = caller.trim(); } catch(e) {}
          intervalMap[result] = seq;
          push('timer', { op: 'setInterval', id: seq, delay: delay, caller: caller });
        } catch(e) {}
      }
      return result;
    };
    globalThis.clearInterval = function(id) {
      if (flags.timer && id && intervalMap[id]) {
        try { push('timer', { op: 'clearInterval', id: intervalMap[id] }); delete intervalMap[id]; } catch(e) {}
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
              push('bun', { op: 'write', path: p, size: size });
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
              if (Array.isArray(cmd)) c = cmd.join(' ');
              else if (cmd && Array.isArray(cmd.cmd)) c = cmd.cmd.join(' ');
              else c = String(cmd);
              var o = opts || cmd;
              var cwd = (o && o.cwd) ? String(o.cwd) : null;
              push('bun', { op: 'spawn', cmd: c, cwd: cwd, pid: result && result.pid });
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
              if (Array.isArray(cmd)) c = cmd.join(' ');
              else if (cmd && Array.isArray(cmd.cmd)) c = cmd.cmd.join(' ');
              else c = String(cmd);
              var o = opts || cmd;
              var cwd = (o && o.cwd) ? String(o.cwd) : null;
              push('bun', { op: 'spawnSync', cmd: c, cwd: cwd, code: result && result.exitCode, dur: Date.now() - t0 });
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
          try { push('websocket', { op: 'open', url: String(url) }); } catch(e) {}
          ws.addEventListener('close', function(ev) {
            if (flags.websocket) {
              try { push('websocket', { op: 'close', url: String(url), code: ev.code, reason: String(ev.reason || '') }); } catch(e) {}
            }
          });
          ws.addEventListener('message', function(ev) {
            if (flags.websocket) {
              try {
                var d = typeof ev.data === 'string' ? ev.data : '';
                var mLen = typeof ev.data === 'string' ? ev.data.length : (ev.data && ev.data.byteLength || 0);
                push('websocket', { op: 'message', url: String(url), len: mLen, snap: d });
              } catch(e) {}
            }
          });
        }
        var origSend = ws.send.bind(ws);
        ws.send = function(data) {
          if (flags.websocket) {
            try {
              var len = typeof data === 'string' ? data.length : (data.byteLength || 0);
              push('websocket', { op: 'send', url: String(url), len: len });
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
      return { type: 'tcp', host: (opts.host || opts.path || '').toString(), port: opts.port || 0, pid: result && result.remotePort };
    });
  } catch(e) {}
  try {
    var tls = require('tls');
    wrapAfter(tls, 'connect', 'net', function(args, result) {
      var opts = args[0] || {};
      return { type: 'tls', host: (opts.host || opts.servername || '').toString(), port: opts.port || 0 };
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
            push('stream', { op: 'pipe', src: srcName, dest: destName });
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
    // [SI-16] WebFetch domain blocklist bypass: api.anthropic.com/api/web/domain_info returns can_fetch:true, eliminating the 10s preflight on every WebFetch.
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
      var httpsT0 = Date.now();
      var origReq = origHttpsRequest.apply(this, arguments);
      if (flags.fetch) {
        try {
          origReq.on('response', function(res) {
            var respCt = (res.headers && res.headers['content-type']) || '';
            var respCl = parseInt((res.headers && res.headers['content-length']) || '0') || 0;
            var respEntry = { op: 'https-resp', url: (h + p), status: res.statusCode, ct: respCt, cl: respCl, dur: Date.now() - httpsT0, hdrs: res.headers || {} };
            var chunks = [];
            var total = 0;
            res.on('data', function(chunk) {
              total += chunk.length;
              if (total <= 32768) chunks.push(chunk);
            });
            res.on('end', function() {
              try {
                respEntry.resp = Buffer.concat(chunks).toString('utf8');
                respEntry.cl = total;
              } catch(eResp) {}
              push('fetch', respEntry);
            });
          });
        } catch(ePassive) {}
      }
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

  // [SI-18] WebFetch timeout protection: globalThis.fetch wraps non-streaming Anthropic API calls (callSmallModel summarization) at 120s; https.request applies a 90s wall-clock timeout to external HTTPS requests (block above).
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

  // ── fs.promises async file I/O ──
  try {
    var fsp = require('fs').promises;
    if (fsp && !fsp.__tapped) {
      fsp.__tapped = true;
      ['readFile', 'writeFile', 'mkdir', 'rm', 'access', 'appendFile'].forEach(function(method) {
        if (typeof fsp[method] !== 'function') return;
        var orig = fsp[method];
        fsp[method] = function(pathArg) {
          var args = arguments;
          var t0 = Date.now();
          return orig.apply(fsp, args).then(function(result) {
            if (flags.fspromises) {
              var p = typeof pathArg === 'string' ? pathArg : String(pathArg);
              var size = result ? (result.length || result.byteLength || 0) : 0;
              push('fspromises', { op: method, path: p, size: size, dur: Date.now() - t0 });
            }
            return result;
          }, function(err) {
            if (flags.fspromises) {
              push('fspromises', { op: method, path: String(pathArg), err: String(err), dur: Date.now() - t0 });
            }
            throw err;
          });
        };
      });
    }
  } catch(e) {}

  // ── Bun.file() instance methods ──
  try {
    if (typeof Bun !== 'undefined' && typeof Bun.file === 'function' && !Bun.__fileTapped) {
      Bun.__fileTapped = true;
      var origBunFile = Bun.file;
      Bun.file = function(path) {
        var file = origBunFile.apply(Bun, arguments);
        if (!flags.bunfile) return file;
        var fp = typeof path === 'string' ? path : String(path);
        ['text', 'json', 'exists'].forEach(function(m) {
          if (typeof file[m] !== 'function') return;
          var orig = file[m].bind(file);
          file[m] = function() {
            var t0 = Date.now();
            return orig().then(function(result) {
              if (flags.bunfile) {
                push('bunfile', { op: m, path: fp, dur: Date.now() - t0 });
              }
              return result;
            });
          };
        });
        return file;
      };
    }
  } catch(e) {}

  // ── AbortController.prototype.abort ──
  try {
    var origAbort = AbortController.prototype.abort;
    AbortController.prototype.abort = function(reason) {
      if (flags.abort) {
        push('abort', { reason: String(reason || '') });
      }
      return origAbort.apply(this, arguments);
    };
  } catch(e) {}

  // ── fs.watch / fs.watchFile ──
  try {
    var fsMod = require('fs');
    if (fsMod.watch && !fsMod.__watchTapped) {
      fsMod.__watchTapped = true;
      var origWatch = fsMod.watch;
      fsMod.watch = function(path) {
        if (flags.fswatch) {
          push('fswatch', { op: 'watch', path: String(path) });
        }
        return origWatch.apply(fsMod, arguments);
      };
    }
    if (fsMod.watchFile && !fsMod.__watchFileTapped) {
      fsMod.__watchFileTapped = true;
      var origWatchFile = fsMod.watchFile;
      fsMod.watchFile = function(path) {
        if (flags.fswatch) {
          push('fswatch', { op: 'watchFile', path: String(path) });
        }
        return origWatchFile.apply(fsMod, arguments);
      };
    }
  } catch(e) {}

  // ── TextDecoder.prototype.decode (SSE streaming) ──
  try {
    var origDecode = TextDecoder.prototype.decode;
    TextDecoder.prototype.decode = function(input, options) {
      var result = origDecode.apply(this, arguments);
      if (flags.textdecoder && result && result.length > 0) {
        push('textdecoder', { len: result.length, snap: result });
      }
      return result;
    };
  } catch(e) {}

  // ── EventEmitter.prototype.emit (filtered for hook events) ──
  try {
    var EventEmitter = require('events').EventEmitter;
    if (EventEmitter && !EventEmitter.prototype.__emitTapped) {
      EventEmitter.prototype.__emitTapped = true;
      var origEmit = EventEmitter.prototype.emit;
      EventEmitter.prototype.emit = function(type) {
        if (flags.events && typeof type === 'string') {
          var args = [];
          for (var i = 1; i < arguments.length && i < 3; i++) {
            try { args.push(origStringify(arguments[i])); } catch(e2) { args.push('[circular]'); }
          }
          push('events', { type: type, args: args, src: this.constructor ? this.constructor.name : '' });
        }
        return origEmit.apply(this, arguments);
      };
    }
  } catch(e) {}

  // ── process.env Proxy (CLAUDE_*/ANTHROPIC_* only) ──
  try {
    if (flags.envproxy === false && !process.env.__envProxyReady) {
      process.env.__envProxyReady = true;
      // Deferred: only activate when flag is toggled on
      // The proxy is installed but checks flags.envproxy each access
      var origEnv = process.env;
      var envHandler = {
        get: function(target, prop) {
          if (flags.envproxy && typeof prop === 'string') {
            push('envproxy', { key: prop, val: String(target[prop] === undefined ? '' : target[prop]) });
          }
          return target[prop];
        },
        set: function(target, prop, value) {
          target[prop] = value;
          return true;
        }
      };
      try { process.env = new Proxy(origEnv, envHandler); } catch(e2) { /* Proxy not supported or env frozen */ }
    }
  } catch(e) {}

  return 'ok';
})()`;

/** All tap category names. */
export type TapCategory =
  | "parse" | "stringify" | "console" | "fs" | "spawn" | "fetch" | "exit" | "timer"
  | "stdout" | "stderr" | "require" | "bun" | "websocket" | "net" | "stream"
  | "fspromises" | "bunfile" | "abort" | "fswatch" | "textdecoder" | "events" | "envproxy"
  | "system-prompt"
  | "codex-session" | "codex-turn-context" | "codex-token-count" | "codex-tool-call-start"
  | "codex-tool-input" | "codex-tool-call-complete" | "codex-message"
  | "codex-thread-name-updated" | "codex-compacted";

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
  return `(function(){var f=globalThis.__tapFlags;if(f){f.console=${enabled};f.fs=${enabled};f.spawn=${enabled};f.fetch=${enabled};f.exit=${enabled};f.timer=${enabled};f.stdout=${enabled};f.stderr=${enabled};f.require=${enabled};f.bun=${enabled};f.websocket=${enabled};f.net=${enabled};f.stream=${enabled};f.fspromises=${enabled};f.bunfile=${enabled};f.abort=${enabled};f.fswatch=${enabled};f.textdecoder=${enabled};f.events=${enabled};f.envproxy=${enabled}}return 'ok'})()`;
}
