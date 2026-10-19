import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownTrayIcon, ArrowRightIcon, BookmarkIcon, CheckIcon, MagnifyingGlassIcon, PaperClipIcon, PhotoIcon, PlusIcon, SparklesIcon, TrashIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { BUILTIN_SKILLS, compileSkill, loadCustomSkills, parseSkillImport, readFavorites, saveCustomSkills, saveFavorites, type SkillDefinition, type SkillValues } from './skills';
import type { SkillLaunchDraft } from './skill-launch';
import type { FrontstageStagedReference } from './ProductFrontstage';
import type { WorkflowModel } from './workflow-graph';
import { useProviderLabels } from './ProviderSettings';
import './skill-gallery.css';

interface Props {
  projectTitle: string;
  onLaunch: (draft: SkillLaunchDraft) => Promise<void>;
  onStage?: (file: File) => Promise<FrontstageStagedReference>;
  onDiscard?: (reference: FrontstageStagedReference) => void | Promise<void>;
}

export default function SkillGallery(props: Props) {
  const [loaded] = useState(() => loadCustomSkills(window.localStorage));
  const [custom, setCustom] = useState(loaded.skills);
  const [notice, setNotice] = useState(loaded.error || '');
  const [favorites, setFavorites] = useState(() => readFavorites(window.localStorage));
  const [filter, setFilter] = useState('全部');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<SkillDefinition>();
  const [manager, setManager] = useState(false);
  const skills = useMemo(() => [...BUILTIN_SKILLS, ...custom], [custom]);
  const categories = ['全部', ...new Set(skills.map(skill => skill.category)), '已收藏'];
  const visible = skills.filter(skill => (filter === '全部' || filter === '已收藏' ? filter !== '已收藏' || favorites.includes(skill.id) : skill.category === filter)
    && `${skill.name} ${skill.description} ${skill.category}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const toggleFavorite = (id: string) => {
    const next = favorites.includes(id) ? favorites.filter(value => value !== id) : [...favorites, id];
    try { saveFavorites(next, window.localStorage); setFavorites(next); setNotice(''); } catch { setNotice('收藏保存失败，请检查浏览器存储空间。'); }
  };
  const importSkills = async (file?: File) => {
    if (!file) return;
    if (loaded.error) { setNotice('请先导出或修复本机损坏的 Skill 数据，导入没有覆盖原数据。'); return; }
    try {
      if (file.size > 100_000) throw new Error('文件过大，请保持在 100 KB 内。');
      const incoming = parseSkillImport(await file.text(), skills);
      const next = [...custom, ...incoming];
      saveCustomSkills(next, window.localStorage); setCustom(next); setFilter('全部'); setQuery('');
      setNotice(`已添加 ${incoming.length} 个 Skill，保存在此浏览器。`);
    } catch (error) { setNotice(error instanceof Error ? error.message : '导入失败，已有 Skill 保持不变。'); }
  };
  const removeCustom = (id: string) => {
    try { const next = custom.filter(skill => skill.id !== id); saveCustomSkills(next, window.localStorage); setCustom(next); setNotice('已移除本机 Skill，已创建的画布节点保留。'); }
    catch { setNotice('移除失败，请检查浏览器存储空间。'); }
  };
  return <section className="skill-gallery" id="skills" aria-labelledby="skills-title" data-testid="skill-gallery">
    <header className="skills-heading"><div><span className="skills-eyebrow"><SparklesIcon /> 灵感有了，接下来交给 Skill</span><h2 id="skills-title">让好作品，一键发生。</h2><p>选一个擅长的，让 Elyra 带着方法开始创作。</p></div><button type="button" className="skill-add" onClick={() => { setNotice(''); setManager(true); }}><PlusIcon />添加 Skill</button></header>
    <div className="skills-controls"><nav aria-label="Skill 分类">{categories.map(category => <button type="button" key={category} aria-pressed={filter === category} onClick={() => setFilter(category)}>{category === '已收藏' && <BookmarkIcon />}{category}</button>)}</nav><label className="skills-search"><MagnifyingGlassIcon /><input aria-label="搜索 Skill" placeholder="搜索你想做的…" value={query} maxLength={100} onChange={event => setQuery(event.target.value)} />{query && <button type="button" aria-label="清空搜索" onClick={() => setQuery('')}><XMarkIcon /></button>}</label></div>
    {!manager && notice && <p className="skills-notice" role="status">{notice}</p>}
    <div className="skills-grid">{visible.map(skill => <article className="skill-card" key={skill.id}>
      <button type="button" className="skill-card-open" onClick={() => setSelected(skill)} aria-label={`使用 ${skill.name}`}>
        <div className="skill-cover"><img src={skill.cover} alt={`${skill.name}效果示意`} loading="lazy" onError={event => { event.currentTarget.onerror = null; event.currentTarget.src = '/assets/skills/brand-poster.png'; }} /><span className="skill-media-kind"><PhotoIcon />{skill.output === 'video' ? '视频' : '图片'}</span><span className="skill-cover-hint">效果示意</span><span className="skill-hover-cta">使用 Skill <ArrowRightIcon /></span></div>
        <h3>{skill.name}<ArrowRightIcon /></h3><p>{skill.description}</p>
      </button>
      <footer><span className="skill-author"><img src="/assets/elyra-mark.svg" alt="" />{custom.some(value => value.id === skill.id) ? '我的 Skill' : 'Elyra 内置'}</span><span className="skill-category-label">{skill.category}</span><button type="button" className="skill-bookmark" aria-label={`${favorites.includes(skill.id) ? '取消收藏' : '收藏'} ${skill.name}`} aria-pressed={favorites.includes(skill.id)} onClick={() => toggleFavorite(skill.id)}><BookmarkIcon /></button></footer>
    </article>)}</div>
    {!visible.length && <div className="skills-empty"><MagnifyingGlassIcon /><h3>{filter === '已收藏' && !query ? '还没有收藏的 Skill' : '没有找到匹配的 Skill'}</h3><p>试试其他关键词，或回到全部 Skill 看看。</p><button type="button" onClick={() => { setQuery(''); setFilter('全部'); }}>查看全部</button></div>}
    <div className="skills-bottom"><span>一个好方法，可以反复用。</span><span>需求 → Skill → 画布作品</span></div>
    {selected && <SkillDialog key={selected.id} skill={selected} {...props} onClose={() => setSelected(undefined)} />}
    {manager && <SkillManager custom={custom} notice={notice} onImport={importSkills} onRemove={removeCustom} onClose={() => setManager(false)} />}
  </section>;
}

function SkillDialog({ skill, projectTitle, onLaunch, onStage, onDiscard, onClose }: Props & { skill: SkillDefinition; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [values, setValues] = useState<SkillValues>(() => Object.fromEntries(skill.fields.map(field => [field.key, field.defaultValue || ''])));
  const [model, setModel] = useState<WorkflowModel>(skill.output === 'video' ? 'evolink-sora-2-preview' : 'evolink-gpt-image-2');
  const [reference, setReference] = useState<FrontstageStagedReference>();
  const referenceRef = useRef<FrontstageStagedReference | undefined>(undefined);
  const [fileName, setFileName] = useState('');
  const [consent, setConsent] = useState(false);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const mounted = useRef(true);
  const owned = useRef(false);
  const [error, setError] = useState('');
  const labels = useProviderLabels();
  useEffect(() => {
    mounted.current = true; dialog.current?.showModal(); dialog.current?.querySelector('textarea')?.focus();
    const controller = new AbortController();
    void fetch('/api/agent/provider-settings', { signal: controller.signal }).then(response => response.ok ? response.json() : undefined).then(data => {
      if (data?.preview) { setPreview(true); if (skill.output === 'image') setModel('deterministic-mock'); }
    }).catch(() => {});
    return () => { mounted.current = false; controller.abort(); if (referenceRef.current && !owned.current) void onDiscard?.(referenceRef.current); };
  }, [onDiscard, skill.output]);
  const upload = async (file?: File) => {
    if (!file || !onStage || lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const next = await onStage(file);
      if (!mounted.current) { await onDiscard?.(next); return; }
      const previous = referenceRef.current;
      referenceRef.current = next; setReference(next); setFileName(file.name); setConsent(false);
      if (previous) await onDiscard?.(previous);
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : '图片上传失败，请重试。'); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const submit = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      compileSkill(skill, values, !!reference);
      if (preview && skill.output === 'video') throw new Error('演练模式不能生成视频，请配置并启用真实模型后使用。');
      if (reference && model !== 'deterministic-mock' && !consent) throw new Error('请确认参考图使用授权。');
      owned.current = true;
      await onLaunch({ skill, values, model, reference, transferConsent: consent });
      onClose();
    } catch (reason) { owned.current = false; if (mounted.current) setError(reason instanceof Error ? reason.message : '没有启动，请重试。'); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  return <dialog ref={dialog} className="skill-dialog" aria-labelledby="skill-dialog-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <button type="button" className="skill-dialog-close" aria-label="关闭 Skill" disabled={busy} onClick={onClose}><XMarkIcon /></button>
    <aside className="skill-detail-preview"><img src={skill.cover} alt={`${skill.name}效果示意`} /><span className="skill-detail-category">{skill.category} · v{skill.version}</span><h2 id="skill-dialog-title">{skill.name}</h2><p>{skill.description}</p><div className="skill-deliverable"><CheckIcon /><span>{skill.deliverable}</span></div><small>封面为效果示意，实际结果由你的需求与所选模型决定。</small></aside>
    <form className="skill-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <header><span>开始你的创作</span><h3>告诉 Elyra，你想做什么。</h3></header>
      <fieldset disabled={busy}>{skill.fields.map((field, index) => <label key={field.key} htmlFor={`skill-${field.key}`}>{field.label}{!field.required && <small>选填</small>}<textarea autoFocus={index === 0} id={`skill-${field.key}`} rows={index === 0 ? 3 : 2} required={field.required} maxLength={800} placeholder={field.placeholder} value={values[field.key]} onChange={event => { setValues(current => ({ ...current, [field.key]: event.target.value })); setError(''); }} /></label>)}
      {skill.reference !== 'none' && <div className="skill-reference"><input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" aria-label="上传 Skill 参考图" hidden onChange={event => { void upload(event.target.files?.[0]); event.target.value = ''; }} /><button type="button" disabled={!onStage} onClick={() => fileInput.current?.click()}><PaperClipIcon />{reference ? fileName : `添加参考图${skill.reference === 'required' ? '（必填）' : '（可选）'}`}</button>{reference && <button type="button" aria-label="移除 Skill 参考图" onClick={() => { const old = referenceRef.current; referenceRef.current = undefined; setReference(undefined); setFileName(''); setConsent(false); if (old) void Promise.resolve(onDiscard?.(old)).catch(() => setError('附件清理失败，请重试。')); }}><XMarkIcon /></button>}<small>JPG / PNG / WebP · 最大 10 MB</small></div>}
      <label htmlFor="skill-model">执行方式<select id="skill-model" value={model} onChange={event => { setModel(event.target.value as WorkflowModel); setConsent(false); }}>{skill.output === 'image' ? <><option value="evolink-gpt-image-2" disabled={preview}>{labels.image}</option><option value="deterministic-mock">本地流程演练 · 固定示例图</option></> : <option value="evolink-sora-2-preview">{labels.video} · 4 秒</option>}</select></label>
      {reference && model !== 'deterministic-mock' && <label className="skill-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} required />我有权使用此图，同意将参考图与需求发送给已配置的模型服务。</label>}
      </fieldset>
      <p className="skill-run-note">{model === 'deterministic-mock' ? '演练会返回固定示例图，用于体验流程。' : '点击后会调用已配置的模型，沿用现有费用上限。'}<br />添加至当前项目：{projectTitle}</p>
      {error && <p className="skill-error" role="alert">{error}</p>}
      <button type="submit" className="skill-launch" disabled={busy || (preview && skill.output === 'video')}>{busy ? '正在准备…' : model === 'deterministic-mock' ? '一键演练' : '使用 Skill'}<ArrowRightIcon /></button>
    </form>
  </dialog>;
}

function SkillManager({ custom, notice, onImport, onRemove, onClose }: { custom: SkillDefinition[]; notice: string; onImport: (file?: File) => Promise<void>; onRemove: (id: string) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="skill-manager" aria-labelledby="skill-manager-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}><header><div><span>把你的方法，变成 Skill</span><h2 id="skill-manager-title">添加一个实用 Skill</h2></div><button type="button" aria-label="关闭 Skill 管理" disabled={busy} onClick={onClose}><XMarkIcon /></button></header><p>下载示例，修改名称、表单与创作要求，再导入即可使用。这里添加的 Skill 只保存在此浏览器；要提供给所有客户，请加入项目的内置目录。</p><div className="skill-manager-actions"><a href="/skill-example.json" download="my-skill.json"><ArrowDownTrayIcon />下载示例</a><button type="button" disabled={busy} onClick={() => input.current?.click()}><PlusIcon />{busy ? '正在导入…' : '导入 Skill 文件'}</button><input ref={input} type="file" accept="application/json,.json" hidden aria-label="导入 Skill JSON" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; setBusy(true); void onImport(file).finally(() => setBusy(false)); }} /></div>{notice && <p className="skills-notice" role="status">{notice}</p>}<h3>本机添加 · {custom.length}</h3>{custom.length ? <ul>{custom.map(skill => <li key={skill.id}><span>{skill.name}<small>v{skill.version} · {skill.category}</small></span><button type="button" disabled={busy} aria-label={`移除 ${skill.name}`} onClick={() => onRemove(skill.id)}><TrashIcon /></button></li>)}</ul> : <p className="skill-manager-empty">还没有自定义 Skill。先从示例开始。</p>}<small>Skill 文件只包含创作要求，不执行代码，也不保存 API 密钥。</small></dialog>;
}
