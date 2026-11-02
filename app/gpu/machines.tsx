"use client";

import { useEffect, useMemo, useState } from "react";

// Rented machines and the launch dialog for /gpu. Data comes from
// /api/gpu/instances; every price shown is the workspace price.

export type Rental = {
  id: string;
  status: "launching" | "running" | "ended" | "failed";
  endReason: "user_stopped" | "balance_exhausted" | "provider_ended" | "launch_failed" | null;
  setup: string;
  setupId: string;
  model: string | null;
  gpuName: string;
  gpuCount: number | null;
  gpuRamGb: number | null;
  location: string | null;
  hourlyRateUsd: number;
  chargedUsd: number;
  paidUntil: string | null;
  renewalBlocked: boolean;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  access: {
    jupyterUrl: string | null;
    sshCommand: string | null;
    sshKeyAttached: boolean;
    apiBaseUrl: string | null;
    apiKey: string | null;
  } | null;
};

export type SetupTemplate = {
  id: string;
  name: string;
  description: string;
  minCuda: number;
  portsNeeded: number;
  access: string[];
  models: Array<{ id: string; label: string; minVramGb: number }> | null;
  defaultModel: string | null;
};

export type RentalSettings = {
  blockMinutes: number;
  maxHourlyUsd: number;
  maxActiveRentals: number;
  templates: SetupTemplate[];
};

export type LaunchableOffer = {
  id: number | string | null;
  gpuName: string;
  gpuCount: number | null;
  gpuRamGb: number | null;
  hourlyPriceUsd: number | null;
  location: string | null;
  cudaMaxGood: number | null;
  directPortCount: number | null;
};

const money = (value: number) => `$${value < 1 ? value.toFixed(3) : value.toFixed(2)}`;
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const SSH_KEY_STORAGE = "openweight:gpu:ssh-key";

