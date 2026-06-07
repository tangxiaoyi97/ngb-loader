/** The installer wizard (React): Welcome → Choose target → Run (live log) → Done. */
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

const STEPS = ['welcome', 'choose', 'run', 'done'];

function useWebSocket(onMessage) {
  const ref = useRef(null);
  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (e) => {
      try { onMessage(JSON.parse(e.data)); } catch { /* ignore */ }
    };
    ref.current = ws;
    return () => ws.close();
  }, [onMessage]);
  return ref;
}

function Logo() {
  return (
    <div className="flex items-center gap-3">
      <span className="text-3xl text-indigo-400 drop-shadow-[0_0_10px_rgba(122,162,255,0.6)]">⬡</span>
      <div>
        <div className="text-lg font-semibold tracking-tight">GGB-Extend</div>
        <div className="text-xs text-slate-400">Installer · v0.1.0</div>
      </div>
    </div>
  );
}

function Stepper({ step }) {
  const labels = ['Welcome', 'Target', 'Install', 'Done'];
  return (
    <div className="flex items-center gap-2 text-xs">
      {labels.map((l, i) => (
        <React.Fragment key={l}>
          <span className={`px-2 py-1 rounded-full ${i <= step ? 'bg-indigo-500/20 text-indigo-200' : 'text-slate-500'}`}>{l}</span>
          {i < labels.length - 1 && <span className={i < step ? 'text-indigo-400' : 'text-slate-600'}>→</span>}
        </React.Fragment>
      ))}
    </div>
  );
}

function Welcome({ onNext }) {
  const [agree, setAgree] = useState(false);
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold">Welcome</h1>
      <p className="text-slate-300 leading-relaxed">
        GGB-Extend adds a plugin system to GeoGebra without modifying GeoGebra's own
        code. It installs a small proxy that boots first, mounts an isolated panel,
        then hands control to the original app. You can fully uninstall at any time.
      </p>
      <div className="rounded-xl bg-amber-500/10 border border-amber-500/30 p-4 text-sm text-amber-200">
        <strong>Heads up:</strong> this modifies files inside your GeoGebra installation
        (renaming the original app payload and adding a proxy). A backup is created and a
        one-click uninstall restores everything. You may need to grant permission
        (admin / sudo) for the install folder.
      </div>
      <label className="flex items-center gap-3 text-sm text-slate-300 cursor-pointer select-none">
        <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)}
          className="w-4 h-4 accent-indigo-500" />
        I understand and want to continue.
      </label>
      <div className="flex justify-end">
        <button disabled={!agree} onClick={onNext}
          className="px-5 py-2.5 rounded-lg bg-indigo-500 hover:bg-indigo-400 disabled:opacity-40 disabled:cursor-not-allowed font-medium transition">
          Get started
        </button>
      </div>
    </div>
  );
}

function TargetRow({ target, selected, onSelect }) {
  const stateColor = target.state === 'pristine'
    ? 'text-emerald-300 bg-emerald-500/15'
    : target.state === 'injected'
    ? 'text-sky-300 bg-sky-500/15'
    : 'text-amber-300 bg-amber-500/15';
  return (
    <button onClick={() => onSelect(target)}
      className={`w-full text-left p-3 rounded-xl border transition flex items-center gap-3 ${
        selected ? 'border-indigo-400 bg-indigo-500/10' : 'border-white/10 hover:bg-white/5'
      }`}>
      <span className={`text-[10px] uppercase tracking-wide px-2 py-1 rounded-full ${stateColor}`}>{target.state}</span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{target.appBundle || target.resources}</div>
        <div className="text-xs text-slate-400">GeoGebra {target.version || '?'} · {target.kind}</div>
      </div>
      {selected && <span className="text-indigo-400">✓</span>}
    </button>
  );
}

