"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useRouter, useSearchParams } from "next/navigation";

// One curated registry row. `status` is the three-state provider health the
// registry computed (Operational / Degraded / Unavailable), `adminActivated` is an
// operator's own decision, and `selectable` is the exact predicate the server also
// applies — so the dropdown can never offer a model the request path would reject.
type ModelStatus = "operational" | "degraded" | "unavailable";
type Model = {
  id: string;
  displayName: string;
  family: string | null;
  contextLength: number | null;
  status?: ModelStatus;
  availability: "available" | "degraded" | "unavailable" | "stale";
  syncStatus: string;
  registryStatus: string;
  adminActivated?: boolean;
  selectable?: boolean;
  availabilityReason?: string | null;
  supportedParameters: string[] | null;
};
type Message = { role: "user" | "assistant"; content: string; partial?: boolean };
type Conversation = { id: string; title: string | null; updated_at: string; message_count?: number };
type Status = "loading" | "ready" | "streaming" | "stopped" | "failed" | "unavailable";
type Parameters = { systemPrompt: string; temperature: string; topP: string; maxTokens: string; seed: string; stop: string };
type ResolvedModel = { id: string; displayName: string; provider?: string };
/**
 * Normalized server stream events. A provider change never changes this shape.
 *
 * `provider` is the provider that ACTUALLY served the turn and `failedOver` marks a
 * response that came from the configured fallback (the primary reported a provider
 * outage before any content). `retryable` is the normalized taxonomy's decision, so
 * the Retry affordance is correct for both providers without knowing which one ran.
 */
type StreamEvent =
  | { type: "started"; conversationId: string; operationKey: string; model: ResolvedModel; autoSelected: boolean }
  | { type: "delta"; text: string }
  | { type: "complete"; conversationId: string; model: ResolvedModel; balance: string | null; userDebitMicroUsd: string | null; uncertain: boolean; provider?: string; failedOver?: boolean }
  | { type: "cancelled"; conversationId: string; balance: string | null; error: string; provider?: string; failedOver?: boolean }
  | { type: "error"; code: string; error: string; retryable: boolean; modelUnavailable?: boolean; conversationId?: string; balance: string | null; provider?: string; failedOver?: boolean };

/** Sentinel the server resolves to its own best operational model. */
const AUTO = "auto";
/** Human label for a provider id reported by the server. */
const providerLabel = (id: string | undefined) => id === "vast" ? "vast.ai" : id === "openrouter" ? "OpenRouter" : id ?? "the active provider";
const initialParameters: Parameters = { systemPrompt: "", temperature: "", topP: "", maxTokens: "", seed: "", stop: "" };
/** The normalized status, tolerating an API that only reports `availability`. */
const modelStatus = (model: Model | null): ModelStatus => {
  if (!model) return "unavailable";
  if (model.status) return model.status;
  if (model.availability === "available") return "operational";
  if (model.availability === "degraded") return "degraded";
  return "unavailable";
};
const isActivated = (model: Model | null) => model ? (model.adminActivated ?? model.registryStatus === "active") : false;
/**
 * The Playground's selection predicate. It mirrors the server's `selectable` flag:
 * an admin-activated model whose provider route is operational or degraded (a cold
 * rented GPU warms on demand). An admin-paused model, and one whose endpoint is
 * down, is never listed.
 */
