'use strict';

/**
 * ai-assistant.test.js — 附录 A: the AI plugin's tool layer and agent loop.
 *
 * Covers: adversarial inputs against the command safety classifier (A-6),
 * the read-only expression classifier, tool execution against a fake applet
 * (atomic created-labels, quiet errors, undo points, styling, view control,
 * CAS evaluation), and the agent loop's cancellation + budget behavior.
 *
 * The AI assistant lives in examples/ (deliberately untracked); every test
 * skips cleanly when the source is absent.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const SRC = path.join(__dirname, '..', '..', 'examples', 'geogebra-ai-assistant', 'src', 'index.js');
const present = fs.existsSync(SRC);
const srcUrl = pathToFileURL(SRC).href;
const skip = !present && 'ai-assistant source not present';

const ai = () => import(srcUrl);

/* ----------------------------- classifier (A-6) ----------------------------- */

test('classifyCommand: legitimate GeoGebra commands pass', { skip }, async () => {
  const { classifyCommand, DEFAULT_SETTINGS } = await ai();
  for (const cmd of [
    'a = 1',
    'A = (1, 2)',
    'f(x) = a x^2 + b x + c',
    'Circle((0, 0), 2)',
    'Tangent(1, f)',
    'g(x) = If(x > 0, x, -x)',
    'P = Intersect(f, g)',
    's = Slider(-5, 5, 0.1)',
    'l = Sequence(Point(k, k^2), k, 1, 5)',
  ]) {
    assert.strictEqual(classifyCommand(cmd, DEFAULT_SETTINGS).ok, true, `should allow: ${cmd}`);
  }
});

test('classifyCommand: adversarial inputs are rejected (script/prose/markdown/multi-command)', { skip }, async () => {
  const { classifyCommand, DEFAULT_SETTINGS } = await ai();
  const cases = [
    ['ggbApplet.deleteObject("A")', /Script/i],
    ['x = fetch("https://x.example")', /Script/i],
    ['javascript:alert(1)', /Script/i],
    ['a = 1; b = 2', /one GeoGebra command/i],
    ['draw a circle around the origin', /prose/i],
    ['画一个圆', /prose/i],
    ['Here is the code: ```f(x)=x^2``` enjoy', /Markdown|prose/i],
    ['[[ggb:Point(1,2)]]', /Markdown/i],
    ['f(x = x^2', /Unbalanced brackets/i],
    ['t = "unterminated', /Unclosed quote/i],
    ['', /Empty/i],
    [`a = ${'1+'.repeat(2000)}1`, /too long/i],
    ['Delete(A)', /Risky/i],                       // risky gated by settings
    ['SetValue(a, 99)', /Risky/i],
    ['Execute({"Delete(A)"})', /Risky/i],
  ];
  for (const [cmd, re] of cases) {
    const r = classifyCommand(cmd, DEFAULT_SETTINGS);
    assert.strictEqual(r.ok, false, `should reject: ${cmd.slice(0, 40)}`);
    assert.match(r.reason, re, `reason for: ${cmd.slice(0, 40)}`);
  }
  // semicolons INSIDE strings are fine (only top-level separators are blocked)
  const ok = classifyCommand('t = Text("a;b", (1,1))', DEFAULT_SETTINGS);
  assert.strictEqual(ok.ok, true, 'semicolon inside a quoted string is allowed');
  // risky commands pass when the user opted in
  const risky = classifyCommand('Delete(A)', { ...DEFAULT_SETTINGS, allowRiskyCommands: true });
  assert.strictEqual(risky.ok, true);
});