function ChooseTarget({ platform, onBack, onChosen }) {
  const [targets, setTargets] = useState(null);
  const [selected, setSelected] = useState(null);
  const [manual, setManual] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const scan = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/scan?platform=${platform}`);
      const j = await r.json();
      if (j.ok) { setTargets(j.targets); if (j.targets[0]) setSelected(j.targets[0]); }
      else setError(j.error);
    } catch (e) { setError(String(e.message)); }
    finally { setLoading(false); }
  }, [platform]);

  useEffect(() => { scan(); }, [scan]);

  async function useManual() {
    setError(null);
    try {
      const r = await fetch(`/api/status?platform=${platform}&path=${encodeURIComponent(manual)}`);
      const j = await r.json();
      if (j.ok) { setSelected(j.target); setTargets((t) => [j.target, ...(t || []).filter((x) => x.resources !== j.target.resources)]); }
      else setError(j.error);
    } catch (e) { setError(String(e.message)); }
  }

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold">Choose your GeoGebra</h1>
      {loading && <p className="text-slate-400 text-sm">Scanning for installations…</p>}
      {error && <div className="rounded-lg bg-rose-500/10 border border-rose-500/30 p-3 text-sm text-rose-200">{error}</div>}

      <div className="space-y-2">
        {targets && targets.length === 0 && (
          <p className="text-slate-400 text-sm">No installs found automatically — point us at it below.</p>
        )}
        {targets && targets.map((t) => (
          <TargetRow key={t.resources} target={t} selected={selected && selected.resources === t.resources} onSelect={setSelected} />
        ))}
      </div>

      <div className="space-y-2">
        <div className="text-xs text-slate-400">Or enter a path manually</div>
        <div className="flex gap-2">
          <input value={manual} onChange={(e) => setManual(e.target.value)}
            placeholder={platform === 'win32' ? 'C:\\Program Files\\GeoGebra' : '/Applications/GeoGebra Classic 6.app'}
            className="flex-1 bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-400" />
          <button onClick={useManual} className="px-3 py-2 rounded-lg border border-white/10 text-sm hover:bg-white/5">Check</button>
        </div>
      </div>

      <div className="flex justify-between pt-2">
        <button onClick={onBack} className="px-4 py-2 rounded-lg text-slate-300 hover:bg-white/5 text-sm">Back</button>
        <button disabled={!selected} onClick={() => onChosen(selected)}
          className="px-5 py-2.5 rounded-lg bg-indigo-500 hover:bg-indigo-400 disabled:opacity-40 font-medium transition">
          {selected && selected.state === 'injected' ? 'Manage / Uninstall' : 'Install'}
        </button>
      </div>
    </div>
  );
}

const LEVEL_STYLE = {
  info: 'text-slate-400', step: 'text-sky-300', ok: 'text-emerald-300', warn: 'text-amber-300', error: 'text-rose-300',
};
const LEVEL_GLYPH = { info: '•', step: '→', ok: '✓', warn: '!', error: '✗' };

function RunStep({ target, platform, logs, onLog, running, setRunning, onDone, mode }) {
  const [error, setError] = useState(null);
  const logBoxRef = useRef(null);

  useEffect(() => {
    if (logBoxRef.current) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
  }, [logs]);

  const op = mode === 'uninstall' ? 'uninstall' : 'inject';

  const run = useCallback(async () => {
    setError(null); setRunning(true);
    try {
      const r = await fetch(`/api/${op}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: target.appBundle || target.resources, platform }),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error); setRunning(false); return; }
      setRunning(false);
      onDone(j.result);
    } catch (e) { setError(String(e.message)); setRunning(false); }
  }, [op, target, platform, setRunning, onDone]);

  useEffect(() => { run(); /* auto-run on entry */ }, []); // eslint-disable-line

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{op === 'uninstall' ? 'Uninstalling…' : 'Installing…'}</h1>
      <div className="text-sm text-slate-400 truncate">{target.appBundle || target.resources}</div>

      <div className="h-1.5 w-full bg-white/10 rounded-full overflow-hidden">
        <div className={`h-full bg-indigo-500 transition-all duration-500 ${running ? 'w-2/3 animate-pulse' : 'w-full'}`} />
      </div>

      <div ref={logBoxRef}
        className="font-mono text-xs bg-black/40 border border-white/10 rounded-xl p-3 h-56 overflow-y-auto space-y-1">
        {logs.length === 0 && <div className="text-slate-500">Starting…</div>}
        {logs.map((l, i) => (
          <div key={i} className={LEVEL_STYLE[l.level] || 'text-slate-300'}>
            <span className="opacity-60 mr-1">{LEVEL_GLYPH[l.level] || '·'}</span>{l.msg}
          </div>
        ))}
      </div>

      {error && <div className="rounded-lg bg-rose-500/10 border border-rose-500/30 p-3 text-sm text-rose-200">{error}</div>}
    </div>
  );
}