function duration(fromIso: string, toIso: string | null): string {
  const ms = Math.max(0, (toIso ? new Date(toIso).getTime() : Date.now()) - new Date(fromIso).getTime());
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

const END_COPY: Record<NonNullable<Rental["endReason"]>, string> = {
  user_stopped: "Stopped by you",
  balance_exhausted: "Stopped: balance ran out",
  provider_ended: "Stopped by its host",
  launch_failed: "Did not start · refunded",
};

/** Why a setup cannot run on an offer, mirroring the server's check. */
export function setupBlocker(template: SetupTemplate, offer: LaunchableOffer, modelId: string | null): string | null {
  if (offer.cudaMaxGood !== null && offer.cudaMaxGood < template.minCuda) return `Needs CUDA ${template.minCuda}+ (this machine has ${offer.cudaMaxGood}).`;
  if (offer.directPortCount !== null && offer.directPortCount < template.portsNeeded) return "This machine cannot open the ports this setup needs.";
  if (template.models) {
    const model = template.models.find((option) => option.id === modelId);
    if (!model) return "Choose a model.";
    if (offer.gpuRamGb !== null && offer.gpuRamGb < model.minVramGb * 0.93) return `${model.label} needs ${model.minVramGb} GB of VRAM.`;
  }
  return null;
}

function CopyField({ label, value, secret = false }: { label: string; value: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(!secret);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setRevealed(true);
    }
  };
  return (
    <div className="gpu-access-field">
      <span className="gpu-field-label">{label}</span>
      <div className="gpu-access-value">
        <code>{revealed ? value : "•".repeat(Math.min(28, value.length))}</code>
        {secret && (
          <button type="button" className="gpu-text-button" onClick={() => setRevealed((current) => !current)}>
            {revealed ? "Hide" : "Show"}
          </button>
        )}
        <button type="button" className="gpu-text-button" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function RentalCard({ rental, onStop, busy }: { rental: Rental; onStop: (rental: Rental) => void; busy: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const active = rental.status === "launching" || rental.status === "running";
  const ready = rental.status === "running" && rental.access !== null;
  const stateLabel = rental.status === "running" ? (ready ? "RUNNING" : "CONNECTING") : rental.status === "launching" ? "STARTING" : rental.endReason ? END_COPY[rental.endReason].toUpperCase() : "ENDED";
  return (
    <article className={`gpu-machine${active ? "" : " is-ended"}`}>
      <div className="gpu-machine-head">
        <div className="gpu-machine-title">
          <span className={`gpu-machine-state is-${rental.status}`}><i aria-hidden="true" />{stateLabel}</span>
          <h3>{rental.gpuCount && rental.gpuCount > 1 ? `${rental.gpuCount} × ` : ""}{rental.gpuName}</h3>
          <p>{rental.setup}{rental.model ? ` · ${rental.model}` : ""}{rental.location ? ` · ${rental.location}` : ""}</p>
        </div>
        <dl className="gpu-machine-figures">
          <div><dt>RATE</dt><dd>{money(rental.hourlyRateUsd)}<small>/HR</small></dd></div>
          <div><dt>CHARGED</dt><dd>{money(rental.chargedUsd)}</dd></div>
          <div><dt>{rental.status === "launching" ? "ELAPSED" : active ? "UPTIME" : "RAN FOR"}</dt><dd>{duration(rental.startedAt ?? rental.createdAt, rental.endedAt)}</dd></div>
        </dl>
      </div>

      {rental.status === "launching" && (
        <p className="gpu-machine-note">Setting the machine up. This usually takes 2–10 minutes. Billing has started; if it never starts, you get it all back.</p>
      )}

      {active && rental.renewalBlocked && rental.paidUntil && (
        <p className="gpu-machine-note is-warning">Your balance can’t cover more time, so this machine stops at {clock(rental.paidUntil)}.</p>
      )}

      {ready && rental.access && (
        <div className="gpu-access">
          {rental.access.jupyterUrl && (
            <a className="gpu-pill is-warm" href={rental.access.jupyterUrl} target="_blank" rel="noreferrer noopener">
              Open JupyterLab <span aria-hidden="true">↗</span>
            </a>
          )}
          {rental.access.apiBaseUrl && <CopyField label="API BASE URL (OPENAI-COMPATIBLE)" value={rental.access.apiBaseUrl} />}
          {rental.access.apiKey && <CopyField label="API KEY" value={rental.access.apiKey} secret />}
          {rental.access.sshCommand && rental.access.sshKeyAttached && <CopyField label="SSH" value={rental.access.sshCommand} />}
          {rental.access.jupyterUrl && <p className="gpu-access-hint">Your browser may warn about the notebook’s self-signed certificate; that is expected.</p>}
          {rental.access.apiBaseUrl && <p className="gpu-access-hint">The model downloads on first start, so the API can take a few more minutes to answer.</p>}
        </div>
      )}

      {active && (
        <div className="gpu-machine-foot">
          <span className="gpu-machine-paid">{rental.paidUntil ? `PREPAID UNTIL ${clock(rental.paidUntil)} · BILLED PER MINUTE` : "BILLED PER MINUTE"}</span>
          {confirming ? (
            <span className="gpu-confirm">
              <span>Stop and delete this machine’s disk?</span>
              <button type="button" className="gpu-pill is-danger" disabled={busy} onClick={() => onStop(rental)}>{busy ? "Stopping…" : "Stop machine"}</button>
              <button type="button" className="gpu-pill" disabled={busy} onClick={() => setConfirming(false)}>Keep running</button>
            </span>
          ) : (
            <button type="button" className="gpu-pill" onClick={() => setConfirming(true)}>Stop</button>
          )}
        </div>
      )}
    </article>
  );
}

export function MachinesSection({ rentals, onStop, stopping, notice }: { rentals: Rental[]; onStop: (rental: Rental) => void; stopping: string | null; notice: string | null }) {
  if (rentals.length === 0 && !notice) return null;
  const activeCount = rentals.filter((rental) => rental.status === "launching" || rental.status === "running").length;
  return (
    <section className="gpu-machines" aria-labelledby="gpu-machines-title" id="your-machines">
      <div className="gpu-results-head">
        <div className="gpu-results-title-wrap">
          <span className="gpu-kicker">YOUR MACHINES</span>
          <h2 id="gpu-machines-title">{activeCount > 0 ? `${activeCount} active.` : "Recent machines."}</h2>
        </div>
      </div>
      {notice && <p className="gpu-machine-notice" role="status">{notice}</p>}
      <div className="gpu-machine-list">
        {rentals.map((rental) => <RentalCard key={rental.id} rental={rental} onStop={onStop} busy={stopping === rental.id} />)}
      </div>
    </section>
  );
}

export function LaunchDialog({ offer, settings, balanceUsd, onClose, onLaunch }: {
  offer: LaunchableOffer;
  settings: RentalSettings;
  balanceUsd: number | null;
  onClose: () => void;
  onLaunch: (input: { template: string; model: string | null; sshPublicKey: string | null }) => Promise<string | null>;
}) {
  const firstUsable = settings.templates.find((template) => !setupBlocker(template, offer, template.defaultModel)) ?? settings.templates[0];
  const [templateId, setTemplateId] = useState(firstUsable?.id ?? "");
  const template = settings.templates.find((item) => item.id === templateId) ?? null;
  const [model, setModel] = useState<string | null>(firstUsable?.defaultModel ?? null);
  // The dialog only renders after a click, so reading storage here is client-side.
  const [sshKey, setSshKey] = useState(() => {
    try {
      return window.localStorage.getItem(SSH_KEY_STORAGE) ?? "";
    } catch {
      return ""; // Storage unavailable: the field simply starts empty.
    }
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !submitting) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, submitting]);

  const hourly = offer.hourlyPriceUsd;
  const firstBlock = hourly === null ? null : (hourly * settings.blockMinutes) / 60;
  const blocker = template ? setupBlocker(template, offer, template.models ? model : null) : "Choose a setup.";
  const priceBlocker = hourly !== null && hourly > settings.maxHourlyUsd ? `Machines above ${money(settings.maxHourlyUsd)}/hr can’t be launched from the workspace.` : null;
  const balanceBlocker = firstBlock !== null && balanceUsd !== null && balanceUsd < firstBlock ? `Your balance (${money(balanceUsd)}) needs to cover the first ${settings.blockMinutes} minutes (${money(firstBlock)}).` : null;
  const hoursAvailable = hourly && balanceUsd !== null ? balanceUsd / hourly : null;
  const disabledReason = priceBlocker ?? blocker ?? balanceBlocker;

  const chooseTemplate = (next: SetupTemplate) => {
    setTemplateId(next.id);
    setModel(next.defaultModel);
    setError(null);
  };

  const submit = async () => {
    if (!template || disabledReason) return;
    setSubmitting(true);
    setError(null);
    const key = sshKey.trim() || null;
    try {
      if (key) window.localStorage.setItem(SSH_KEY_STORAGE, key);
    } catch {
      // Remembering the key is a convenience only.
    }
    const failure = await onLaunch({ template: template.id, model: template.models ? model : null, sshPublicKey: key });
    setSubmitting(false);
    if (failure) setError(failure);
  };

  const modelOptions = useMemo(() => template?.models ?? [], [template]);

  return (
    <div className="gpu-dialog-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget && !submitting) onClose(); }}>
      <div className="gpu-dialog" role="dialog" aria-modal="true" aria-labelledby="gpu-dialog-title">
        <header className="gpu-dialog-head">
          <div>
            <span className="gpu-kicker">LAUNCH A MACHINE</span>
            <h2 id="gpu-dialog-title">{offer.gpuCount && offer.gpuCount > 1 ? `${offer.gpuCount} × ` : ""}{offer.gpuName}</h2>
            <p>{[offer.gpuRamGb !== null ? `${offer.gpuRamGb} GB VRAM` : null, offer.location].filter(Boolean).join(" · ")}</p>
          </div>
          <span className="gpu-price">{hourly === null ? "—" : money(hourly)}<small>/ HR</small></span>
        </header>

        <fieldset className="gpu-setups">
          <legend className="gpu-field-label">SETUP</legend>
          {settings.templates.map((item) => {
            const itemBlocker = setupBlocker(item, offer, item.models ? (item.id === templateId ? model : item.defaultModel) : null);
            const unusable = Boolean(itemBlocker && (!item.models || !item.models.some((option) => !setupBlocker(item, offer, option.id))));
            return (
              <label key={item.id} className={`gpu-setup${item.id === templateId ? " is-selected" : ""}${unusable ? " is-disabled" : ""}`}>
                <input type="radio" name="setup" value={item.id} checked={item.id === templateId} disabled={unusable || submitting} onChange={() => chooseTemplate(item)} />
                <span className="gpu-setup-name">{item.name}</span>
                <span className="gpu-setup-copy">{unusable ? itemBlocker : item.description}</span>
              </label>
            );
          })}
        </fieldset>

        {template?.models && (
          <label className="gpu-field">
            <span className="gpu-field-label">MODEL</span>
            <select value={model ?? ""} onChange={(event) => setModel(event.target.value)} disabled={submitting}>
              {modelOptions.map((option) => (
                <option key={option.id} value={option.id} disabled={Boolean(setupBlocker(template, offer, option.id))}>
                  {option.label} · {option.minVramGb} GB+
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="gpu-field">
          <span className="gpu-field-label">SSH PUBLIC KEY · OPTIONAL</span>
          <textarea value={sshKey} onChange={(event) => setSshKey(event.target.value)} placeholder="ssh-ed25519 AAAA… you@laptop" rows={2} spellCheck={false} disabled={submitting} />
        </label>

        <div className="gpu-dialog-cost">
          <p>
            {firstBlock !== null && <>The first {settings.blockMinutes} minutes ({money(firstBlock)}) are held from your balance. </>}
            Time is billed per minute, renewed hourly while your balance lasts, and unused time comes back when you stop.
          </p>
          {balanceUsd !== null && (
            <p className="gpu-dialog-balance">
              BALANCE {money(balanceUsd)}{hoursAvailable !== null ? ` · ABOUT ${hoursAvailable >= 10 ? Math.floor(hoursAvailable) : hoursAvailable.toFixed(1)} HOURS ON THIS MACHINE` : ""}
            </p>
          )}
        </div>

        {(error ?? disabledReason) && <p className={`gpu-dialog-error${error ? "" : " is-quiet"}`} role={error ? "alert" : undefined}>{error ?? disabledReason}</p>}

        <footer className="gpu-dialog-actions">
          <button type="button" className="gpu-pill" onClick={onClose} disabled={submitting}>Cancel</button>
          <button type="button" className="gpu-pill is-warm" onClick={() => void submit()} disabled={submitting || Boolean(disabledReason)}>
            {submitting ? "Launching…" : "Launch machine"} <span aria-hidden="true">↗</span>
          </button>
        </footer>
      </div>
    </div>
  );
}
