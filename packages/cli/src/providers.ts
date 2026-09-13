import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AGENT_ADAPTERS, reasoningPreferenceKey, validateProvider, type ApiConnection, type ModelEntry, type ProviderProfile } from "@agent-router/core";

/** Config and secrets have separate files; only the masked presence of a key leaves this class. */
export class ProviderStore {
  private profiles: ProviderProfile[] = [];
  private keys: Record<string, string> = {};
  private selected?: string;
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const name of ["providers.json", "credentials.json", "selection.json"]) {
      const path = join(dir, name);
      if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`${name} 不能是符号链接`);
    }
    if (existsSync(join(dir, "providers.json"))) {
      const data = JSON.parse(readFileSync(join(dir, "providers.json"), "utf8"));
      if (!Array.isArray(data.providers)) throw new Error("providers.json 格式无效");
      this.profiles = data.providers;
      for (const profile of this.profiles) validateProvider(profile);
    }
    if (existsSync(join(dir, "credentials.json"))) {
      chmodSync(join(dir, "credentials.json"), 0o600);
      this.keys = JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8"));
    }
    try {
      const value = JSON.parse(readFileSync(join(dir, "selection.json"), "utf8"));
      if (typeof value.model === "string") this.selected = value.model;
    } catch { /* Missing or obsolete preference: let the user choose a connection. */ }
  }
  list(): ProviderProfile[] { return structuredClone(this.profiles); }
  hasKey(id: string): boolean { return typeof this.keys[id] === "string" && !!this.keys[id]; }
  rememberModel(entry: ModelEntry): void {
    const model = reasoningPreferenceKey(entry);
    this.write("selection.json", { model });
    this.selected = model;
  }
  preferredModel(entries: ModelEntry[]): ModelEntry | undefined {
    return entries.find(entry => reasoningPreferenceKey(entry) === this.selected);
  }
  save(profile: ProviderProfile, apiKey?: string): void {
    validateProvider(profile);
    if (this.profiles.some(item => item.name === profile.name && item.id !== profile.id)) throw new Error("提供商名称已存在，请换一个名称");
    if (apiKey !== undefined && (!apiKey.trim() || /[\r\n\x00-\x1f]/.test(apiKey))) throw new Error("请输入有效的 API Key");
    if (apiKey === undefined && !this.hasKey(profile.id)) throw new Error("请输入 API Key");
    const nextKeys = { ...this.keys, ...(apiKey !== undefined ? { [profile.id]: apiKey.trim() } : {}) };
    const next = [...this.profiles.filter(item => item.id !== profile.id), structuredClone(profile)];
    this.write("credentials.json", nextKeys);
    this.write("providers.json", { version: 1, providers: next });
    this.keys = nextKeys; this.profiles = next;
  }
  entries(): ModelEntry[] {
    return this.profiles.flatMap(profile => profile.models.map(model => ({
      model: `${officialModelName(profile, model.id) ?? model.id} · ${profile.name}`, modelId: model.id, adapterId: AGENT_ADAPTERS[model.agent],
      vendor: profile.name, sourceKind: profile.kind, providerId: profile.id, display: `${model.protocol} · ${new URL(profile.baseUrl).host}`,
      reasoningLevels: model.reasoningLevels
    })));
  }
  connection(entry: ModelEntry): ApiConnection | undefined {
    if (!entry.providerId) return undefined;
    const profile = this.profiles.find(item => item.id === entry.providerId);
    const model = profile?.models.find(item => item.id === entry.modelId);
    if (!profile || !model || !this.hasKey(profile.id)) throw new Error("提供商或 Key 不可用，请打开 /providers 检查配置");
    return { providerId: profile.id, name: profile.name, baseUrl: profile.baseUrl, protocol: model.protocol, apiKey: this.keys[profile.id] };
  }
  private write(name: string, value: unknown): void {
    const temp = join(this.dir, `.${name}.${randomUUID()}.tmp`);
    writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" });
    renameSync(temp, join(this.dir, name));
  }
}

// Version names and API IDs differ. Apply official metadata only to the verified official endpoint.
function officialModelName(profile: ProviderProfile, modelId: string): string | undefined {
  if (profile.kind === "official" && new URL(profile.baseUrl).hostname === "api.deepseek.com" && modelId === "deepseek-flash") return "DeepSeek V4.1 Flash";
  return undefined;
}