test('classifyExpression: read-only CAS guard (no assignments, no scripts)', { skip }, async () => {
  const { classifyExpression } = await ai();
  assert.strictEqual(classifyExpression('Integral(x^2, 0, 1)').ok, true);
  assert.strictEqual(classifyExpression('sin(pi/4) + 1').ok, true);
  assert.strictEqual(classifyExpression('Solve(x^2 = 2, x)').ok, true, 'equation inside Solve is not an assignment');
  assert.strictEqual(classifyExpression('a := 5').ok, false, ':= assignment rejected');
  assert.strictEqual(classifyExpression('a = 5').ok, false, 'plain assignment rejected');
  assert.strictEqual(classifyExpression('ggbApplet.reset()').ok, false);
  assert.strictEqual(classifyExpression('x >= 2').ok, true, 'comparisons are fine');
});

test('parseColor: hex/rgb/named forms; garbage rejected', { skip }, async () => {
  const { parseColor } = await ai();
  assert.deepStrictEqual(parseColor('#ff0000'), [255, 0, 0]);
  assert.deepStrictEqual(parseColor('#0f0'), [0, 255, 0]);
  assert.deepStrictEqual(parseColor('rgb(1, 2, 3)'), [1, 2, 3]);
  assert.ok(Array.isArray(parseColor('red')));
  assert.strictEqual(parseColor('not-a-color'), null);
  assert.strictEqual(parseColor('url(javascript:x)'), null);
});

/* ----------------------------- fake applet ----------------------------- */

function makeFakeGgb() {
  const objects = new Map(); // name → { type, value, definition }
  const calls = [];
  const ggb = {
    _objects: objects,
    _calls: calls,
    errorDialogs: true,
    undoPoints: 0,
    setErrorDialogsActive(v) { this.errorDialogs = v; calls.push(['setErrorDialogsActive', v]); },
    setUndoPoint() { this.undoPoints += 1; },
    evalCommandGetLabels(cmd) {
      calls.push(['evalCommandGetLabels', cmd]);
      const m = String(cmd).match(/^([A-Za-z_]\w*)\s*(?:\([^=]*\))?\s*=\s*(.+)$/);
      if (!m) {
        // bare command like Circle((0,0),2) → auto label
        if (/^[A-Z]\w*\s*\(/.test(String(cmd))) {
          const name = `c${objects.size + 1}`;
          objects.set(name, { type: 'conic', definition: cmd });
          return name;
        }
        return null; // rejected
      }
      const [, name, def] = m;
      if (def.includes('INVALID')) return null;
      objects.set(name, { type: /^\(/.test(def.trim()) ? 'point' : 'numeric', definition: def, value: Number(def) || 0 });
      return name;
    },
    evalCommand(cmd) {
      calls.push(['evalCommand', cmd]);
      const m = String(cmd).match(/^([A-Za-z_]\w*)\s*=\s*(.+)$/);
      if (!m) return false;
      const [, name, def] = m;
      if (def.includes('INVALID')) return false;
      const rec = objects.get(name) || { type: 'numeric' };
      rec.value = Number(def) || 0; rec.definition = def;
      objects.set(name, rec);
      return true;
    },
    evalCommandCAS(expr) {
      calls.push(['evalCommandCAS', expr]);
      if (expr.includes('bad')) return '?';
      return `cas(${expr})`;
    },
    exists(name) { return objects.has(name); },
    deleteObject(name) { objects.delete(name); },
    getObjectNumber() { return objects.size; },
    getObjectName(i) { return [...objects.keys()][i]; },
    getObjectType(name) { return objects.has(name) ? objects.get(name).type : null; },
    getDefinitionString(name) { return (objects.get(name) || {}).definition || ''; },
    getCommandString() { return ''; },
    getValueString(name) { return String((objects.get(name) || {}).value ?? ''); },
    getValue(name) { return (objects.get(name) || {}).value; },
    getXcoord() { return NaN; },
    getYcoord() { return NaN; },
    setColor(name, r, g, b) { calls.push(['setColor', name, r, g, b]); },
    setFilling(name, v) { calls.push(['setFilling', name, v]); },
    setLineThickness(name, v) { calls.push(['setLineThickness', name, v]); },
    setPointSize(name, v) { calls.push(['setPointSize', name, v]); },
    setVisible(name, v) { calls.push(['setVisible', name, v]); },
    setLabelVisible(name, v) { calls.push(['setLabelVisible', name, v]); },
    setCaption(name, v) { calls.push(['setCaption', name, v]); },
    setLabelStyle(name, v) { calls.push(['setLabelStyle', name, v]); },
    setCoordSystem(...a) { calls.push(['setCoordSystem', ...a]); },
    setAxesVisible(...a) { calls.push(['setAxesVisible', ...a]); },
    setGridVisible(v) { calls.push(['setGridVisible', v]); },
  };
  const core = { raw: ggb, objects: { list: async () => [...objects.keys()], eval: async (c) => Boolean(ggb.evalCommand(c)), remove: async (n) => ggb.deleteObject(n) } };
  return { ggb, core };
}

/* ----------------------------- tool execution ----------------------------- */

test('create_object: atomic labels, quiet errors, undo point, objects echoed back', { skip }, async () => {
  const { executeTool, DEFAULT_SETTINGS } = await ai();
  const { ggb, core } = makeFakeGgb();
  const r = await executeTool('create_object', { command: 'a = 3' }, null, DEFAULT_SETTINGS, core, null);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.created, ['a']);
  assert.ok(r.objects && r.objects[0] && r.objects[0].name === 'a', 'created object state echoed (no follow-up get_object needed)');
  assert.strictEqual(ggb.undoPoints, 1, 'one undo point per successful mutation');
  // error dialogs were suppressed during eval and restored after
  const toggles = ggb._calls.filter((c) => c[0] === 'setErrorDialogsActive').map((c) => c[1]);
  assert.deepStrictEqual(toggles, [false, true], 'host error popups suppressed then restored');
  assert.strictEqual(ggb.errorDialogs, true);

  // a rejected command (passes the classifier, applet refuses): actionable
  // error, NO undo point
  const bad = await executeTool('create_object', { command: 'b = 1/0 + REJECTME' }, null, { ...DEFAULT_SETTINGS }, core, null);
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /reference|syntax|rejected/i);
  assert.strictEqual(ggb.undoPoints, 1, 'no undo point for failed commands');
});

