import Link from "next/link";

export default function ApiPlayground() {
  return (
    <section id="api-interface" className="api-playground" aria-labelledby="api-playground-title">
      <style>{`
        .api-playground{position:relative;z-index:1;margin-top:90px;border:1px solid #343438;border-radius:24px;background:#f1f1ef;color:#18181a;overflow:hidden;box-shadow:0 24px 80px #00000035}.api-playground-intro{display:flex;justify-content:space-between;align-items:flex-end;gap:30px;padding:30px 32px;border-bottom:1px solid #d7d7d4}.api-playground-kicker{font:9px var(--font-geist-mono),monospace;letter-spacing:.14em;color:#6c6d72}.api-playground h1{font-size:clamp(2rem,4vw,4rem);font-weight:400;letter-spacing:-.08em;line-height:.98;margin:17px 0 0}.api-playground-intro p{max-width:390px;color:#68696e;font-size:13px;line-height:1.55;margin:0}.api-playground-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px;padding:26px 32px 30px}.api-api-details{min-width:0}.api-endpoint-label,.api-section-label{display:block;font:9px var(--font-geist-mono),monospace;letter-spacing:.12em;color:#85868b;margin-bottom:11px}.api-url{display:inline-block;color:#477b86;font:12px var(--font-geist-mono),monospace;overflow-wrap:anywhere;text-decoration:underline;text-decoration-color:#477b8666;text-underline-offset:4px}.api-endpoint{display:flex;align-items:center;gap:12px;min-width:0;margin-top:18px;padding:13px 15px;border:1px solid #d1d2cf;background:#fff}.api-method{color:#4d896d;font:10px var(--font-geist-mono),monospace;letter-spacing:.08em}.api-endpoint code{color:#242321;font:12px var(--font-geist-mono),monospace;overflow-wrap:anywhere}.api-auth{margin-left:auto;color:#77716a;font:9px var(--font-geist-mono),monospace;white-space:nowrap}.api-request{min-width:0}.api-code{display:block;width:100%;min-height:126px;margin:0;padding:15px;border:1px solid #d1d2cf;border-radius:7px;background:#242321;color:#f1f1ef;overflow:auto;font:11px/1.65 var(--font-geist-mono),monospace;white-space:pre}.api-notes{display:grid;gap:9px;margin-top:16px;color:#68696e;font-size:12px;line-height:1.55}.api-notes p{margin:0}.api-notes strong{color:#302e2a;font-weight:500}.api-notes code{color:#51483f;font:11px var(--font-geist-mono),monospace;overflow-wrap:anywhere}.api-playground-footer{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:17px 32px;border-top:1px solid #d7d7d4;color:#68696e;font-size:11px;line-height:1.55}.api-playground-links{display:flex;align-items:center;gap:22px}.api-key-link{flex:0 0 auto;color:#242321;text-decoration:none;border-bottom:1px solid #8d8d89;padding-bottom:4px;font:10px var(--font-geist-mono),monospace}.api-key-link:hover{border-color:#477b86;color:#477b86}.api-simulation-link{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;border-radius:999px;background:#171719;color:#f1f1ef;text-decoration:none;padding:12px 17px;font:10px var(--font-geist-mono),monospace;letter-spacing:.04em}.api-simulation-link:hover{background:#477b86}@media(max-width:760px){.api-playground{margin-top:60px;border-radius:18px}.api-playground-intro{display:block;padding:24px}.api-playground-intro p{margin-top:18px}.api-playground-layout{grid-template-columns:minmax(0,1fr);gap:24px;padding:22px 24px 25px}.api-playground-footer{align-items:flex-start;flex-direction:column;padding:16px 24px}.api-playground-links{align-items:flex-start;flex-direction:column;gap:16px}.api-endpoint{flex-wrap:wrap}.api-auth{margin-left:0}}@media(max-width:460px){.api-playground h1{font-size:clamp(1.8rem,9vw,2.7rem)}.api-playground-intro,.api-playground-layout,.api-playground-footer{padding-left:18px;padding-right:18px}.api-code{font-size:10px}}@media(prefers-reduced-motion:reduce){.api-key-link,.api-simulation-link{transition:none}}
      `}</style>
      <div className="api-playground-intro">
        <div>
          <span className="api-playground-kicker">// DEVELOPER ACCESS / CHAT API</span>
          <h1 id="api-playground-title">INFERENCE INFRASTRUCTURE.<br />BUILT FOR THE NEW ERA</h1>
        </div>
        <p>Use a first-party Openweight API key to send text conversations to the open model gateway. Provider credentials stay behind the service.</p>
      </div>
      <div className="api-playground-layout">
        <div className="api-api-details">
          <span className="api-section-label">BASE URL</span>
          <a className="api-url" href="https://openweight.systems">https://openweight.systems</a>
          <div className="api-endpoint"><span className="api-method">POST</span><code>/api/v1/chat/completions</code><span className="api-auth">Bearer API key</span></div>
          <div className="api-notes">
            <p>Authenticate with <code>Authorization: Bearer &lt;your key&gt;</code>.</p>
            <p><strong>model</strong> accepts <code>auto</code> or an active open model ID.</p>
            <p><strong>stream</strong> may be set to <code>true</code> for server-sent event responses.</p>
          </div>
        </div>
        <div className="api-request">
          <span className="api-section-label">JSON REQUEST</span>
          <pre className="api-code"><code>{`{
  "model": "auto",
  "messages": [
    { "role": "user", "content": "Hello" }
  ]
}`}</code></pre>
          <div className="api-notes">
            <p>Messages support <code>system</code>, <code>user</code>, and <code>assistant</code> roles with text content.</p>
            <p>Inference requires verified holder eligibility and available compute. Usage is settled from provider-reported usage.</p>
          </div>
        </div>
      </div>
      <div className="api-playground-footer">
        <span>Explore the interactive simulation or manage your account keys.</span>
        <div className="api-playground-links">
          <Link className="api-simulation-link" href="/playground">OPEN PLAYGROUND ↗</Link>
          <Link className="api-key-link" href="/settings">MANAGE API KEYS ↗</Link>
        </div>
      </div>
    </section>
  );
}