function Done({ result, mode, onRestart }) {
  const uninstalled = mode === 'uninstall';
  return (
    <div className="space-y-5 text-center">
      <div className="text-5xl">{uninstalled ? '🧹' : '🎉'}</div>
      <h1 className="text-2xl font-semibold">{uninstalled ? 'Uninstalled' : 'All set!'}</h1>
      {uninstalled ? (
        <p className="text-slate-300">GeoGebra has been restored to its original state.</p>
      ) : (
        <div className="space-y-3 text-slate-300">
          <p>GGB-Extend is installed. Launch GeoGebra and press <kbd className="px-2 py-0.5 bg-white/10 rounded border border-white/15 font-mono text-xs">Right&nbsp;Shift</kbd> to open the plugin panel.</p>
          <p className="text-sm text-slate-400">Drop plugin folders into your <span className="text-slate-200">GGB_Plugins</span> directory, then Refresh in the panel.</p>
        </div>
      )}
      <button onClick={onRestart} className="px-5 py-2.5 rounded-lg border border-white/10 hover:bg-white/5 text-sm">
        Done
      </button>
    </div>
  );
}

function App() {
  const [stepIdx, setStepIdx] = useState(0);
  const [target, setTarget] = useState(null);
  const [logs, setLogs] = useState([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const platform = 'auto'; // server defaults to its own process.platform
  const [mode, setMode] = useState('inject');

  const onMessage = useCallback((msg) => {
    if (msg.kind === 'log' && msg.entry) setLogs((l) => [...l, msg.entry]);
    if (msg.kind === 'op-start') setLogs([]);
  }, []);
  useWebSocket(onMessage);

  const step = STEPS[stepIdx];

  return (
    <div className="min-h-screen text-slate-100 flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-xl">
        <div className="flex items-center justify-between mb-6">
          <Logo />
          <Stepper step={stepIdx} />
        </div>
        <div className="rounded-2xl bg-slate-900/60 backdrop-blur-xl border border-white/10 p-8 shadow-2xl">
          {step === 'welcome' && <Welcome onNext={() => setStepIdx(1)} />}
          {step === 'choose' && (
            <ChooseTarget platform={platform}
              onBack={() => setStepIdx(0)}
              onChosen={(t) => { setTarget(t); setMode(t.state === 'injected' ? 'uninstall' : 'inject'); setStepIdx(2); }} />
          )}
          {step === 'run' && target && (
            <RunStep target={target} platform={platform} logs={logs} onLog={setLogs}
              running={running} setRunning={setRunning} mode={mode}
              onDone={(r) => { setResult(r); setStepIdx(3); }} />
          )}
          {step === 'done' && <Done result={result} mode={mode} onRestart={() => { setStepIdx(0); setTarget(null); setLogs([]); setResult(null); }} />}
        </div>
        <div className="text-center text-xs text-slate-500 mt-4">
          GGB-Extend is non-invasive · your original files are backed up
        </div>
      </div>
    </div>
  );
}

const rootEl = document.getElementById('root');
createRoot(rootEl).render(<App />);