test('style_object: applies only given fields, validates ranges, single undo point', { skip }, async () => {
  const { executeTool, DEFAULT_SETTINGS } = await ai();
  const { ggb, core } = makeFakeGgb();
  ggb.evalCommandGetLabels('A = (1, 2)');
  const r = await executeTool('style_object', {
    name: 'A', color: '#ff0000', pointSize: 5,
    opacity: null, lineThickness: null, visible: null, labelVisible: null, caption: null,
  }, null, DEFAULT_SETTINGS, core, null);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.applied.sort(), ['color', 'pointSize']);
  assert.ok(ggb._calls.some((c) => c[0] === 'setColor' && c[1] === 'A' && c[2] === 255));
  assert.strictEqual(ggb.undoPoints, 1);

  // out-of-range numbers are CLAMPED into GeoGebra's valid range (friendlier
  // to the model than a wasted error round)
  const clamped = await executeTool('style_object', {
    name: 'A', pointSize: 99, color: null, opacity: null, lineThickness: null, visible: null, labelVisible: null, caption: null,
  }, null, DEFAULT_SETTINGS, core, null);
  assert.strictEqual(clamped.ok, true);
  assert.ok(ggb._calls.some((c) => c[0] === 'setPointSize' && c[2] === 9), 'pointSize clamped to 9');

  const missing = await executeTool('style_object', {
    name: 'ZZZ', color: 'red', opacity: null, lineThickness: null, pointSize: null, visible: null, labelVisible: null, caption: null,
  }, null, DEFAULT_SETTINGS, core, null);
  assert.match(missing.error, /No object named/);
});

