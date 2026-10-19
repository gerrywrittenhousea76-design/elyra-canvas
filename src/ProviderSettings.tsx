import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './provider-settings.css';

type Role = 'planner' | 'image' | 'video';
type Profile = { enabled: boolean; protocol: string; label: string; baseUrl: string; filesBaseUrl: string; model: string; auth: string; keyEnv: string; reservationUsd: number; resultHosts: string[]; hasKey: boolean; apiKey?: string; clearKey?: boolean };
type Settings = { version: number; revision: number; roles: Record<Role, Profile>; active: Record<Role, Profile>; preview: boolean; restartRequired: boolean; protocols: Record<Role, string[]> };
const roles: Role[] = ['planner', 'image', 'video'];
const names = { planner: 'Agent 规划', image: '图片生成与编辑', video: '视频生成' };
const protocolNames: Record<string, string> = { 'anthropic-messages': 'Anthropic Messages 兼容', 'openai-chat': 'OpenAI Chat Completions 兼容', evolink: 'EvoLink 异步任务兼容', 'openai-images': 'OpenAI Images 兼容' };
const fallback = { planner: '当前规划服务', image: '当前图片服务', video: '当前视频服务' };
export function useProviderLabels() {
  const [labels, setLabels] = useState(fallback);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/agent/provider-settings', { signal: controller.signal, cache: 'no-store' }).then(response => response.ok ? response.json() as Promise<Settings> : Promise.reject()).then(data => {
      setLabels(Object.fromEntries(roles.map(role => [role, `${data.active[role].label} · ${data.active[role].model}${data.active[role].enabled ? '' : '（已停用）'}`])) as typeof fallback);
    }).catch(() => {});
    return () => controller.abort();
  }, []);
  return labels;
}

