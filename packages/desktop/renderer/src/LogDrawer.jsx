import React, { useEffect, useRef } from 'react';
import { T } from './ui.js';

const LEVEL = { info: T.sub, step: T.blue, ok: T.green, warn: T.amber, error: T.red };
const GLYPH = { info: '•', step: '→', ok: '✓', warn: '!', error: '✗' };

/** Bottom drawer showing the live engine log during inject/restore. */
export default function LogDrawer({ open, logs, onClose }) {
  const boxRef = useRef(null);
  useEffect(() => { if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight; }, [logs]);
  if (!open) return null;

  return (
    <div style={{ flexShrink: 0, borderTop: `1px solid ${T.border}`, background: T.surface }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 20px' }}>
        <span style={{ fontSize: 12, fontWeight: 500, color: T.sub }}>Activity log</span>
        <button onClick={onClose} style={{ appearance: 'none', border: 'none', background: 'transparent', color: T.dim, cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }}>Collapse ✕</button>
      </div>
      <div ref={boxRef} style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, padding: '0 20px 14px', maxHeight: 168, overflowY: 'auto', background: T.surfaceAlt, margin: '0 12px 12px', borderRadius: 10 }}>
        <div style={{ padding: '10px 0' }}>
          {logs.length === 0 && <div style={{ color: T.dim }}>Waiting…</div>}
          {logs.map((l, i) => (
            <div key={i} style={{ color: LEVEL[l.level] || T.text, lineHeight: 1.7 }}>
              <span style={{ opacity: 0.6, marginRight: 6 }}>{GLYPH[l.level] || '·'}</span>{l.msg}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