test('set_view: full window or null, axes/grid toggles, rejects half windows', { skip }, async () => {
  const { executeTool, DEFAULT_SETTINGS } = await ai();
  const { ggb, core } = makeFakeGgb();
  const r = await executeTool('set_view', { xmin: -5, xmax: 5, ymin: -3, ymax: 3, axes: true, grid: false }, null, DEFAULT_SETTINGS, core, null);
  assert.strictEqual(r.ok, true);
  assert.ok(ggb._calls.some((c) => c[0] === 'setCoordSystem' && c[1] === -5));
  assert.ok(ggb._calls.some((c) => c[0] === 'setGridVisible' && c[1] === false));

  const half = await executeTool('set_view', { xmin: -5, xmax: null, ymin: null, ymax: null, axes: null, grid: null }, null, DEFAULT_SETTINGS, core, null);
  assert.strictEqual(half.ok, false);
  assert.match(half.error, /ALL of xmin/);

  const inverted = await executeTool('set_view', { xmin: 5, xmax: -5, ymin: -3, ymax: 3, axes: null, grid: null }, null, DEFAULT_SETTINGS, core, null);
  assert.strictEqual(inverted.ok, false);
});

test('evaluate_expression: CAS result; assignments and failures handled', { skip }, async () => {
  const { executeTool, DEFAULT_SETTINGS } = await ai();
  const { core } = makeFakeGgb();
  const r = await executeTool('evaluate_expression', { expression: 'Integral(x^2, 0, 1)' }, null, DEFAULT_SETTINGS, core, null);
  assert.strictEqual(r.ok, true);
  assert.match(r.result, /^cas\(/);

  const assign = await executeTool('evaluate_expression', { expression: 'a = 5' }, null, DEFAULT_SETTINGS, core, null);
  assert.strictEqual(assign.ok, false);
  assert.match(assign.error, /read-only/);

  const fail = await executeTool('evaluate_expression', { expression: 'bad(1)' }, null, DEFAULT_SETTINGS, core, null);
  assert.strictEqual(fail.ok, false);
  assert.match(fail.error, /CAS could not/);
});

test('delete_object stays gated behind allowRiskyCommands and marks an undo point', { skip }, async () => {
  const { executeTool, DEFAULT_SETTINGS } = await ai();
  const { ggb, core } = makeFakeGgb();
  ggb.evalCommandGetLabels('a = 1');
  const blocked = await executeTool('delete_object', { name: 'a' }, null, DEFAULT_SETTINGS, core, null);
  assert.strictEqual(blocked.ok, false);
  assert.match(blocked.error, /disabled/i);
  assert.ok(ggb.exists('a'));

  const allowed = await executeTool('delete_object', { name: 'a' }, null, { ...DEFAULT_SETTINGS, allowRiskyCommands: true }, core, null);
  assert.strictEqual(allowed.ok, true);
  assert.ok(!ggb.exists('a'));
  assert.strictEqual(ggb.undoPoints, 1, 'the delete is one undoable step (the test created `a` directly on the applet)');
});

/* ----------------------------- agent loop ----------------------------- */

function makeNetCtx(responses) {
  // ctx.net.fetch returning scripted Responses-API payloads in order; records
  // each request body so tests can inspect what was sent back to the model.
  let i = 0;
  const bodies = [];
  return {
    bodies,
    net: {
      fetch: async (_url, opts) => {
        bodies.push(opts && opts.body);
        const data = responses[Math.min(i, responses.length - 1)];
        i += 1;
        return { ok: true, status: 200, data };
      },
    },
  };
}

const fnCall = (name, args, id) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) });
const textOut = (text) => ({ output: [{ type: 'message', content: [{ text }] }] });

