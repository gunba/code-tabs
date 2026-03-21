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
            if (typeof hp === 'string' && hp) state.userPrompt = hp.slice(0, 200);
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
      } else if (ch === '\\x03' || ch === '\\x15') {
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

  return 'ok';
})()`;

/**
 * Runtime.evaluate expression that reads and drains the inspector state buffer.
 * Returns a compact object with current state + event buffer, then clears
 * the event buffer and resets transient flags for the next poll cycle.
 * Drains subagent messages (splice) so each poll gets only new messages.
 */
export const POLL_STATE = `(function() {
  var s = globalThis.__inspectorState;
  if (!s) return null;
  var result = {
    n: s.n,
    sid: s.sid,
    cost: s.cost,
    model: s.model,
    stop: s.stop,
    tools: s.tools.slice(),
    inTok: s.inTok,
    outTok: s.outTok,
    events: s.events.slice(),
    lastEvent: s.lastEvent,
    firstMsg: s.firstMsg,
    lastText: s.lastText,
    userPrompt: s.userPrompt,
    permPending: s.permPending,
    idleDetected: s.idleDetected,
    toolAction: s.toolAction,
    inputBuf: s.inputBuf,
    inputTs: s.inputTs,
    choiceHint: s.stop === 'end_turn' && !!s.lastText && !s.turnHasTools && /\\n\\s*[1-9]\\.\\s/.test(s.lastText.slice(-200)),
    subs: s.subs.map(function(sub) {
      var msgs = sub.msgs.splice(0);
      return { sid: sub.sid, desc: sub.desc, st: sub.st, tok: sub.tok, act: sub.act, msgs: msgs, lastTs: sub.lastTs };
    })
  };
  s.permPending = false;
  s.events = [];
  return result;
})()`;
