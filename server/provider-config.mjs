import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const PROVIDER_ROLES = ['planner', 'image', 'video'];
export const BUILTIN_PROTOCOLS = {
  planner: ['anthropic-messages', 'openai-chat'],
  image: ['evolink', 'openai-images'],
  video: ['evolink'],
};
export class ProviderConfigError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; this.code = 'PROVIDER_CONFIG_INVALID'; }
}
export const defaultProviderConfig = (env = process.env) => ({
  version: 1, revision: 0,
  roles: Object.fromEntries(PROVIDER_ROLES.map(role => {
    const prefix = `ELYRA_${role.toUpperCase()}_`;
    return [role, {
      enabled: true,
      protocol: env[`${prefix}PROTOCOL`] || (role === 'planner' ? 'anthropic-messages' : 'evolink'),
      label: env[`${prefix}LABEL`] || (role === 'planner' ? 'EvoLink Planner' : role === 'image' ? 'EvoLink 图片' : 'EvoLink 视频'),
      baseUrl: env[`${prefix}BASE_URL`] || (role === 'planner' ? 'https://direct.evolink.ai/v1' : 'https://api.evolink.ai/v1'),
      filesBaseUrl: env[`${prefix}FILES_BASE_URL`] || 'https://files-api.evolink.ai/api/v1',
      model: env[`${prefix}MODEL`] || (role === 'planner' ? 'claude-haiku-4-5-20251001' : role === 'image' ? 'gpt-image-2' : 'sora-2-preview'),
      auth: env[`${prefix}AUTH`] || 'bearer',
      keyEnv: env[`${prefix}KEY_ENV`] || 'EVOLINK_API_KEY',
      reservationUsd: Number(env[`${prefix}RESERVATION_USD`] || (role === 'planner' ? .05 : 1)),
      resultHosts: (env[`${prefix}RESULT_HOSTS`] || 'files.evolink.ai').split(',').map(value => value.trim()),
    }];
  })),
});

const text = (value, max, name) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new ProviderConfigError(`${name} 无效。`);
  return value.trim();
};
export const validateProviderBaseUrl = value => {
  let url;
  try { url = new URL(text(value, 500, 'API 地址')); } catch { throw new ProviderConfigError('请填写完整 API 地址。'); }
  if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)
    || (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new ProviderConfigError('远程 API 必须使用 HTTPS；本机服务可用 HTTP，地址中不能含密钥或查询参数。');
  return url.toString().replace(/\/+$/, '');
};
export const validateProviderConfig = (value, protocols = BUILTIN_PROTOCOLS) => {
  if (!value || value.version !== 1 || !Number.isInteger(value.revision) || value.revision < 0 || !value.roles
    || Object.keys(value.roles).sort().join('|') !== [...PROVIDER_ROLES].sort().join('|')) throw new ProviderConfigError('API 配置结构无效，旧配置未改变。');
  const roles = {};
  for (const role of PROVIDER_ROLES) {
    const input = value.roles[role];
    if (!input || !protocols[role]?.includes(input.protocol) || typeof input.enabled !== 'boolean') throw new ProviderConfigError(`${role} 的协议未注册。`);
    if (!['bearer', 'x-api-key'].includes(input.auth)) throw new ProviderConfigError('认证方式无效。');
    const keyEnv = typeof input.keyEnv === 'string' ? input.keyEnv.trim() : '';
    if (keyEnv && !/^[A-Z][A-Z0-9_]{0,80}_API_KEY$/.test(keyEnv)) throw new ProviderConfigError('密钥环境变量应使用大写字母、数字和下划线，并以 _API_KEY 结尾。');
    if (!Number.isFinite(input.reservationUsd) || input.reservationUsd <= 0 || input.reservationUsd > 5) throw new ProviderConfigError('单次预算占用必须大于 0 且不超过当前 5 美元总上限。');
    if (!Array.isArray(input.resultHosts) || input.resultHosts.length > 8 || input.resultHosts.some(host => typeof host !== 'string' || !/^[a-z0-9.-]+$/i.test(host))) throw new ProviderConfigError('视频结果域名无效。');
    roles[role] = {
      enabled: input.enabled, protocol: input.protocol, label: text(input.label, 80, '显示名称'),
      baseUrl: validateProviderBaseUrl(input.baseUrl), filesBaseUrl: validateProviderBaseUrl(input.filesBaseUrl),
      model: text(input.model, 160, '模型名称'), auth: input.auth, keyEnv,
      reservationUsd: input.reservationUsd, resultHosts: [...new Set(input.resultHosts.map(host => host.toLowerCase()))],
      ...(input.apiKey ? { apiKey: text(input.apiKey, 2048, 'API Key') } : {}),
    };
  }
  return { version: 1, revision: value.revision, roles };
};

/** This file is server-only, excluded from Git and all frontend file serving.
 * A connection destination change deliberately drops the old stored secret. */
export const createProviderSettingsStore = ({ path, env = process.env, protocols = BUILTIN_PROTOCOLS, preview = false }) => {
  const load = () => {
    try { return validateProviderConfig(JSON.parse(readFileSync(path, 'utf8')), protocols); }
    catch (error) {
      if (error.code === 'ENOENT') return validateProviderConfig(defaultProviderConfig(env), protocols);
      throw new ProviderConfigError('无法读取 API 配置，请保留原文件并检查配置格式。', 503);
    }
  };
  const active = load(); // Immutable for this process; old tasks retain their adapter.
  const publicRole = role => {
    const { apiKey, ...rest } = role;
    return { ...rest, hasKey: Boolean(apiKey || (role.keyEnv && env[role.keyEnv]?.trim())) };
  };
  const publicConfig = config => ({ ...config, roles: Object.fromEntries(PROVIDER_ROLES.map(role => [role, publicRole(config.roles[role])])) });
  const readPublic = () => { const saved = load(); return { ...publicConfig(saved), active: publicConfig(active).roles, restartRequired: saved.revision !== active.revision, preview, protocols }; };
  return {
    active, readPublic,
    async save(input) {
      const saved = load();
      if (input?.revision !== saved.revision) throw new ProviderConfigError('配置已被其他窗口更新，请关闭后重新打开。', 409);
      const roles = {};
      for (const name of PROVIDER_ROLES) {
        const candidate = input.roles?.[name];
        if (!candidate) throw new ProviderConfigError('缺少服务配置。');
        const old = saved.roles[name];
        const sameDestination = candidate.protocol === old.protocol && candidate.baseUrl?.replace(/\/+$/, '') === old.baseUrl && candidate.filesBaseUrl?.replace(/\/+$/, '') === old.filesBaseUrl && candidate.auth === old.auth && candidate.keyEnv === old.keyEnv;
        roles[name] = { ...candidate, keyEnv: !sameDestination && candidate.keyEnv === old.keyEnv ? '' : candidate.keyEnv, apiKey: candidate.clearKey ? undefined : candidate.apiKey || (sameDestination ? old.apiKey : undefined) };
      }
      const next = validateProviderConfig({ version: 1, revision: saved.revision + 1, roles }, protocols);
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
        renameSync(temporary, path);
      } catch {
        try { unlinkSync(temporary); } catch { /* no temporary file */ }
        throw new ProviderConfigError('API 配置未能写入本机，原配置保持不变。', 503);
      }
      return readPublic();
    },
  };
};