test('agent loop: executes tool calls, feeds results back, returns final text', { skip }, async () => {
  const { runAgentLoop, DEFAULT_SETTINGS, normalizeSettings } = await ai();
  const { core } = makeFakeGgb();
  const ctx = makeNetCtx([
    { output: [fnCall('create_object', { command: 'a = 2' }, 'c1')] },
    textOut('Created a slider a = 2.'),
  ]);
  const seen = [];
  const settings = normalizeSettings({ ...DEFAULT_SETTINGS, apiKey: 'sk-test', includeConstructionContext: false });
  const result = await runAgentLoop(settings, [{ role: 'user', content: 'make a=2' }], {
    ctx, core, dbg: null, onToolCall: (r) => seen.push(r.name),
  });
  assert.strictEqual(result.text, 'Created a slider a = 2.');
  assert.deepStrictEqual(seen, ['create_object']);
  assert.strictEqual(result.toolCalls[0].result.ok, true);
});

test('agent loop: reasoning items are echoed back with their function_calls (Responses API contract)', { skip }, async () => {
  const { runAgentLoop, DEFAULT_SETTINGS, normalizeSettings } = await ai();
  const { core } = makeFakeGgb();
  const reasoningItem = { type: 'reasoning', id: 'rs_test1', summary: [] };
  const callItem = fnCall('create_object', { command: 'a = 1' }, 'fc_test1');
  const ctx = makeNetCtx([
    { output: [reasoningItem, callItem] }, // reasoning model pairs these
    textOut('done'),
  ]);
  const settings = normalizeSettings({ ...DEFAULT_SETTINGS, apiKey: 'sk-test', includeConstructionContext: false });
  await runAgentLoop(settings, [{ role: 'user', content: 'make a=1' }], { ctx, core, dbg: null });

  // The SECOND request's input must replay reasoning → function_call →
  // function_call_output in order, or the API rejects the function_call
  // ("provided without its required 'reasoning' item").
  const input2 = ctx.bodies[1].input;
  const iReasoning = input2.findIndex((x) => x && x.type === 'reasoning' && x.id === 'rs_test1');
  const iCall = input2.findIndex((x) => x && x.type === 'function_call' && x.call_id === 'fc_test1');
  const iOutput = input2.findIndex((x) => x && x.type === 'function_call_output' && x.call_id === 'fc_test1');
  assert.ok(iReasoning >= 0, 'reasoning item echoed back');
  assert.ok(iCall > iReasoning, 'function_call follows its reasoning item');
  assert.ok(iOutput > iCall, 'function_call_output follows the function_call');
});

test('agent loop: cancellation stops before the next tool executes', { skip }, async () => {
  const { runAgentLoop, DEFAULT_SETTINGS, normalizeSettings } = await ai();
  const { ggb, core } = makeFakeGgb();
  const ctx = makeNetCtx([
    { output: [fnCall('create_object', { command: 'a = 1' }, 'c1'), fnCall('create_object', { command: 'b = 2' }, 'c2')] },
    textOut('done'),
  ]);
  let cancelled = false;
  const settings = normalizeSettings({ ...DEFAULT_SETTINGS, apiKey: 'sk-test', includeConstructionContext: false });
  await assert.rejects(
    runAgentLoop(settings, [{ role: 'user', content: 'two sliders' }], {
      ctx, core, dbg: null,
      onToolCall: () => { cancelled = true; }, // cancel after the FIRST tool
      isCancelled: () => cancelled,
    }),
    (err) => err.name === 'CancelledError',
  );
  assert.ok(ggb.exists('a'), 'first tool ran');
  assert.ok(!ggb.exists('b'), 'second tool never executed after cancel');
});

test('agent loop: budget exhaustion returns a summary of what was done', { skip }, async () => {
  const { runAgentLoop, DEFAULT_SETTINGS, normalizeSettings } = await ai();
  const { core } = makeFakeGgb();
  // The model calls a tool EVERY round and never produces text.
  let n = 0;
  const ctx = {
    net: {
      fetch: async () => {
        n += 1;
        return { ok: true, status: 200, data: { output: [fnCall('create_object', { command: `p${n} = ${n}` }, `c${n}`)] } };
      },
    },
  };
  const settings = normalizeSettings({ ...DEFAULT_SETTINGS, apiKey: 'sk-test', includeConstructionContext: false });
  const result = await runAgentLoop(settings, [{ role: 'user', content: 'go wild' }], { ctx, core, dbg: null });
  assert.match(result.text, /tool budget/i, 'tells the user the budget ran out');
  assert.match(result.text, /created p1/, 'summarizes what actually happened');
  assert.ok(result.toolCalls.length >= 6, 'ran multiple rounds before stopping');
});

