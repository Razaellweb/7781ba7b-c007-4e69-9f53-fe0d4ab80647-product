import type { GpuOffer, InstanceSpec } from "./vast";

// Curated machine setups a user can launch. Only these images run: arbitrary
// images would let anyone run anything on the platform's provider account.
//
// Every setup runs a small lease script (below) next to the workload. It checks
// in with /api/gpu/instances/{id}/heartbeat every minute, which keeps billing
// moving without a scheduler, and it stops the machine itself if the prepaid
// time runs out while the app is unreachable.

export type GpuTemplateId = "pytorch-jupyter" | "vllm-server";
export type GpuAccess = "jupyter" | "ssh" | "api";

export type GpuModelOption = { id: string; label: string; minVramGb: number };

export type GpuTemplate = {
  id: GpuTemplateId;
  name: string;
  description: string;
  image: string;
  runtype: string;
  useJupyterLab: boolean;
  /** Minimum CUDA version the host driver must support. */
  minCuda: number;
  /** Container ports that must be reachable directly. */
  ports: string[];
  access: GpuAccess[];
  models?: GpuModelOption[];
  defaultModel?: string;
};

// Open-weight, ungated models that vLLM serves without a Hugging Face token.
// minVramGb is per GPU (one GPU serves the model) with room for the KV cache at
// an 8K context.
const VLLM_MODELS: GpuModelOption[] = [
  { id: "Qwen/Qwen2.5-1.5B-Instruct", label: "Qwen2.5 1.5B Instruct", minVramGb: 8 },
  { id: "microsoft/Phi-3.5-mini-instruct", label: "Phi-3.5 mini Instruct", minVramGb: 16 },
  { id: "Qwen/Qwen2.5-7B-Instruct", label: "Qwen2.5 7B Instruct", minVramGb: 24 },
  { id: "Qwen/Qwen2.5-14B-Instruct", label: "Qwen2.5 14B Instruct", minVramGb: 40 },
];

export const GPU_TEMPLATES: ReadonlyArray<GpuTemplate> = [
  {
    id: "pytorch-jupyter",
    name: "PyTorch notebook",
    description: "PyTorch 2.5 with CUDA 12.4. Opens JupyterLab in your browser; SSH works too if you add a key.",
    image: "pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime",
    runtype: "jupyter_direc ssh_direc ssh_proxy",
    useJupyterLab: true,
    minCuda: 12.4,
    ports: ["22/tcp", "8080/tcp"],
    access: ["jupyter", "ssh"],
  },
  {
    id: "vllm-server",
    name: "Model server",
    description: "Serves an open-weight model behind an OpenAI-compatible API, protected by a key only you see.",
    image: "vllm/vllm-openai:v0.6.4.post1",
    runtype: "ssh_direc ssh_proxy",
    useJupyterLab: false,
    minCuda: 12.1,
    ports: ["22/tcp", "8000/tcp"],
    access: ["api", "ssh"],
    models: VLLM_MODELS,
    defaultModel: "Qwen/Qwen2.5-7B-Instruct",
  },
];

export function getTemplate(id: unknown): GpuTemplate | null {
  return GPU_TEMPLATES.find((template) => template.id === id) ?? null;
}

/** Why an offer cannot run a setup (and model), or null when it can. */
export function offerIncompatibility(template: GpuTemplate, offer: GpuOffer, modelId: string | null): string | null {
  if (offer.cudaMaxGood !== null && offer.cudaMaxGood < template.minCuda) return `This machine's driver supports CUDA ${offer.cudaMaxGood}; this setup needs ${template.minCuda} or newer.`;
  if (offer.directPortCount !== null && offer.directPortCount < template.ports.length) return "This machine cannot expose the ports this setup needs.";
  if (template.models) {
    const model = template.models.find((option) => option.id === modelId);
    if (!model) return "Choose one of the listed models.";
    // Reported VRAM sits a little under the marketed size (see vast.ts).
    if (offer.gpuRamGb !== null && offer.gpuRamGb < model.minVramGb * 0.93) return `${model.label} needs a GPU with at least ${model.minVramGb} GB of VRAM.`;
  }
  return null;
}

