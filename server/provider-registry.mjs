import { BUILTIN_PROTOCOLS, ProviderConfigError } from './provider-config.mjs';
import { createHash } from 'node:crypto';
import { createPlannerAdapter, createEvoMediaAdapter, createOpenAIImageAdapter } from './provider-adapters.mjs';

const builtins = {
  planner: Object.fromEntries(BUILTIN_PROTOCOLS.planner.map(protocol => [protocol, context => createPlannerAdapter(context, protocol)])),
  image: { evolink: context => createEvoMediaAdapter(context, 'image'), 'openai-images': createOpenAIImageAdapter },
  video: { evolink: context => createEvoMediaAdapter(context, 'video') },
};
export function createProviderRegistry({ plugins = {}, env = process.env, preview = false, fetchImpl = fetch } = {}) {
  const factories = {};
  for (const role of Object.keys(builtins)) {
    factories[role] = { ...builtins[role] };
    for (const [id, factory] of Object.entries(plugins[role] ?? {})) {
      if (!/^[a-z][a-z0-9-]{1,60}$/.test(id) || typeof factory !== 'function' || factories[role][id]) throw new TypeError('Provider plugin registration is invalid.');
      factories[role][id] = factory;
    }
  }
  return {
    protocols: Object.fromEntries(Object.entries(factories).map(([role, entries]) => [role, Object.keys(entries)])),
    create(role, settings) {
      const factory = factories[role]?.[settings.protocol];
      if (!factory) throw new ProviderConfigError('模型协议未注册。');
      const readKey = async () => {
        if (preview) throw new ProviderConfigError('当前是本地演练服务，真实 API 已关闭。', 503);
        if (!settings.enabled) throw new ProviderConfigError('该模型服务已停用。', 503);
        const key = settings.apiKey || (settings.keyEnv && env[settings.keyEnv]?.trim());
        if (!key) throw new ProviderConfigError('该模型服务尚未配置密钥，请打开 API 设置。', 503);
        return key;
      };
      const namespace = createHash('sha256').update(JSON.stringify([role, settings.protocol, settings.baseUrl, settings.filesBaseUrl, settings.model, settings.auth, settings.apiKey || env[settings.keyEnv] || ''])).digest('hex').slice(0, 20);
      const adapter = factory({ settings, readKey, namespace, fetchImpl: (...args) => { if (preview) throw new ProviderConfigError('演练模式不允许真实 API 请求。', 503); return fetchImpl(...args); } });
      if (role === 'planner' ? typeof adapter?.createClient !== 'function' : !adapter?.client || typeof adapter.resolveResult !== 'function') throw new TypeError('Provider adapter contract is invalid.');
      return { ...adapter, ensureConfigured: readKey };
    },
  };
}
