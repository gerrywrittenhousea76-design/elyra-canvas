import bundled from './skills/catalog.json';

export interface SkillField { key: string; label: string; placeholder?: string; defaultValue?: string; required: boolean }
export interface SkillDefinition {
  schemaVersion: 1; id: string; version: string; name: string; description: string; category: string;
  cover: string; output: 'image' | 'video'; reference: 'none' | 'optional' | 'required';
  deliverable: string; fields: SkillField[]; instructions: string;
}
export type SkillValues = Record<string, string>;
const CUSTOM_KEY = 'elyra-custom-skills-v1';
const FAVORITES_KEY = 'elyra-skill-favorites-v1';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));

/** Declarative content only. Imports never become JavaScript, tools or API configuration. */
export function parseSkill(value: unknown): SkillDefinition {
  if (!object(value) || !keys(value, ['schemaVersion', 'id', 'version', 'name', 'description', 'category', 'cover', 'output', 'reference', 'deliverable', 'fields', 'instructions'])
    || value.schemaVersion !== 1 || !string(value.id, 60) || !/^[a-z][a-z0-9-]*$/.test(value.id as string)
    || !string(value.version, 24) || !/^\d+\.\d+\.\d+$/.test(value.version as string)
    || !string(value.name, 36) || !string(value.description, 100) || !string(value.category, 20)
    || !string(value.deliverable, 200) || !string(value.instructions, 6000)
    || !string(value.cover, 200) || !/^\/assets\/[a-zA-Z0-9/_-]+\.(png|webp|jpg|jpeg)$/.test(value.cover as string)
    || !['image', 'video'].includes(value.output as string) || !['none', 'optional', 'required'].includes(value.reference as string)
    || (value.output === 'video' && value.reference !== 'required')
    || !Array.isArray(value.fields) || value.fields.length < 1 || value.fields.length > 6) throw new Error('Skill 格式不正确，请参照示例文件；视频 Skill 必须要求参考图。');
  const names = new Set<string>();
  const fields = value.fields.map(field => {
    if (!object(field) || !keys(field, ['key', 'label', 'placeholder', 'defaultValue', 'required'])
      || !string(field.key, 30) || !/^[a-z][a-z0-9_]*$/.test(field.key as string)
      || ['constructor', 'prototype', '__proto__'].includes(field.key as string) || names.has(field.key as string)
      || !string(field.label, 50) || typeof field.required !== 'boolean'
      || (field.placeholder !== undefined && !string(field.placeholder, 200))
      || (field.defaultValue !== undefined && !string(field.defaultValue, 800))) throw new Error('Skill 表单字段无效、重复或超过长度限制。');
    names.add(field.key as string);
    return { ...field } as unknown as SkillField;
  });
  const placeholders = [...(value.instructions as string).matchAll(/\{\{([^{}]+)\}\}/g)].map(match => match[1]);
  if (placeholders.some(key => !names.has(key)) || fields.some(field => !placeholders.includes(field.key))
    || (value.instructions as string).replace(/\{\{[a-z][a-z0-9_]*\}\}/g, '').match(/[{}]/)) throw new Error('每个字段必须对应 instructions 中的 {{字段名}}，不能引用未声明字段。');
  return { ...value, fields } as unknown as SkillDefinition;
}

export const BUILTIN_SKILLS: readonly SkillDefinition[] = bundled.map(parseSkill);
export function parseSkillImport(text: string, existing: readonly SkillDefinition[] = BUILTIN_SKILLS): SkillDefinition[] {
  if (text.length > 100_000) throw new Error('文件过大，请保持在 100 KB 内。');
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error('文件不是有效的 JSON。'); }
  const result = (Array.isArray(data) ? data : [data]).map(parseSkill);
  if (!result.length || result.length > 20) throw new Error('一次可导入 1–20 个 Skill。');
  const ids = new Set(existing.map(skill => skill.id));
  for (const skill of result) { if (ids.has(skill.id)) throw new Error(`Skill ID「${skill.id}」已存在，请更换 ID。`); ids.add(skill.id); }
  if (existing.length + result.length > 54) throw new Error('自定义 Skill 最多保存 50 个。');
  return result;
}
export function compileSkill(skill: SkillDefinition, values: SkillValues, hasReference: boolean): string {
  const safe = parseSkill(skill);
  if (safe.reference === 'required' && !hasReference) throw new Error('请添加一张参考图后再使用。');
  if (safe.reference === 'none' && hasReference) throw new Error('这个 Skill 不接受参考图。');
  for (const field of safe.fields) {
    const value = values[field.key];
    if (typeof value !== 'string' || value.length > 800 || (field.required && !value.trim())) throw new Error(`请填写「${field.label}」，每项最多 800 字。`);
  }
  const prompt = safe.instructions.replace(/\{\{([a-z][a-z0-9_]*)\}\}/g, (_, key: string) => values[key].trim() || '未指定');
  const compiled = `Skill：${safe.name}（${safe.id} v${safe.version}）\n\n${prompt}`;
  // The existing Planner accepts at most 4000 characters including provenance.
  // Reject here, before a node or upload handoff is committed, not at the API.
  if (compiled.length > 4_000) throw new Error('Skill 与填写内容合计超过 4000 字，请精简需求或模板后重试。');
  return compiled;
}
export function loadCustomSkills(storage: Pick<Storage, 'getItem'>): { skills: SkillDefinition[]; error?: string } {
  try {
    const raw = storage.getItem(CUSTOM_KEY);
    if (!raw) return { skills: [] };
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data) || data.length > 50) throw new Error('invalid catalog');
    const skills = data.map(parseSkill);
    const ids = new Set(BUILTIN_SKILLS.map(skill => skill.id));
    for (const skill of skills) { if (ids.has(skill.id)) throw new Error('duplicate'); ids.add(skill.id); }
    return { skills };
  }
  catch { return { skills: [], error: '本机 Skill 配置暂时无法读取，原数据已保留。请检查后重试。' }; }
}
export function saveCustomSkills(skills: SkillDefinition[], storage: Pick<Storage, 'setItem'>) {
  if (skills.length > 50) throw new Error('最多保存 50 个自定义 Skill。');
  const ids = new Set(BUILTIN_SKILLS.map(skill => skill.id));
  for (const skill of skills) { parseSkill(skill); if (ids.has(skill.id)) throw new Error('Skill ID 重复。'); ids.add(skill.id); }
  storage.setItem(CUSTOM_KEY, JSON.stringify(skills));
}
export function readFavorites(storage: Pick<Storage, 'getItem'>): string[] {
  try { const value: unknown = JSON.parse(storage.getItem(FAVORITES_KEY) || '[]'); return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id.length <= 60).slice(0, 54) : []; } catch { return []; }
}
export function saveFavorites(ids: string[], storage: Pick<Storage, 'setItem'>) { storage.setItem(FAVORITES_KEY, JSON.stringify(ids)); }