/** Public, browser-safe description of the setups. */
export function publicTemplates() {
  return GPU_TEMPLATES.map((template) => ({
    id: template.id,
    name: template.name,
    description: template.description,
    minCuda: template.minCuda,
    portsNeeded: template.ports.length,
    access: template.access,
    models: template.models ?? null,
    defaultModel: template.defaultModel ?? null,
  }));
}

// The lease script. Python 3 is present in both images. It keeps a local
// deadline (paid-until plus five minutes of grace) so the machine stops itself
// if heartbeats fail for longer than the prepaid time. Stopping uses the
// per-instance credentials the host injects (CONTAINER_ID / CONTAINER_API_KEY),
// then falls back to ending the container's main process.
const LEASE_SCRIPT = String.raw`import json, os, subprocess, time, urllib.request
URL = os.environ.get("OW_LEASE_URL", "")
TOKEN = os.environ.get("OW_LEASE_TOKEN", "")
GRACE = 300
deadline = time.time() + int(os.environ.get("OW_INITIAL_DEADLINE_SECONDS", "3900"))

def stop():
    cid = os.environ.get("CONTAINER_ID")
    key = os.environ.get("CONTAINER_API_KEY")
    if cid and key:
        try:
            req = urllib.request.Request("https://console.vast.ai/api/v0/instances/%s/" % cid, data=json.dumps({"state": "stopped"}).encode(), method="PUT", headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
            urllib.request.urlopen(req, timeout=30)
        except Exception:
            pass
    subprocess.call(["sh", "-c", "kill -TERM 1"])

while True:
    try:
        req = urllib.request.Request(URL, data=b"{}", method="POST", headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=20) as response:
            data = json.loads(response.read().decode() or "{}")
        if data.get("action") == "stop":
            stop()
            break
        paid = data.get("paidUntilEpoch")
        if isinstance(paid, (int, float)):
            deadline = paid + GRACE
    except Exception:
        pass
    if time.time() > deadline:
        stop()
        break
    time.sleep(60)
`;

function onstartFor(template: GpuTemplate): string {
  const lines = [
    "mkdir -p /root/.openweight",
    // SSH sessions do not inherit the container env; this makes the setup's
    // variables available in a shell, as the host's own docs recommend.
    "env | grep -E '^OW_(MODEL|SERVICE_KEY)=' >> /etc/environment || true",
    "cat > /root/.openweight/lease.py <<'OWLEASE'",
    LEASE_SCRIPT,
    "OWLEASE",
    "nohup python3 /root/.openweight/lease.py > /root/.openweight/lease.log 2>&1 &",
  ];
  if (template.id === "vllm-server") {
    lines.push('nohup python3 -m vllm.entrypoints.openai.api_server --host 0.0.0.0 --port 8000 --model "$OW_MODEL" --api-key "$OW_SERVICE_KEY" --max-model-len 8192 > /root/.openweight/server.log 2>&1 &');
  }
  return lines.join("\n");
}

export function buildInstanceSpec(template: GpuTemplate, options: {
  label: string;
  diskGb: number;
  leaseUrl: string;
  leaseToken: string;
  initialDeadlineSeconds: number;
  model: string | null;
  serviceKey: string | null;
}): InstanceSpec {
  const env: Record<string, string> = {
    OW_LEASE_URL: options.leaseUrl,
    OW_LEASE_TOKEN: options.leaseToken,
    OW_INITIAL_DEADLINE_SECONDS: String(options.initialDeadlineSeconds),
  };
  for (const port of template.ports) {
    const number = port.split("/")[0];
    if (number !== "22" && number !== "8080") env[`-p ${number}:${number}`] = "1";
  }
  if (options.model) env.OW_MODEL = options.model;
  if (options.serviceKey) env.OW_SERVICE_KEY = options.serviceKey;
  return {
    image: template.image,
    env,
    onstart: onstartFor(template),
    runtype: template.runtype,
    diskGb: options.diskGb,
    label: options.label,
    useJupyterLab: template.useJupyterLab,
  };
}