const operational = (model: Model | null) => {
  if (!model) return false;
  if (model.selectable != null) return model.selectable;
  return isActivated(model) && model.syncStatus === "current" && modelStatus(model) !== "unavailable";
};
const statusWord = (model: Model | null) => {
  if (!model) return "No model selected";
  if (!isActivated(model)) return "Paused";
  const status = modelStatus(model);
  return status === "operational" ? "Operational" : status === "degraded" ? "Degraded \u00b7 warming" : "Unavailable";
};
const supports = (model: Model | null, parameter: string) => Boolean(model?.supportedParameters?.some((item) => item.toLowerCase() === parameter.toLowerCase()));
const balanceLabel = (value: string) => { try { const micro = BigInt(value || "0"); return `$${micro / 1000000n}.${(micro % 1000000n).toString().padStart(6, "0")}`; } catch { return "Unavailable"; } };
const positiveBalance = (value: string) => { try { return BigInt(value || "0") > 0n; } catch { return false; } };
const timeLabel = (value: string) => { const time = new Date(value).getTime(); if (!Number.isFinite(time)) return ""; const minutes = Math.floor(Math.max(0, Date.now() - time) / 60000); return minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`; };

function PlaygroundContent() {
  const { ready: authReady, authenticated, getAccessToken } = usePrivy();
  const router = useRouter();
  const search = useSearchParams();
  const requestedModel = search.get("model");
  const requestedConversation = search.get("conversation");
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState<Model | null>(null);
  // "Auto" lets the server pick the operational model for each turn. The resolved
  // model is reported back on the stream's `started` event.
  const [autoMode, setAutoMode] = useState(false);
  const [autoResolved, setAutoResolved] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [parameters, setParameters] = useState<Parameters>(initialParameters);
  const [balance, setBalance] = useState("0");
  const [balanceLoaded, setBalanceLoaded] = useState(false);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState("");
  // Set when the server rejected a turn as retryable, so the banner can offer Retry.
  const [retryable, setRetryable] = useState(false);
  // Set when the server reported the normalized `model_unavailable` code.
  const [modelUnavailable, setModelUnavailable] = useState(false);
  // Which provider actually served the last turn, and whether it was a failover.
  // A successful failover shows a quiet note (never an error): the turn is complete.
  const [servedBy, setServedBy] = useState<string | null>(null);
  const [failedOver, setFailedOver] = useState(false);
  // Holder gate. The server is the enforcement point (it rejects billable
  // inference it does not authorize); this mirrors its decision in the UI.
  const [accessAuthorized, setAccessAuthorized] = useState(true);
  const [accessChecked, setAccessChecked] = useState(false);
  const [conversationId, setConversationId] = useState<string>();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [historySearch, setHistorySearch] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [showParameters, setShowParameters] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const operationRef = useRef<string | null>(null);
  const loadIdRef = useRef(0);
  // The last turn, kept so Retry can re-issue exactly the same intent with a fresh
  // operation key (a new reservation, never a second debit for the failed attempt).
  const lastRequestRef = useRef<{ text: string; modelId: string } | null>(null);
  const stopRequestedRef = useRef(false);

  const authHeaders = useCallback(async () => { const token = await getAccessToken(); if (!token) throw new Error("AUTH_REQUIRED"); return { Authorization: `Bearer ${token}` }; }, [getAccessToken]);
  // The dropdown's contents: only models an administrator activated AND the active
  // provider currently serves. A paused model, and one whose endpoint is down, is
  // excluded — which is exactly what the server enforces on the request path.
  const availableModels = useMemo(() => models.filter(operational), [models]);
  // The rest of the registry, so an unavailable selection can be explained rather
  // than silently vanishing from the selector.
  const gatedModels = useMemo(() => models.filter((item) => !operational(item)), [models]);
  // A turn can be sent when there is a usable route: an explicit operational model,
  // or Auto with at least one operational model for the server to choose from.
  const routable = autoMode ? availableModels.length > 0 : operational(model);
  const canSubmit = authenticated && accessAuthorized && balanceLoaded && positiveBalance(balance) && routable && status !== "streaming" && status !== "loading" && Boolean(draft.trim());
  const composerDisabled = !authenticated || !accessAuthorized || status === "streaming";
  const modelLabel = autoMode ? (autoResolved ? `Auto \u00b7 ${autoResolved}` : "Auto") : model?.displayName ?? "Select a curated model";
  const composerPlaceholder = !accessAuthorized
    ? "Verify holder access to enable inference..."
    : status === "streaming"
      ? `Generating with ${modelLabel}...`
      : "Send a message...";
  const capabilities = useMemo(() => ({ temperature: supports(model, "temperature"), topP: supports(model, "top_p") || supports(model, "topP"), maxTokens: supports(model, "max_tokens") || supports(model, "max_completion_tokens"), seed: supports(model, "seed"), stop: supports(model, "stop") }), [model]);
  const filteredHistory = useMemo(() => conversations.filter((item) => (item.title || "New conversation").toLowerCase().includes(historySearch.toLowerCase())), [conversations, historySearch]);

  const refreshHistory = useCallback(async (headers?: HeadersInit) => {
    const response = await fetch("/api/conversations", { headers: headers ?? await authHeaders(), cache: "no-store" });
    if (!response.ok) throw new Error("Conversation history could not be loaded.");
    const data = await response.json() as { conversations?: Conversation[] };
    setConversations(Array.isArray(data.conversations) ? data.conversations : []);
  }, [authHeaders]);

  /** Reloads a conversation's persisted messages, including a server-persisted partial. */
  const openConversation = useCallback(async (id: string, headers?: HeadersInit, updateUrl = true) => {
    const loadId = ++loadIdRef.current;
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { headers: headers ?? await authHeaders(), cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 404 ? "This conversation is unavailable." : "Conversation messages could not be loaded.");
      const data = await response.json() as { messages?: Array<{ role: string; content: string; partial?: boolean }> };
      if (loadId !== loadIdRef.current) return;
      setConversationId(id);
      setMessages((data.messages ?? []).filter((item): item is typeof item & { role: "user" | "assistant" } => item.role === "user" || item.role === "assistant").map((item) => ({ role: item.role, content: item.content, partial: Boolean(item.partial) })));
      if (updateUrl) router.replace(`/chat?${new URLSearchParams({ ...(requestedModel ? { model: requestedModel } : {}), conversation: id })}`);
      setError("");
      if (!updateUrl) setStatus("ready");
    } catch (caught) {
      if (loadId !== loadIdRef.current) return;
      setError(caught instanceof Error ? caught.message : "Conversation messages could not be loaded."); setStatus("failed");
    }
  }, [authHeaders, requestedModel, router]);

  /** Fetches the curated registry (shared by load(), retry and model-unavailable recovery). */
  const fetchModels = useCallback(async (headers?: HeadersInit) => {
    const response = await fetch("/api/models", { headers, cache: "no-store" });
    if (!response.ok) throw new Error("The curated model registry is unavailable.");
    const data = await response.json() as { models?: Model[] };
    const next = Array.isArray(data.models) ? data.models : [];
    setModels(next);
    return next;
  }, []);

  /** Reads the authoritative allowance balance and the server's access decision. */
  const refreshAllowance = useCallback(async (headers?: HeadersInit) => {
    const response = await fetch("/api/allowance", { headers: headers ?? await authHeaders(), cache: "no-store" });
    if (!response.ok) throw new Error(response.status === 401 ? "Your session has expired. Sign in again." : "Compute allowance could not be loaded. Retry to request a fresh balance.");
    const payload = await response.json() as { balance?: { available?: string }; access?: { authorized?: boolean } };
    if (typeof payload.balance?.available !== "string") throw new Error("The allowance service did not return an authoritative balance.");
    setBalance(payload.balance.available);
    setBalanceLoaded(true);
    if (typeof payload.access?.authorized === "boolean") { setAccessAuthorized(payload.access.authorized); setAccessChecked(true); }
    return payload.balance.available;
  }, [authHeaders]);

  const load = useCallback(async () => {
    if (!authenticated) return;
    setStatus("loading"); setError(""); setBalance("0"); setBalanceLoaded(false); setModelUnavailable(false); setRetryable(false); setServedBy(null); setFailedOver(false);
    try {
      const headers = await authHeaders();
      const nextModels = await fetchModels(headers);
      const operationalModels = nextModels.filter(operational);
      if (requestedModel === AUTO) {
        setAutoMode(true);
        setModel(operationalModels[0] ?? null);
        setStatus(operationalModels.length ? "ready" : "unavailable");
        if (!operationalModels.length) setError("No curated models are operational right now. Auto selection cannot route a turn.");
      } else {
        setAutoMode(false);
        const selected = requestedModel ? nextModels.find((item) => item.id === requestedModel) ?? null : operationalModels[0] ?? null;
        setModel(selected);
        if (!selected || !operational(selected)) {
          setStatus("unavailable");
          setError(selected ? selectedMessage(selected) : requestedModel ? "The selected model is no longer in the curated registry." : "No curated models are operational right now.");
        } else setStatus("ready");
      }
      try {
        await refreshAllowance(headers);
      } catch (caught) {
        setStatus("unavailable");
        setError(caught instanceof Error ? caught.message : "Compute allowance could not be loaded.");
      }
      await refreshHistory(headers).catch(() => undefined);
      if (requestedConversation) await openConversation(requestedConversation, headers, false);
    } catch (caught) { setModels([]); setModel(null); setBalanceLoaded(false); setStatus("unavailable"); setError(caught instanceof Error ? caught.message : "The Playground could not load workspace data."); }
  }, [authenticated, authHeaders, fetchModels, openConversation, refreshAllowance, refreshHistory, requestedConversation, requestedModel]);

  useEffect(() => { if (authReady && !authenticated) router.replace("/signup"); }, [authReady, authenticated, router]);
  useEffect(() => { void load(); return () => abortRef.current?.abort(); }, [load]);
  // Keep the selector honest while the tab is open: the registry's availability is
  // debounced server-side, so re-reading it cannot make the dropdown flap, and an
  // admin pause (or a provider transition) removes a model within one interval.
  useEffect(() => {
    if (!authenticated) return;
    const timer = window.setInterval(() => {
      // Never re-filter mid-stream: the in-flight turn keeps the model it started on.
      if (status === "streaming") return;
      void fetchModels().then((next) => {
        const selected = next.find((item) => item.id === model?.id) ?? null;
        if (!selected) return;
        setModel(selected);
        if (!autoMode && !operational(selected)) {
          setStatus("unavailable");
          setError(selectedMessage(selected));
          setModelUnavailable(true);
        }
      }).catch(() => undefined);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [authenticated, autoMode, fetchModels, model?.id, status]);

  const changeModel = (next: Model) => {
    if (!operational(next) || status === "streaming") return;
    setAutoMode(false);
    setModel(next);
    setError("");
    setStatus("ready");
    setModelUnavailable(false);
    setRetryable(false);
    router.replace(`/chat?${new URLSearchParams({ model: next.id, ...(conversationId ? { conversation: conversationId } : {}) })}`);
  };
  const selectAuto = () => {
    if (status === "streaming" || !availableModels.length) return;
    setAutoMode(true);
    setError("");
    setStatus("ready");
    setModelUnavailable(false);
    setRetryable(false);
    router.replace(`/chat?${new URLSearchParams({ model: AUTO, ...(conversationId ? { conversation: conversationId } : {}) })}`);
  };
  const changeParameter = (key: keyof Parameters, value: string) => setParameters((current) => ({ ...current, [key]: value }));
  const newConversation = () => {
    if (status === "streaming") return;
    loadIdRef.current += 1;
    lastRequestRef.current = null;
    setAutoResolved(null);
    setConversationId(undefined); setMessages([]); setDraft(""); setError(""); setModelUnavailable(false); setRetryable(false); setServedBy(null); setFailedOver(false);
    setStatus(routable ? "ready" : "unavailable");
    const target = autoMode ? AUTO : model?.id;
    router.replace(`/chat${target ? `?model=${encodeURIComponent(target)}` : ""}`);
  };

  /**
   * Re-reads the turn from the server after an interrupted stream.
   *
   * The server persists whatever the provider actually delivered before the
   * connection dropped (as a `partial` assistant message) and settles only the
   * tokens received. Re-reading is therefore the reconnect path: it replays the
   * durable partial content instead of re-billing the same tokens client-side.
   */
  const replayPersistedTurn = useCallback(async (id: string) => {
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { headers: await authHeaders(), cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json() as { messages?: Array<{ role: string; content: string; partial?: boolean }> };
      const persisted = (data.messages ?? []).filter((item): item is typeof item & { role: "user" | "assistant" } => item.role === "user" || item.role === "assistant");
      if (persisted.length) setMessages(persisted.map((item) => ({ role: item.role, content: item.content, partial: Boolean(item.partial) })));
    } catch { /* the local partial stays visible; the retry path remains available */ }
  }, [authHeaders]);

  const reconcileAfterInterruption = useCallback(async (id?: string) => {
    // Give the server a moment to run its own settlement for the aborted turn, then
    // read the authoritative balance and the persisted partial content.
    await new Promise((resolve) => setTimeout(resolve, 600));
    await refreshAllowance().catch(() => undefined);
    if (id) await replayPersistedTurn(id);
  }, [refreshAllowance, replayPersistedTurn]);

  const stop = async () => {
    const operationKey = operationRef.current;
    stopRequestedRef.current = true;
    abortRef.current?.abort();
    setStatus("stopped");
    setError("Generation stopped. The visible response is partial and was not marked complete.");
    if (operationKey) {
      try {
        const headers = await authHeaders();
        await fetch("/api/inference/stop", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ operationKey }) });
      } catch { /* client cancellation remains active; server accounting handles received usage */ }
    }
    await reconcileAfterInterruption(conversationId);
  };

  const submit = async (event?: FormEvent<HTMLFormElement>, retry?: { text: string; modelId: string }) => {
    event?.preventDefault();
    if (status === "streaming") return;
    const text = (retry?.text ?? draft).trim();
    // Empty prompts are blocked here; the server independently rejects them.
    if (!text) return;
    if (!accessAuthorized) { setStatus("unavailable"); setError("Holder access has not been confirmed. Check access before inference."); return; }

    // Which route this turn targets: an explicit curated model, or Auto.
    const target = retry?.modelId ?? (autoMode ? AUTO : model?.id ?? "");
    const isAuto = target === AUTO;
    const requestModel = isAuto ? null : retry ? models.find((item) => item.id === target) ?? null : model;
    if (isAuto ? availableModels.length === 0 : !requestModel || !operational(requestModel)) {
      setStatus("unavailable");
      setError(requestModel && !isAuto ? selectedMessage(requestModel) : "The selected model is unavailable. Choose an operational model.");
      return;
    }
    if (!balanceLoaded || !positiveBalance(balance)) { setStatus("unavailable"); setError("No compute allowance is available. Refresh the allowance to continue."); return; }

    // A retry is a brand-new operation: fresh operation key (so it is never treated
    // as a duplicate of the failed attempt), fresh reservation. The failed attempt's
    // reservation was released by the server, so nothing is debited twice.
    const requestId = crypto.randomUUID();
    const controller = new AbortController();
    abortRef.current = controller;
    operationRef.current = requestId;
    stopRequestedRef.current = false;
    lastRequestRef.current = { text, modelId: target };
    setDraft(""); setError(""); setRetryable(false); setModelUnavailable(false); setStatus("streaming"); setServedBy(null); setFailedOver(false);
    setMessages((current) => {
      const next = [...current];
      // Replace a trailing assistant turn (the failed attempt) instead of stacking.
      if (retry && next.at(-1)?.role === "assistant") next.pop();
      if (!next.length || next.at(-1)?.role !== "user" || next.at(-1)?.content !== text) next.push({ role: "user", content: text });
      next.push({ role: "assistant", content: "", partial: true });
      return next;
    });

    let terminal = false;
    let activeConversation = conversationId;
    const appendDelta = (textDelta: string) => setMessages((current) => current.map((item, index) => index === current.length - 1 ? { ...item, content: item.content + textDelta } : item));
    const markPartial = (partial: boolean) => setMessages((current) => current.map((item, index) => index === current.length - 1 ? { ...item, partial } : item));
    const applyBalance = (value: string | null | undefined) => { if (typeof value === "string") { setBalance(value); setBalanceLoaded(true); } };
    const applyProvider = (provider: string | undefined, failed: boolean | undefined) => { if (provider) setServedBy(provider); if (failed) setFailedOver(true); };
    const conversationUrl = (id: string) => `/chat?${new URLSearchParams({ model: target, conversation: id })}`;

    try {
      const headers = await authHeaders();
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          conversationId,
          message: text,
          // Auto is resolved server-side against the live registry and provider health.
          model: target,
          operationKey: requestId,
          clientRequestId: requestId,
          parameters: {
            systemPrompt: parameters.systemPrompt || undefined,
            temperature: parameters.temperature === "" ? undefined : Number(parameters.temperature),
            topP: parameters.topP === "" ? undefined : Number(parameters.topP),
            maxTokens: parameters.maxTokens === "" ? undefined : Number(parameters.maxTokens),
            seed: parameters.seed === "" ? undefined : Number(parameters.seed),
            stop: parameters.stop ? parameters.stop.split(String.fromCharCode(10)) : undefined,
          },
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string; code?: string; retryable?: boolean; modelUnavailable?: boolean; conversationId?: string; provider?: string };
        const message = body.error || "The Playground request was rejected.";
        if (body.provider) setServedBy(body.provider);
        if (response.status === 402 || body.code === "INSUFFICIENT_COMPUTE" || body.code === "ALLOWANCE_MISSING" || body.code === "ALLOWANCE_EXPIRED") {
          setBalance("0"); setBalanceLoaded(false); setStatus("unavailable"); setError(message); return;
        }
        if (body.code === "ACCESS_REQUIRED") { setAccessAuthorized(false); setAccessChecked(true); setStatus("unavailable"); setError(message); return; }
        if (body.code === "MODEL_UNAVAILABLE") {
          // Surface the switch-model affordance and refresh availability so the
          // selector reflects what the server will actually accept.
          setModelUnavailable(true);
          setStatus("unavailable"); setError(message);
          try {
            const next = await fetchModels(headers);
            if (isAuto) setAutoResolved(null);
            else { const current = next.find((item) => item.id === target) ?? null; if (current) setModel(current); }
          } catch { /* keep the last known registry */ }
          return;
        }
        if (response.status === 401) { setStatus("failed"); setError(message); return; }
        // Anything else is retryable from the client's point of view; the operation
        // key is new on retry, so no duplicate reservation can exist.
        setRetryable(Boolean(body.retryable) || response.status >= 500);
        setStatus("failed"); setError(message);
        return;
      }

      if (!response.body) { setStatus("failed"); setRetryable(true); setError("The response stream was unavailable; completion was not confirmed."); return; }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const processEvent = (event: string) => {
        const line = event.split(String.fromCharCode(10)).find((item) => item.startsWith("data: "));
        if (!line) return;
        let payload: StreamEvent;
        try { payload = JSON.parse(line.slice(6)) as StreamEvent; } catch { return; }

        if (payload.type === "started") {
          activeConversation = payload.conversationId;
          setConversationId(payload.conversationId);
          // Show the model the server actually routed to (Auto resolves server-side),
          // so the transcript is never attributed to the wrong model.
          setAutoResolved(payload.model.displayName);
          if (!isAuto) {
            setModel((current) => current?.id === payload.model.id ? current : models.find((item) => item.id === payload.model.id) ?? current);
          }
          router.replace(conversationUrl(payload.conversationId));
          return;
        }
        if (payload.type === "delta") { appendDelta(payload.text); return; }
        if (payload.type === "complete") {
          terminal = true;
          const id = payload.conversationId;
          activeConversation = id;
          setConversationId(id);
          // A turn served by the configured fallback is a success: it shows the quiet
          // failover note, never an error, and its cost was recorded against the
          // provider that actually served it.
          applyProvider(payload.provider, payload.failedOver);
          markPartial(false);
          applyBalance(payload.balance);
          setStatus("ready");
          setError(payload.uncertain ? "This turn completed with estimated usage; the balance may be reconciled later." : "");
          setRetryable(false);
          setModelUnavailable(false);
          router.replace(conversationUrl(id));
          return;
        }
        if (payload.type === "cancelled") {
          terminal = true;
          applyProvider(payload.provider, payload.failedOver);
          applyBalance(payload.balance);
          setStatus("stopped");
          setError(payload.error || "Generation stopped. The visible response is partial.");
          setRetryable(true);
          return;
        }
        // type === "error": normalized code from the provider contract.
        terminal = true;
        applyProvider(payload.provider, payload.failedOver);
        applyBalance(payload.balance);
        if (payload.conversationId) { activeConversation = payload.conversationId; setConversationId(payload.conversationId); }
        if (payload.code === "model_unavailable") {
          setModelUnavailable(true);
          setStatus("unavailable");
          // The normalized taxonomy marks model_unavailable retryable: a cold machine
          // can warm, so the Retry affordance stays available alongside switch-model.
          setError(payload.error || "This model is not available right now. Choose another model or retry.");
          setRetryable(payload.retryable);
          return;
        }
        if (payload.code === "cancelled") { setStatus("stopped"); setError(payload.error || "Generation stopped."); setRetryable(true); return; }
        setStatus("failed");
        setRetryable(payload.retryable);
        setError(payload.error || "Inference failed before completion.");
      };

      const eventDelimiter = String.fromCharCode(10, 10);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split(eventDelimiter);
          buffer = events.pop() ?? "";
          for (const item of events) processEvent(item);
        }
        buffer += decoder.decode();
        if (buffer.trim()) processEvent(buffer);
      } catch (streamError) {
        // A dropped connection is not a failed turn: the server has already
        // persisted whatever arrived. Reconcile from the server instead of guessing.
        if (controller.signal.aborted && !stopRequestedRef.current) {
          setStatus("stopped");
          setError("The connection closed. Showing the content the server persisted.");
          await reconcileAfterInterruption(activeConversation);
          return;
        }
        throw streamError;
      }

      if (!terminal) {
        // The stream ended without a terminal event (network drop / proxy timeout).
        setStatus("stopped");
        setRetryable(true);
        setError("The response stream ended before completion. Showing the content the server persisted.");
        await reconcileAfterInterruption(activeConversation);
        return;
      }
      void refreshHistory().catch(() => undefined);
    } catch (caught) {
      if (controller.signal.aborted && !stopRequestedRef.current) {
        setStatus("stopped");
        setError("The connection closed. Showing the content the server persisted.");
        await reconcileAfterInterruption(activeConversation);
      } else if (controller.signal.aborted) {
        setStatus("stopped");
        setError("Generation stopped. The visible response is partial.");
      } else {
        setStatus("failed");
        setRetryable(true);
        setError(caught instanceof Error ? caught.message : "The Playground request failed.");
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (operationRef.current === requestId) operationRef.current = null;
      stopRequestedRef.current = false;
    }
  };

  const retryLastTurn = () => {
    const last = lastRequestRef.current;
    if (!last || status === "streaming") return;
    void submit(undefined, last);
  };

  if (!authReady || !authenticated) return <main className="playground-gate">Verifying your session...</main>;
  const zeroCompute = balanceLoaded && !positiveBalance(balance);
  const lastUser = [...messages].reverse().find((message) => message.role === "user")?.content;
  const routeLabel = autoMode ? (autoResolved ?? "Auto") : model?.displayName ?? "the selected model";
  const statusCopy = !accessAuthorized
    ? "Holder access has not been confirmed. Check access before inference."
    : status === "loading" ? "Loading your curated registry and workspace data..." : status === "unavailable" || status === "failed" || status === "stopped" ? error : status === "streaming" ? `Generating with ${routeLabel}...` : !routable ? error || "Choose an available curated model to begin." : zeroCompute ? "No compute allowance is available. Refresh the allowance to continue." : "";
  const statusTone = status === "failed" || status === "unavailable" || zeroCompute || !routable || !accessAuthorized ? "error" : status === "stopped" ? "stopped" : status === "streaming" ? "streaming" : "";
  // Retry is offered whenever the server called the failure retryable (both providers
  // share the normalized taxonomy) or the turn was stopped, and the client still has
  // a usable route and balance to re-issue it with a fresh operation key.
  const canRetry = (retryable || status === "stopped") && Boolean(lastRequestRef.current) && accessAuthorized && balanceLoaded && positiveBalance(balance) && status !== "streaming";
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (canSubmit) void submit(); } };
  const selectorValue = autoMode ? AUTO : model?.id ?? "";

  return <main className="playground-shell"><header className="playground-topbar"><button className="playground-back" onClick={() => router.push("/dashboard")}><span aria-hidden="true">\u2190</span> Overview</button><span className="topbar-current">PLAYGROUND</span><div className="topbar-status"><span className={`playground-balance ${zeroCompute ? "zero" : ""}`}>{balanceLoaded ? balanceLabel(balance) : "\u2014"}<small>available compute</small></span></div></header>
    <section className={`playground-layout ${showParameters ? "with-parameters" : ""}`}><div className="playground-main"><div className="playground-heading"><div><span className="playground-kicker">WORKSPACE / COMPUTE LAYER</span><h1>Playground<span>.</span></h1></div><button className="parameter-toggle" onClick={() => setShowParameters((current) => !current)} aria-expanded={showParameters} aria-controls="playground-parameters">Parameters <span aria-hidden="true">{showParameters ? "\u2212" : "+"}</span></button></div>
      <div className="playground-controls"><div className="playground-model-row"><label htmlFor="curated-model"><span className="playground-kicker">CURATED MODEL</span><select id="curated-model" value={selectorValue} onChange={(event) => { if (event.target.value === AUTO) { selectAuto(); return; } const next = availableModels.find((item) => item.id === event.target.value); if (next) changeModel(next); }} disabled={status === "streaming" || availableModels.length === 0}><option value={AUTO} disabled={!availableModels.length}>Auto \u00b7 server-selected</option>{!autoMode && model && !operational(model) && <option value={model.id} disabled>{model.displayName} \u00b7 {statusWord(model).toLowerCase()}</option>}{availableModels.map((item) => <option value={item.id} key={item.id}>{item.displayName}{modelStatus(item) === "degraded" ? " \u00b7 warming" : ""}</option>)}</select></label><span className={`model-status ${routable ? "operational" : "unavailable"}`}><i />{autoMode ? (availableModels.length ? "Auto \u00b7 operational models available" : "No operational models") : statusWord(model)}</span><span className="selected-model-name">{autoMode ? (autoResolved ? `Routed to ${autoResolved}` : "The server picks an operational model per turn") : model ? `${model.displayName}${model.contextLength ? ` \u00b7 ${model.contextLength.toLocaleString()} context` : ""}` : "No operational curated models"}</span></div></div>
      <div className="conversation-toolbar"><div><span className="playground-kicker">YOUR CONVERSATION</span><span className="conversation-model">{modelLabel}</span></div><div className="conversation-actions"><button type="button" className="history-toggle" aria-expanded={showHistory} onClick={() => setShowHistory((current) => !current)}>History{conversations.length ? <span>{conversations.length}</span> : null}</button><button type="button" className="new-conversation" onClick={newConversation} disabled={status === "streaming"}>+ New chat</button></div></div>
      {showHistory && <section className="history-panel" aria-label="Conversation history"><div className="history-search-wrap"><input type="search" value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} placeholder="Search conversations..." aria-label="Search conversations" /><button type="button" onClick={() => void refreshHistory().catch((caught) => setError(caught instanceof Error ? caught.message : "History could not be refreshed."))}>Refresh</button></div>{filteredHistory.length ? <div className="history-list">{filteredHistory.map((item) => <button type="button" key={item.id} className={conversationId === item.id ? "active" : ""} onClick={() => void openConversation(item.id)}><span>{item.title || "New conversation"}</span><small>{timeLabel(item.updated_at)}{item.message_count != null ? ` \u00b7 ${item.message_count} messages` : ""}</small></button>)}</div> : <p className="history-empty">{conversations.length ? "No conversations match that search." : "Your conversations will appear here."}</p>}</section>}
      <div className="playground-messages" aria-live="polite">{messages.length === 0 ? <div className="playground-empty"><div className="empty-mark" aria-hidden="true">\u2726</div><span className="empty-overline">A QUIET SPACE FOR GOOD QUESTIONS</span><h2>What would you like to work through?</h2><p>Choose a curated model and send a prompt. Responses stream into your conversation history.</p></div> : messages.map((message, index) => <article className={`playground-message ${message.role} ${message.partial ? "partial" : ""}`} key={`${index}-${message.role}`}><span>{message.role === "user" ? "YOU" : (autoMode ? autoResolved ?? "ASSISTANT" : model?.displayName)?.toUpperCase() || "ASSISTANT"}</span><p>{message.content || (message.partial ? "Waiting for the first response..." : "")}</p>{message.partial && <span className="stream-indicator"><i />{status === "streaming" ? "STREAMING" : "PARTIAL \u00b7 NOT COMPLETE"}</span>}</article>)}</div>
      {statusCopy && <div className={`playground-state ${statusTone}`} role="status"><span className="state-indicator" />{statusCopy}<span className="state-actions">{!accessAuthorized && <button type="button" onClick={() => router.push("/dashboard")}>Check access \u2197</button>}{canRetry && <button type="button" onClick={retryLastTurn}>Retry last prompt</button>}{zeroCompute && <button type="button" onClick={() => void refreshAllowance().then(() => setStatus(routable ? "ready" : "unavailable")).catch((caught) => setError(caught instanceof Error ? caught.message : "Compute allowance could not be loaded."))}>Refresh allowance \u21bb</button>}{!lastRequestRef.current && status === "failed" && lastUser && accessAuthorized && balanceLoaded && positiveBalance(balance) && routable && <button type="button" onClick={() => void submit(undefined, { text: lastUser, modelId: autoMode ? AUTO : model?.id ?? "" })}>Retry last prompt</button>}</span></div>}
      {failedOver && status !== "streaming" && <p className="playground-gated-note" aria-live="polite">Served by {providerLabel(servedBy ?? undefined)} — the preferred provider was unavailable. This turn completed normally.</p>}
      {modelUnavailable && <div className="playground-model-switch" role="group" aria-label="Switch to an available model">{availableModels.length ? <><span>Switch model</span>{availableModels.slice(0, 4).map((item) => <button type="button" key={item.id} onClick={() => changeModel(item)}>{item.displayName}</button>)}</> : <span>No curated model is operational right now. Retry shortly.</span>}</div>}
      {gatedModels.length > 0 && availableModels.length > 0 && <p className="playground-gated-note" aria-live="polite">{gatedModels.length} curated {gatedModels.length === 1 ? "model is" : "models are"} not selectable right now ({gatedModels.map((item) => statusWord(item).toLowerCase()).filter((value, index, all) => all.indexOf(value) === index).join(", ")}).</p>}
      <form className="playground-composer" onSubmit={(event) => void submit(event)}><textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={composerPlaceholder} aria-label="Prompt" disabled={composerDisabled} onKeyDown={onKeyDown} /><div className="composer-footer"><span>Enter to send <b>\u00b7</b> Shift + Enter for a new line</span>{status === "streaming" ? <button className="stop-button" type="button" onClick={() => void stop()}>Stop generation <span aria-hidden="true">\u25a0</span></button> : <button type="submit" disabled={!canSubmit}>Send <span aria-hidden="true">\u2197</span></button>}</div></form><p className="playground-footnote">{accessChecked && !accessAuthorized ? "Holder access must be confirmed before any billable inference is accepted." : "Compute is reserved and settled by the server from actual provider usage."}</p>
    </div>{showParameters && <aside className="playground-parameters" id="playground-parameters"><div className="parameters-heading"><div><span className="playground-kicker">SESSION CONTROLS</span><h2>Parameters</h2><p>Only settings supported by this model are sent.</p></div><button type="button" className="parameters-close" onClick={() => setShowParameters(false)} aria-label="Close parameters">\u00d7</button></div><label>System prompt<textarea value={parameters.systemPrompt} onChange={(event) => changeParameter("systemPrompt", event.target.value)} placeholder="Optional. Sets assistant behavior." /></label><ParameterRange label="Temperature" value={parameters.temperature} onChange={(value) => changeParameter("temperature", value)} min="0" max="2" step="0.1" enabled={capabilities.temperature} /><ParameterRange label="Top P" value={parameters.topP} onChange={(value) => changeParameter("topP", value)} min="0" max="1" step="0.05" enabled={capabilities.topP} /><ParameterRange label="Max tokens" value={parameters.maxTokens} onChange={(value) => changeParameter("maxTokens", value)} min="1" max="32768" step="1" enabled={capabilities.maxTokens} /><label>Seed <input inputMode="numeric" value={parameters.seed} onChange={(event) => changeParameter("seed", event.target.value)} placeholder={capabilities.seed ? "Random" : "Not supported by this model"} disabled={!capabilities.seed} /></label><label>Stop sequences<textarea value={parameters.stop} onChange={(event) => changeParameter("stop", event.target.value)} placeholder={capabilities.stop ? "One per line" : "Not supported by this model"} disabled={!capabilities.stop} /></label><button type="button" className="parameters-reset" onClick={() => setParameters(initialParameters)}>\u21b6 Reset parameters</button></aside>}</section>
    <style>{`.playground-shell{height:100%;min-height:0;background:#090a0a;color:#e8eef6;font-family:var(--font-geist-sans),Arial,sans-serif}.playground-topbar{min-height:52px;flex:0 0 auto;display:flex;align-items:center;gap:22px;padding:8px clamp(16px,3vw,42px);border-bottom:1px solid #292c2b;background:#0b0c0c;font:10px var(--font-geist-mono),monospace;letter-spacing:.08em}.playground-back{display:inline-flex;gap:9px;align-items:center;border:0;background:none;color:#bac8d7;font:inherit;cursor:pointer}.topbar-current,.playground-kicker,.empty-overline{color:#91a1b2;font:9px var(--font-geist-mono),monospace;letter-spacing:.12em}.topbar-status{display:flex;align-items:center;gap:18px;margin-left:auto}.state-indicator,.model-status i{width:7px;height:7px;border-radius:50%;background:currentColor}.playground-balance{display:flex;gap:7px;align-items:baseline;color:#91d8aa;font:12px var(--font-geist-mono),monospace}.playground-balance small{color:#aab8c8;font-size:9px}.playground-balance.zero{color:#f2c27f}.playground-layout{width:min(100%,1600px);height:100%;min-height:0;margin:auto;padding:18px clamp(18px,3vw,48px) 16px;overflow:hidden}.playground-layout.with-parameters{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,310px);gap:22px}.playground-main{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden}.playground-heading{display:flex;flex:0 0 auto;align-items:center;justify-content:space-between;gap:16px;padding-bottom:13px}.playground-heading h1{margin:7px 0 0;font-size:clamp(34px,4vw,52px);font-weight:400;letter-spacing:-.07em;line-height:1}.playground-heading h1 span{color:#c58a70}.parameter-toggle,.history-toggle,.new-conversation{border:1px solid #3a4d63;border-radius:99px;background:#152131;color:#d8e5f2;padding:8px 12px;font-size:10px;cursor:pointer}.playground-controls,.conversation-toolbar,.playground-state,.playground-composer,.playground-footnote,.playground-gated-note{flex:0 0 auto}.playground-controls{border-top:1px solid #303232}.playground-model-row{display:grid;grid-template-columns:minmax(180px,360px) auto minmax(0,1fr);align-items:end;gap:13px;padding:10px 0 12px;border-bottom:1px solid #303232}.playground-model-row label{display:flex;flex-direction:column;gap:7px;min-width:0;color:#afbdcc}.playground-model-row select{width:100%;min-width:0;border:1px solid #4b4e4d;border-radius:7px;background:#141515;color:#edf4fb;padding:9px 12px;font-size:12px}.model-status{display:flex;align-items:center;gap:7px;padding-bottom:10px;color:#f2c27f;font:9px var(--font-geist-mono),monospace}.model-status.operational{color:#91d8aa}.selected-model-name{justify-self:end;max-width:100%;padding-bottom:10px;color:#aab8c8;font:9px var(--font-geist-mono),monospace;text-align:right;overflow-wrap:anywhere}.playground-gated-note{margin:0 0 8px;color:#8c99a8;font:8px var(--font-geist-mono),monospace}.conversation-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:11px}.conversation-toolbar>div:first-child{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.conversation-model{font-size:11px;color:#e5edf6}.conversation-actions{display:flex;gap:7px}.history-toggle,.new-conversation{padding:7px 10px;font:9px var(--font-geist-mono),monospace}.new-conversation{background:#ad7057;border-color:#bd8165;color:white}.new-conversation:disabled{opacity:.5;cursor:not-allowed}.history-toggle span{margin-left:6px}.history-panel{flex:0 0 auto;margin-top:8px;padding:9px;border:1px solid #303232;background:#141515;border-radius:8px}.history-search-wrap{display:flex;gap:7px}.history-search-wrap input{flex:1;min-width:0;border:1px solid #4b4e4d;border-radius:6px;background:#0b0c0c;color:#edf4fb;padding:8px}.history-search-wrap button{border:1px solid #4b4e4d;border-radius:6px;background:#1c1d1d;color:#d8e5f2;padding:0 10px}.history-list{max-height:160px;overflow:auto}.history-list button{display:flex;width:100%;justify-content:space-between;gap:8px;border:0;border-radius:5px;background:none;color:#dce6f0;padding:8px;text-align:left}.history-list button:hover,.history-list button.active{background:#252727}.history-list button span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.history-list small,.history-empty{color:#9eacbd;font-size:9px}.playground-messages{flex:1 1 0;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:13px 8px 10px}.playground-empty{max-width:600px;margin:auto;padding:15px;text-align:center}.empty-mark{display:grid;place-items:center;width:42px;height:42px;margin:0 auto 12px;border-radius:13px;background:#211915;color:#e39a7a;font-size:20px}.playground-empty h2{margin:9px 0 6px;font-size:clamp(20px,2.4vw,25px);font-weight:400;letter-spacing:-.04em}.playground-empty p{margin:0 auto;color:#aab8c8;font-size:12px;line-height:1.5}.playground-message{max-width:900px;margin:0 auto 10px;padding:13px 15px;border:1px solid #303232;border-radius:8px;background:#141515;overflow-wrap:anywhere}.playground-message.user{border-color:#41352f;background:#1a1715}.playground-message>span:first-child{color:#c59b83;font:9px var(--font-geist-mono),monospace;letter-spacing:.1em}.playground-message p{margin:7px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.65;font-size:13px}.playground-message.partial{border-style:dashed}.stream-indicator{display:flex;align-items:center;gap:7px;margin-top:9px;color:#9bd7fa;font:9px var(--font-geist-mono),monospace}.playground-state{display:flex;align-items:center;gap:8px;margin:0 0 8px;color:#b1becc;font-size:10px;line-height:1.4}.playground-state.streaming{color:#91d8aa}.playground-state.error{color:#f0b3a3}.playground-state.stopped{color:#f2c27f}.playground-state .state-actions{display:flex;gap:6px;margin-left:auto;flex:0 0 auto}.playground-state .state-actions button{margin-left:0;border:1px solid #735d3f;border-radius:99px;background:#292315;color:#f4d39c;padding:6px 9px;font:inherit;cursor:pointer}.playground-model-switch{display:flex;flex-wrap:wrap;align-items:center;gap:7px;flex:0 0 auto;margin:0 0 8px;color:#aab8c8;font:9px var(--font-geist-mono),monospace}.playground-model-switch button{border:1px solid #3a4d63;border-radius:99px;background:#152131;color:#d8e5f2;padding:6px 9px;font:inherit;cursor:pointer}.playground-composer{max-width:960px;width:100%;margin:0 auto;border:1px solid #4b4e4d;border-radius:9px;background:#141515;overflow:hidden}.playground-composer:focus-within{border-color:#9a785f}.playground-composer textarea{display:block;box-sizing:border-box;width:100%;min-height:72px;max-height:24dvh;resize:vertical;border:0;outline:0;background:transparent;color:#edf4fb;padding:12px 15px;font:13px/1.5 var(--font-geist-sans),Arial,sans-serif}.playground-composer textarea::placeholder{color:#91a2b5}.playground-composer textarea:disabled{opacity:.6;cursor:not-allowed}.composer-footer{display:flex;align-items:center;gap:10px;min-height:42px;padding:6px 9px 6px 14px;border-top:1px solid #303232;color:#aab8c8;font:8px var(--font-geist-mono),monospace}.composer-footer b{padding:0 3px;color:#8294a8;font-weight:400}.composer-footer button{display:flex;align-items:center;gap:8px;margin-left:auto;border:1px solid #bd8165;border-radius:6px;background:#ad7057;color:#fff7f2;padding:8px 12px;font:9px var(--font-geist-mono),monospace;cursor:pointer}.composer-footer button:disabled{opacity:.45;cursor:not-allowed}.composer-footer button.stop-button{border-color:#625043;background:#29221e;color:#ead4c5}.playground-footnote{max-width:960px;margin:6px auto 0;color:#91a1b2;font:8px var(--font-geist-mono),monospace}.playground-parameters{position:sticky;top:12px;max-height:100%;overflow:auto;padding:18px;border:1px solid #303232;border-radius:9px;background:#141515}.parameters-heading{display:flex;justify-content:space-between;gap:10px;border-bottom:1px solid #303232;padding-bottom:13px}.parameters-heading h2{margin:9px 0 4px;font-size:22px;font-weight:400}.parameters-heading p{margin:0;color:#aab8c8;font-size:10px}.parameters-close{width:30px;height:30px;border:1px solid #4b4e4d;border-radius:6px;background:#1c1d1d;color:#eff6fd;font-size:18px}.playground-parameters label{display:block;margin:17px 0;color:#e5edf6;font-size:11px}.playground-parameters label>span{float:right;color:#aab8c8;font-size:9px}.playground-parameters textarea,.playground-parameters input:not([type=range]){display:block;box-sizing:border-box;width:100%;margin-top:7px;border:1px solid #4b4e4d;border-radius:6px;background:#0b0c0c;color:#edf4fb;padding:9px;font:11px/1.5 Arial,sans-serif}.playground-parameters textarea{min-height:60px;resize:vertical}.playground-parameters input[type=range]{display:block;width:100%;margin-top:11px;accent-color:#ad7057}.playground-parameters input:disabled,.playground-parameters textarea:disabled{opacity:.5}.parameters-reset{width:100%;border:0;border-top:1px solid #303232;background:none;color:#b3c0cf;text-align:left;padding:13px 0 0}.playground-gate{min-height:100vh;display:grid;place-items:center;background:#090a0a;color:#b0bdcc;font:11px var(--font-geist-mono),monospace}.playground-shell :is(button,input,select,textarea):focus-visible{outline:2px solid #d3a27f;outline-offset:3px}@media(max-width:700px){.playground-topbar{min-height:42px;padding:6px 12px;gap:12px}.topbar-status{gap:8px}.playground-balance{font-size:10px}.playground-balance small{font-size:8px}.playground-layout,.playground-layout.with-parameters{display:flex;flex-direction:column;gap:8px;padding:10px 12px max(8px,env(safe-area-inset-bottom))}.playground-heading{padding-bottom:7px}.playground-heading h1{font-size:clamp(29px,8vw,40px);margin-top:5px}.playground-kicker,.empty-overline{font-size:8px}.parameter-toggle{padding:7px 9px;font-size:9px}.playground-model-row{grid-template-columns:minmax(0,1fr) auto;gap:7px 10px;padding:7px 0}.playground-model-row label{gap:5px}.playground-model-row select{padding:7px 9px;font-size:11px}.model-status{align-self:end;padding-bottom:8px;font-size:8px}.selected-model-name{grid-column:1/-1;justify-self:start;padding:0;font-size:8px}.conversation-toolbar{padding-top:6px}.conversation-toolbar>div:first-child{gap:5px}.conversation-model{font-size:10px}.conversation-actions{gap:4px}.history-toggle,.new-conversation{padding:6px 7px;font-size:8px}.playground-messages{flex:1 1 0;min-height:30px;padding:6px 2px}.playground-empty{padding:6px 3px}.empty-mark{width:32px;height:32px;margin-bottom:6px;font-size:15px}.empty-overline{font-size:7px}.playground-empty h2{margin:5px 0 3px;font-size:16px}.playground-empty p{font-size:9px;line-height:1.4}.playground-message{padding:9px 10px}.playground-message p{font-size:11px}.playground-state{max-height:45px;overflow:auto;font-size:8px;margin:0}.playground-composer textarea{min-height:52px;max-height:16dvh;padding:9px 10px;font-size:11px}.composer-footer{min-height:35px;padding:4px 6px 4px 8px}.composer-footer>span{max-width:65%;font-size:7px}.composer-footer button{padding:6px 8px;font-size:8px}.playground-footnote{display:none}.playground-parameters{position:fixed;z-index:8;inset:10px 10px max(10px,env(safe-area-inset-bottom));width:auto;max-height:none;box-shadow:0 18px 60px #0008}}@media(max-height:620px)and(min-width:701px){.playground-layout,.playground-layout.with-parameters{padding-top:7px;padding-bottom:7px}.playground-heading{padding-bottom:6px}.playground-heading h1{font-size:32px}.playground-model-row{padding-block:5px}.playground-composer textarea{min-height:48px}.playground-footnote{display:none}}@media(prefers-reduced-motion:reduce){.playground-shell *{scroll-behavior:auto}}`}</style>
  </main>;
}

/** Human-readable reason a curated model cannot be offered in the selector. */
function selectedMessage(model: Model): string {
  if (!isActivated(model)) return `${model.displayName} has been paused by an administrator. Choose another model.`;
  if (modelStatus(model) === "unavailable") return `${model.displayName} is unavailable on the active provider right now. Choose another model or retry.`;
  return `${model.displayName} is not available right now. Choose another model or retry.`;
}

function ParameterRange({ label, value, onChange, min, max, step, enabled }: { label: string; value: string; onChange: (value: string) => void; min: string; max: string; step: string; enabled: boolean }) { return <label className={!enabled ? "parameter-disabled" : ""}>{label}<span>{enabled ? value || "Model default" : "Not supported"}</span><input type="range" min={min} max={max} step={step} value={value || min} onChange={(event) => onChange(event.target.value)} disabled={!enabled} /></label>; }

export default function PlaygroundPage() { return <Suspense fallback={<main className="playground-gate">Loading Playground...</main>}><PlaygroundContent /></Suspense>; }