/* ----------------------- Gemini provider + misc (round 3) ----------------------- */

test('settings: provider/gemini fields normalize; logLevel migrates the old debug boolean', { skip }, async () => {
  const { normalizeSettings } = await ai();
  const s1 = normalizeSettings({ debug: true });
  assert.strictEqual(s1.logLevel, 'debug', 'debug:true → logLevel debug');
  assert.strictEqual('debug' in s1, false, 'legacy boolean dropped');
  const s2 = normalizeSettings({});
  assert.strictEqual(s2.logLevel, 'off');
  assert.strictEqual(s2.provider, 'openai');
  assert.strictEqual(s2.geminiModel, 'gemini-3.5-flash');
  assert.match(s2.geminiEndpoint, /^https:\/\/generativelanguage\.googleapis\.com/);
  const s3 = normalizeSettings({ provider: 'gemini', logLevel: 'info' });
  assert.strictEqual(s3.provider, 'gemini');
  assert.strictEqual(s3.logLevel, 'info');
});

test('toGeminiSchema: strips strict/additionalProperties, maps null types to nullable, recomputes required', { skip }, async () => {
  const { toGeminiSchema, GGB_TOOLS } = await ai();
  const style = GGB_TOOLS.find((t) => t.name === 'style_object');
  const g = toGeminiSchema(style.parameters);
  assert.strictEqual(g.additionalProperties, undefined);
  assert.strictEqual(g.properties.color.nullable, true, "['string','null'] → nullable");
  assert.strictEqual(g.properties.color.type, 'string');
  assert.deepStrictEqual(g.required, ['name'], 'only non-nullable fields stay required');
});

test('gemini provider: contents flow — system instruction, functionCall ids echoed in ONE user turn with the note', { skip }, async () => {
  const { runAgentLoop, DEFAULT_SETTINGS, normalizeSettings } = await ai();
  const { ggb, core } = makeFakeGgb();
  const bodies = [];
  let n = 0;
  const responses = [
    { candidates: [{ content: { role: 'model', parts: [
      { functionCall: { id: 'fc_g1', name: 'create_object', args: { command: 'a = 1' } } },
      { functionCall: { id: 'fc_g2', name: 'create_object', args: { command: 'b = 2' } } },
    ] } }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'made a and b' }] } }] },
  ];
  const ctx = { net: { fetch: async (url, opts) => { bodies.push({ url, body: opts.body, headers: opts.headers }); const d = responses[Math.min(n, responses.length - 1)]; n += 1; return { ok: true, status: 200, data: d }; } } };
  const settings = normalizeSettings({ ...DEFAULT_SETTINGS, provider: 'gemini', geminiApiKey: 'AIza-test', includeConstructionContext: false });
  const result = await runAgentLoop(settings, [{ role: 'user', content: 'two sliders' }], { ctx, core, dbg: null });

  assert.strictEqual(result.text, 'made a and b');
  assert.ok(ggb.exists('a') && ggb.exists('b'), 'both tools executed');
  assert.match(bodies[0].url, /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-.*:generateContent/);
  assert.strictEqual(bodies[0].headers['x-goog-api-key'], 'AIza-test', 'key in header, not URL');
  assert.ok(bodies[0].body.systemInstruction.parts[0].text.length > 0, 'system instruction present');
  assert.ok(bodies[0].body.tools[0].functionDeclarations.length >= 7, 'tools declared');

  // Second request: model turn echoed verbatim, then ONE user turn with BOTH
  // functionResponses (ids echoed) — never two consecutive same-role turns.
  const contents2 = bodies[1].body.contents;
  const modelTurn = contents2.find((c) => c.role === 'model' && c.parts.some((p) => p.functionCall));
  assert.ok(modelTurn, 'model functionCall turn replayed');
  const frTurns = contents2.filter((c) => c.parts.some((p) => p.functionResponse));
  assert.strictEqual(frTurns.length, 1, 'all tool outputs in a single user turn');
  assert.strictEqual(frTurns[0].role, 'user');
  const ids = frTurns[0].parts.filter((p) => p.functionResponse).map((p) => p.functionResponse.id);
  assert.deepStrictEqual(ids, ['fc_g1', 'fc_g2'], 'functionCall ids echoed back');
  assert.strictEqual(contents2.indexOf(frTurns[0]) - contents2.indexOf(modelTurn), 1, 'functionResponse turn immediately follows the model turn');
});