export function ProviderSettings() {
  const [open, setOpen] = useState(false);
  return <><button type="button" className="api-settings-trigger" onClick={() => setOpen(true)} title="配置规划、图片和视频服务">API 设置</button>{open && <SettingsDialog onClose={() => setOpen(false)} />}</>;
}

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<Settings>();
  const [selected, setSelected] = useState<Role>('planner');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    const controller = new AbortController();
    void fetch('/api/agent/provider-settings', { signal: controller.signal, cache: 'no-store' }).then(async response => { if (!response.ok) throw new Error('无法读取 API 设置，请确认本机服务已经启动。'); return response.json() as Promise<Settings>; }).then(setData).catch(reason => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, []);
  const update = (patch: Partial<Profile>, connectionChanged = false) => setData(previous => previous ? { ...previous, roles: { ...previous.roles, [selected]: { ...previous.roles[selected], ...(connectionChanged ? { apiKey: '', keyEnv: '', hasKey: false, clearKey: true } : {}), ...patch } } } : previous);
  const profile = data?.roles[selected];
  const save = async () => {
    if (!data) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/agent/provider-settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1, revision: data.revision, roles: data.roles }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message || '保存失败，原配置未改变。');
      setData(result as Settings);
      setNotice('已保存。重启本机服务后生效；当前任务继续使用启动时的配置。');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败。'); }
    finally { setBusy(false); }
  };
  return createPortal(<dialog ref={dialog} className="provider-settings-dialog" aria-labelledby="api-settings-heading" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <header><div><h2 id="api-settings-heading">API 设置</h2><p>分别替换 Agent、图片和视频服务。</p></div><button type="button" onClick={onClose} disabled={busy} aria-label="关闭 API 设置">关闭</button></header>
      {data?.preview && <p className="api-notice">当前为本地演练模式，真实模型调用已关闭。配置会保存，使用正常启动方式后生效。</p>}
      {data?.restartRequired && <p className="api-notice">有待生效的配置，需要重启本机服务。</p>}
      {data && profile && <>
        <nav aria-label="API 服务类型">{roles.map(role => <button type="button" key={role} aria-pressed={role === selected} onClick={() => setSelected(role)} disabled={busy}>{names[role]}</button>)}</nav>
        <p className="api-active">当前生效：{data.active[selected].label} / {data.active[selected].model}</p>
        <fieldset disabled={busy}>
          <label className="api-enabled"><input type="checkbox" checked={profile.enabled} onChange={event => update({ enabled: event.target.checked })} />启用此服务</label>
          <label>接口协议<select value={profile.protocol} onChange={event => update({ protocol: event.target.value }, true)}>{data.protocols[selected].map(protocol => <option key={protocol} value={protocol}>{protocolNames[protocol] || protocol}</option>)}</select></label>
          <div className="api-row"><label>显示名称<input required maxLength={80} value={profile.label} onChange={event => update({ label: event.target.value })} /></label><label>模型名称<input required maxLength={160} spellCheck={false} value={profile.model} onChange={event => update({ model: event.target.value })} /></label></div>
          <label>API 基础地址<input type="url" required spellCheck={false} placeholder="https://api.example.com/v1" value={profile.baseUrl} onChange={event => update({ baseUrl: event.target.value }, true)} /></label>
          <small>填写到版本路径，如 /v1。更换地址或协议会清除原密钥，需要重新填写。</small>
          <label>API Key<input type="password" autoComplete="new-password" spellCheck={false} maxLength={2048} value={profile.apiKey || ''} placeholder={profile.hasKey ? '已配置；留空保留当前密钥' : '填写此服务的密钥'} onChange={event => update({ apiKey: event.target.value, clearKey: false })} /></label>
          {profile.hasKey && <button type="button" className="api-clear" onClick={() => update({ apiKey: '', keyEnv: '', hasKey: false, clearKey: true })}>清除已保存的密钥</button>}
          <small>密钥仅保存在本机服务端文件，不存入浏览器或工程导出。保存只校验配置，不会发起付费生成。</small>
          {profile.protocol === 'openai-images' && <p className="api-hint">适用于支持 /images/generations 与 /images/edits 的服务。比例会匹配为方形、横向或竖向尺寸，模型需支持 quality 和图片编辑。</p>}
          {selected === 'video' && <p className="api-hint">当前视频节点为单图生成 4 秒 MP4。选择的模型需支持此能力；不同协议可通过服务端适配器接入。</p>}
          <details><summary>高级设置</summary>
            <label>认证方式<select value={profile.auth} onChange={event => update({ auth: event.target.value }, true)}><option value="bearer">Bearer Token</option><option value="x-api-key">x-api-key</option></select></label>
            <label>密钥环境变量（可选）<input value={profile.keyEnv} placeholder="MY_SERVICE_API_KEY" spellCheck={false} onChange={event => update({ keyEnv: event.target.value })} /></label>
            <small>可用环境变量代替文件密钥；文件中已填的密钥优先。地址变化后需要重新指定。</small>
            {profile.protocol === 'evolink' && <label>参考图上传基础地址<input type="url" required value={profile.filesBaseUrl} onChange={event => update({ filesBaseUrl: event.target.value }, true)} /></label>}
            <label>每次调用预算占用（美元）<input type="number" min="0.001" max="5" step="0.001" required value={profile.reservationUsd} onChange={event => update({ reservationUsd: Number(event.target.value) })} /></label>
            <small>这是本地预算记录，不是供应商实时报价或账单。总额度仍为 5 美元，请按供应商价格设置足够的单次额度。</small>
            {selected === 'video' && <label>允许下载视频结果的域名<input value={profile.resultHosts.join(', ')} onChange={event => update({ resultHosts: event.target.value.split(',').map(value => value.trim()).filter(Boolean) })} /><small>多个域名用逗号分隔；仅允许 HTTPS。</small></label>}
          </details>
        </fieldset>
      </>}
      {!data && !error && <p>正在读取配置…</p>}
      {error && <p role="alert" className="api-error">{error}</p>}
      {notice && <p role="status" className="api-notice">{notice}</p>}
      <footer><button type="button" onClick={onClose} disabled={busy}>取消</button><button type="submit" disabled={busy || !data}>{busy ? '正在保存…' : '保存配置'}</button></footer>
    </form>
  </dialog>, document.body);
}