test('advanced-commands lazy load: transient "not loaded yet" is retried, then succeeds', { skip }, async () => {
  const { executeTool, DEFAULT_SETTINGS } = await ai();
  const { ggb, core } = makeFakeGgb();
  let failures = 2;
  const orig = ggb.evalCommandGetLabels.bind(ggb);
  ggb.evalCommandGetLabels = (cmd) => {
    if (failures > 0) { failures -= 1; throw new Error('Class$S394: Advanced commands not loaded yet'); }
    return orig(cmd);
  };
  const r = await executeTool('create_object', { command: 'h = 7' }, null, DEFAULT_SETTINGS, core, null);
  assert.strictEqual(r.ok, true, 'succeeded after the module finished loading');
  assert.deepStrictEqual(r.created, ['h']);
  assert.strictEqual(failures, 0, 'retried through both transient failures');
});

test('OpenAI payload: stateless mode (store:false) with encrypted reasoning included for reasoning models', { skip }, async () => {
  const { buildRequestPayload, DEFAULT_SETTINGS, normalizeSettings } = await ai();
  const reasoning = buildRequestPayload(normalizeSettings({ ...DEFAULT_SETTINGS, model: 'gpt-5.5' }), []);
  assert.strictEqual(reasoning.store, false);
  assert.deepStrictEqual(reasoning.include, ['reasoning.encrypted_content']);
  const plain = buildRequestPayload(normalizeSettings({ ...DEFAULT_SETTINGS, model: 'gpt-4.1-mini' }), []);
  assert.strictEqual(plain.store, false);
  assert.strictEqual(plain.include, undefined, 'no reasoning include for non-reasoning models');
});

test('renderRichText: markdown + LaTeX subset renders to safe DOM', { skip }, async () => {
  if (!(() => { try { require.resolve('jsdom'); return true; } catch { return false; } })()) return;
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body></body>');
  const saved = global.document;
  global.document = dom.window.document;
  try {
    const { renderRichText } = await ai();
    const div = dom.window.document.createElement('div');
    div.append(renderRichText('### Result\n**v** is $v_0 + a t$ and $x^2$, also \\(\\frac{1}{2} a t^2\\) with $\\alpha$\n- first\n`code`\n<script>alert(1)</script>'));
    const html = div.innerHTML;
    assert.ok(html.includes('<sub>0</sub>'), 'subscript rendered');
    assert.ok(html.includes('<sup>2</sup>'), 'superscript rendered');
    assert.ok(html.includes('1/2'), 'fraction flattened');
    assert.ok(html.includes('α'), 'greek mapped');
    assert.ok(html.includes('<strong>v</strong>'), 'bold rendered');
    assert.ok(html.includes('md-li'), 'list rendered');
    assert.ok(!html.includes('<script>'), 'raw HTML is never injected');
    assert.ok(html.includes('&lt;script&gt;'), 'model HTML is escaped as text');
  } finally { global.document = saved; }
});
